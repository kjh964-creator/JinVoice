"""Lyrics for "song from a story": prompt building, the local LLM run and
parsing of its answer into a title + tagged, singable lyrics.

The writer is a local GGUF instruct model (see ``story_song_assets``) served
for the length of one request by a short-lived ``llama-server`` subprocess on
a free loopback port: start → ``/health`` → one ``/v1/chat/completions`` →
kill. Nothing stays loaded afterwards, so the VRAM is free again for the
song model and for speech generation. The app's configurable LLM providers
(``services.llm_backend``) are cloud/Ollama clients the user would have to
set up; this feature must work offline out of the box.

The system prompt lives in ``backend/config/story_song_lyrics_prompt.txt``.
It is English on purpose: the lyrics language is named in the request
(detected from the story), which keeps the source free of UI-language text.
"""
from __future__ import annotations

import math
import re
import unicodedata
from pathlib import Path

PROMPT_FILE = Path(__file__).resolve().parents[1] / "config" / "story_song_lyrics_prompt.txt"
#: Optional per-language craft notes + a format example, written in that
#: language (``story_song_lyrics_<code>.txt``): a 4B model follows "address
#: the person as you, keep line lengths even, a 4-line chorus with a hook"
#: far better when the advice and the example are in the lyrics language.
HINTS_DIR = PROMPT_FILE.parent

MAX_STORY_CHARS = 2000
MAX_LYRICS_CHARS = 3000

#: Genre id → (words for the lyric writer, ACE-Step style caption).
GENRES: dict[str, tuple[str, str]] = {
    # Also the mood for confessions and thank-you songs: the caption asks for
    # a tender, clearly sung lead over a soft, polished arrangement.
    "ballad": ("a heartfelt ballad",
               "emotional ballad, sincere heartfelt confession, tender and emotional singing, "
               "warm clear voice, soft grand piano, gentle strings, slow tempo, intimate, "
               "polished studio production"),
    "trot": ("a cheerful trot song with a catchy, repeating hook",
             "Korean trot, upbeat two-step rhythm, brass and accordion, catchy vibrato vocal"),
    "kids": ("a children's song with simple, happy words",
             "cheerful children's song, simple melody, bright piano and xylophone, clear friendly vocal"),
    "dance": ("an upbeat dance pop song",
              "upbeat dance pop, energetic synths and punchy drums, catchy vocal, 120 bpm"),
    "acoustic": ("a calm acoustic folk song",
                 "acoustic folk, fingerpicked acoustic guitar, gentle warm vocal, relaxed tempo"),
}

#: Length id → (seconds, section plan for the lyric writer).
LENGTHS: dict[str, tuple[int, tuple[str, ...]]] = {
    "1": (60, ("verse", "chorus")),
    "2": (120, ("verse", "chorus", "verse", "chorus")),
    "3": (180, ("verse", "chorus", "verse", "chorus", "bridge", "chorus")),
}

_TAG_ALIASES = {
    "verse": "verse", "chorus": "chorus", "bridge": "bridge", "intro": "intro",
    "outro": "outro", "pre-chorus": "pre-chorus", "prechorus": "pre-chorus",
    "hook": "chorus", "refrain": "chorus", "pre chorus": "pre-chorus",
}
_TAG_RE = re.compile(r"^\s*[\[(\u3010]?\s*([A-Za-z][A-Za-z \-]*?)\s*\d*\s*[\])\u3011]?\s*:?\s*$")
_THINK_RE = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.DOTALL | re.IGNORECASE)


def _count(text: str, lo: int, hi: int) -> int:
    return sum(1 for ch in text if lo <= ord(ch) <= hi)


def detect_language(text: str) -> tuple[str, str | None]:
    """(language name for the prompt, ACE-Step language code or None)."""
    hangul = _count(text, 0xAC00, 0xD7A3) + _count(text, 0x1100, 0x11FF) + _count(text, 0x3130, 0x318F)
    kana = _count(text, 0x3040, 0x30FF)
    han = _count(text, 0x4E00, 0x9FFF)
    latin = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    if hangul and hangul >= kana and hangul * 2 >= han:
        return "Korean", "ko"
    if kana:
        return "Japanese", "ja"
    if han:
        return "Chinese", "zh"
    if latin:
        return "the same language as the story", None
    return "the same language as the story", None


def clean_story(text: str) -> str:
    text = unicodedata.normalize("NFC", str(text or "")).replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(ch for ch in text if ch == "\n" or ch == "\t" or unicodedata.category(ch)[0] != "C")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def system_prompt() -> str:
    return PROMPT_FILE.read_text(encoding="utf-8").strip()


def language_hints(code: str | None) -> str:
    if not code or not re.fullmatch(r"[a-z]{2}", code):
        return ""
    path = HINTS_DIR / f"story_song_lyrics_{code}.txt"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def user_prompt(story: str, genre: str, length: str) -> str:
    language, code = detect_language(story)
    hints = language_hints(code)
    genre_words = GENRES[genre][0]
    seconds, plan = LENGTHS[length]
    sections = " ".join(f"[{s}]" for s in plan)
    minutes = "about 1 minute" if seconds <= 60 else f"about {seconds // 60} minutes"
    short = ("\nThe song is short: keep every line to 6 to 10 syllables." if seconds <= 60 else "")
    return (
        f"Lyrics language: {language}\n"
        f"Genre: {genre_words}\n"
        f"Song length: {minutes}. Sections in this order: {sections}{short}\n\n"
        + (f"Notes for {language} lyrics:\n{hints}\n\n" if hints else "")
        + f"Story:\n{story}"
    )


def _tag_of(line: str) -> str | None:
    match = _TAG_RE.match(line)
    if not match:
        return None
    word = match.group(1).strip().lower()
    word = re.sub(r"\s+\d+$", "", word)
    return _TAG_ALIASES.get(word)


def _strip_line(line: str) -> str:
    line = line.strip().strip("*_#>`").strip()
    line = re.sub(r"^[-\u2022\u00b7]\s+", "", line)
    line = line.strip("\"'\u201c\u201d\u2018\u2019\u300c\u300d")
    return re.sub(r"\s{2,}", " ", line).strip()


def parse_lyrics(raw: str) -> dict:
    """Split the model answer into ``{"title", "lyrics"}``.

    Lyrics come back with lowercase section tags on their own lines, one blank
    line between sections, no empty sections; text before the first tag is
    the title (any ``Title:``-style prefix removed, in whatever language).
    """
    text = _THINK_RE.sub("", str(raw or ""))
    text = text.replace("\r\n", "\n").replace("```", "")
    title = ""
    sections: list[tuple[str, list[str]]] = []
    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        tag = _tag_of(line) or _tag_of(line.strip("*_#> `"))
        if tag:
            sections.append((tag, []))
            continue
        cleaned = _strip_line(line)
        if not cleaned:
            continue
        if not sections:
            if not title:
                head, sep, rest = cleaned.partition(":")
                if sep and len(head) <= 12 and rest.strip():
                    cleaned = rest.strip()
                title = _strip_line(cleaned)[:80]
            else:
                sections.append(("verse", [cleaned]))
            continue
        sections[-1][1].append(cleaned)
    blocks = [f"[{tag}]\n" + "\n".join(lines) for tag, lines in sections if lines]
    lyrics = "\n\n".join(blocks)[:MAX_LYRICS_CHARS].strip()
    return {"title": title, "lyrics": lyrics}


def normalize_user_lyrics(text: str) -> str:
    """Lyrics the user edited: same tag normalisation, untagged text becomes one verse."""
    text = clean_story(text)[:MAX_LYRICS_CHARS]
    parsed = parse_lyrics("TITLE: x\n" + text)
    return parsed["lyrics"]


def lyric_line_count(lyrics: str) -> int:
    return sum(1 for line in lyrics.splitlines() if line.strip() and not line.strip().startswith("["))


def sung_units(lyrics: str) -> int:
    """Rough count of sung syllables: one per CJK character, ~1.4 per Latin word."""
    units = 0.0
    for line in lyrics.splitlines():
        line = line.strip()
        if not line or line.startswith("["):
            continue
        units += sum(1 for ch in line if 0xAC00 <= ord(ch) <= 0xD7A3 or 0x3040 <= ord(ch) <= 0x30FF
                     or 0x4E00 <= ord(ch) <= 0x9FFF)
        units += 1.4 * len(re.findall(r"[A-Za-z\u00c0-\u024f\u0400-\u04ff]+", line))
    return int(round(units))


def song_seconds(lyrics: str, length: str) -> int:
    """Length to ask the song model for: the chosen length, stretched (up to
    1.5x) when the lyrics would not fit — an intro of ~15 s plus ~1.9 sung
    syllables per second, measured on Korean ballads. Without this the model
    simply stops singing when the time runs out."""
    chosen = LENGTHS[length][0]
    needed = 15 + sung_units(lyrics) / 1.9
    seconds = min(max(chosen, needed), chosen * 1.5)
    return int(math.ceil(seconds / 5.0) * 5)


def _sections(lyrics: str) -> list[tuple[str, list[str]]]:
    out: list[tuple[str, list[str]]] = []
    for line in lyrics.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("["):
            out.append((line.strip("[]").lower(), []))
        elif out:
            out[-1][1].append(line)
    return out


def lyrics_score(lyrics: str, length: str) -> float:
    """How singable and complete a lyric draft is (higher is better); used
    to keep the best of a few drafts from the small local writer.

    Rewards the requested section plan with full 4-line verses/choruses;
    penalises a chorus that repeats one line (a hook needs lines around
    it), uneven line lengths inside a section (hard to set to one melody),
    very short/long lines, digits, and more words than the length holds."""
    plan = LENGTHS[length][1]
    sections = _sections(lyrics)
    if not sections:
        return -100.0
    score = 0.0
    tags = [tag for tag, _ in sections]
    score += 3.0 if tags == list(plan) else -1.5 * abs(len(tags) - len(plan)) - 1.0
    for tag, lines in sections:
        want = (2, 4) if tag == "bridge" else (4, 4)
        score += 1.0 if want[0] <= len(lines) <= want[1] else -1.0 * min(abs(len(lines) - want[0]),
                                                                        abs(len(lines) - want[1]))
        if not lines:
            continue
        distinct = len({re.sub(r"\W+", "", line) for line in lines}) / len(lines)
        score -= 4.0 * (1.0 - distinct)
        units = [max(1, sung_units(line)) for line in lines]
        mean = sum(units) / len(units)
        spread = (sum((u - mean) ** 2 for u in units) / len(units)) ** 0.5 / mean
        score -= 4.0 * spread
        score -= 0.5 * sum(1 for u in units if u < 4 or u > 14)
        score -= 1.0 * sum(1 for line in lines if re.search(r"\d", line))
    seconds = LENGTHS[length][0]
    room = (seconds * 1.5 - 15) * 1.9
    score -= 0.05 * max(0, sung_units(lyrics) - room)
    return round(score, 3)
