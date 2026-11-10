"""Song-cover worker: sing an isolated vocal track in another voice (Seed-VC).

Usage: ``python worker.py <spec.json>``. The spec names the input vocal track,
the target voice's reference clip, the output path and every model file (all
already on disk; this process never downloads). Progress goes to stderr as
``JV_STAGE <name>`` / ``JV_PROGRESS <0-100>`` lines, the result JSON (applied
pitch shift, timing) to ``spec["result"]``.

The conversion is Seed-VC's f0-conditioned 44.1 kHz singing model, following
the upstream ``inference.py`` f0 path (Plachtaa/seed-vc, GPL-3.0): Whisper
encoder content features + RMVPE pitch of the SOURCE keep the words and the
melody, CAM++ style + the reference mel give the target timbre, a DiT flow
matcher renders mel frames and BigVGAN turns them into audio. Long tracks are
rendered in windows with a crossfade, exactly like upstream.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))

#: Seconds of the reference clip used as the voice prompt. The prompt shares
#: the model's 30 s context window with the song, so a shorter prompt leaves
#: longer song windows (fewer seams, faster). Upstream caps it at 25 s.
REF_MAX_S = 12.0
SR = 44100
HOP = 512
OVERLAP_FRAMES = 16


def say(kind: str, value) -> None:
    print(f"JV_{kind} {value}", file=sys.stderr, flush=True)


def _mono(path: str, sr: int):
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio

    data, rate = sf.read(path, dtype="float32", always_2d=True)
    wave = torch.from_numpy(np.ascontiguousarray(data.mean(axis=1)))
    if rate != sr:
        wave = torchaudio.functional.resample(wave, rate, sr)
    return wave


def _trim_silence(wave, sr: int, *, top_db: float = 40.0):
    """Drop leading/trailing near-silence of a speaking reference clip."""
    import torch

    frame = max(1, int(sr * 0.02))
    if wave.numel() < frame * 4:
        return wave
    frames = wave[: wave.numel() // frame * frame].reshape(-1, frame)
    rms = frames.pow(2).mean(dim=1).sqrt() + 1e-9
    db = 20 * torch.log10(rms / rms.max())
    voiced = torch.nonzero(db > -top_db).flatten()
    if not voiced.numel():
        return wave
    start = int(voiced[0]) * frame
    end = min(wave.numel(), (int(voiced[-1]) + 1) * frame)
    return wave[start:end]


def _median_hz(f0):
    import torch

    voiced = f0[f0 > 1]
    if not voiced.numel():
        return None
    return float(torch.exp(torch.median(torch.log(voiced))))


def auto_semitones(source_hz, ref_hz) -> int:
    """Whole-octave shift that brings the song's melody nearest the voice's
    own range (0, +12 or -12). Octaves keep the song in its key."""
    if not source_hz or not ref_hz:
        return 0
    diff = 12 * math.log2(ref_hz / source_hz)
    return int(max(-12, min(12, 12 * round(diff / 12))))


def crossfade(chunk1, chunk2, overlap: int):
    import numpy as np

    fade_out = np.cos(np.linspace(0, np.pi / 2, overlap)) ** 2
    fade_in = np.cos(np.linspace(np.pi / 2, 0, overlap)) ** 2
    if len(chunk2) < overlap:
        chunk2[:overlap] = chunk2[:overlap] * fade_in[: len(chunk2)] + (chunk1[-overlap:] * fade_out)[: len(chunk2)]
    else:
        chunk2[:overlap] = chunk2[:overlap] * fade_in + chunk1[-overlap:] * fade_out
    return chunk2


def main(spec_path: str) -> int:
    with open(spec_path, encoding="utf-8") as fh:
        spec = json.load(fh)

    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio
    import yaml

    # transformers probes optional packages (librosa) once and caches the
    # answer, so its audio modules are imported BEFORE the shims exist: it
    # must keep seeing "no librosa" and never reach for librosa's extras.
    import transformers.audio_utils  # noqa: F401
    from transformers import AutoFeatureExtractor, WhisperModel

    sys.path.insert(0, _HERE)
    from compat import install_shims  # type: ignore[import-not-found]

    shims = install_shims()
    sys.path.insert(0, spec["source_dir"])

    # The pinned checkpoints are pickled training dicts (net/optimizer/...),
    # which torch>=2.6's weights_only default refuses. Every file loaded here
    # comes from a reviewed, revision-pinned Hub snapshot.
    _torch_load = torch.load

    def _load(*args, **kwargs):
        kwargs.setdefault("weights_only", False)
        return _torch_load(*args, **kwargs)

    torch.load = _load

    started = time.time()
    device = torch.device(spec.get("device") or ("cuda" if torch.cuda.is_available() else "cpu"))
    fp16 = device.type == "cuda"
    say("STAGE", "loading")
    if shims:
        print("compat shims: " + ",".join(shims), file=sys.stderr, flush=True)

    from modules.commons import build_model, load_checkpoint, recursive_munch  # type: ignore
    from modules.audio import mel_spectrogram  # type: ignore
    from modules.campplus.DTDNN import CAMPPlus  # type: ignore
    from modules.bigvgan import bigvgan  # type: ignore
    from modules.rmvpe import RMVPE  # type: ignore

    with open(spec["config_path"], encoding="utf-8") as fh:
        config = yaml.safe_load(fh)
    campplus = CAMPPlus(feat_dim=80, embedding_size=192)
    campplus.load_state_dict(torch.load(spec["campplus_path"], map_location="cpu"))
    campplus.eval().to(device)

    rmvpe = RMVPE(spec["rmvpe_path"], is_half=False, device=device)

    whisper = WhisperModel.from_pretrained(
        spec["whisper_dir"], dtype=torch.float16 if fp16 else torch.float32,
    ).to(device)
    del whisper.decoder
    feature_extractor = AutoFeatureExtractor.from_pretrained(spec["whisper_dir"])

    def semantic(waves_16k):
        inputs = feature_extractor(
            [waves_16k.squeeze(0).cpu().numpy()], return_tensors="pt",
            return_attention_mask=True, sampling_rate=16000,
        )
        features = whisper._mask_input_features(
            inputs.input_features, attention_mask=inputs.attention_mask,
        ).to(device)
        out = whisper.encoder(features.to(whisper.encoder.dtype), return_dict=True)
        hidden = out.last_hidden_state.to(torch.float32)
        return hidden[:, : waves_16k.size(-1) // 320 + 1]

    spect = config["preprocess_params"]["spect_params"]
    mel_args = {
        "n_fft": spect["n_fft"], "win_size": spect["win_length"], "hop_size": spect["hop_length"],
        "num_mels": spect["n_mels"], "sampling_rate": SR, "fmin": spect.get("fmin", 0),
        "fmax": None if spect.get("fmax", "None") == "None" else 8000, "center": False,
    }

    def to_mel(x):
        return mel_spectrogram(x, **mel_args)

    def load_renderer():
        model_params = recursive_munch(config["model_params"])
        model_params.dit_type = "DiT"
        model = build_model(model_params, stage="DiT")
        model, _, _, _ = load_checkpoint(
            model, None, spec["dit_path"], load_only_params=True, ignore_modules=[], is_distributed=False,
        )
        for key in model:
            model[key].eval()
            model[key].to(device)
        # Upstream sizes these for 8192 frames; one window here is at most
        # 30 s (2583 frames), so 4096 halves that memory.
        model.cfm.estimator.setup_caches(max_batch_size=1, max_seq_length=4096)

        # Built directly rather than through from_pretrained(): huggingface_hub 1.x
        # no longer passes the proxies/resume_download arguments upstream's
        # _from_pretrained() requires. Same steps for a local directory.
        hparams = bigvgan.load_hparams_from_json(os.path.join(spec["bigvgan_dir"], "config.json"))
        vocoder = bigvgan.BigVGAN(hparams, use_cuda_kernel=False)
        generator = torch.load(os.path.join(spec["bigvgan_dir"], "bigvgan_generator.pt"), map_location="cpu")
        try:
            vocoder.load_state_dict(generator["generator"])
        except RuntimeError:
            vocoder.remove_weight_norm()
            vocoder.load_state_dict(generator["generator"])
        else:
            vocoder.remove_weight_norm()
        del generator
        vocoder = vocoder.eval().to(device)
        return model, vocoder

    load_s = time.time() - started
    say("STAGE", "converting")
    say("PROGRESS", 0)

    with torch.no_grad():
        source = _mono(spec["input"], SR).unsqueeze(0).to(device)
        ref = _trim_silence(_mono(spec["reference"], SR), SR)[: int(SR * REF_MAX_S)]
        ref = ref.unsqueeze(0).to(device)

        source_16k = torchaudio.functional.resample(source, SR, 16000)
        if source_16k.size(-1) <= 16000 * 30:
            s_alt = semantic(source_16k)
        else:
            overlap_s = 5
            parts = []
            buffer = None
            traversed = 0
            while traversed < source_16k.size(-1):
                if buffer is None:
                    chunk = source_16k[:, traversed: traversed + 16000 * 30]
                else:
                    chunk = torch.cat(
                        [buffer, source_16k[:, traversed: traversed + 16000 * (30 - overlap_s)]], dim=-1,
                    )
                feats = semantic(chunk)
                parts.append(feats if traversed == 0 else feats[:, 50 * overlap_s:])
                buffer = chunk[:, -16000 * overlap_s:]
                traversed += 30 * 16000 if traversed == 0 else chunk.size(-1) - 16000 * overlap_s
            s_alt = torch.cat(parts, dim=1)

        ref_16k = torchaudio.functional.resample(ref, SR, 16000)
        s_ori = semantic(ref_16k)

        mel_src = to_mel(source.float())
        mel_ref = to_mel(ref.float())
        target_lengths = torch.LongTensor([mel_src.size(2)]).to(device)
        ref_lengths = torch.LongTensor([mel_ref.size(2)]).to(device)

        fbank = torchaudio.compliance.kaldi.fbank(
            ref_16k, num_mel_bins=80, dither=0, sample_frequency=16000,
        )
        fbank = fbank - fbank.mean(dim=0, keepdim=True)
        style = campplus(fbank.unsqueeze(0))

        f0_ref = torch.from_numpy(rmvpe.infer_from_audio(ref_16k[0], thred=0.03)).to(device)[None]
        f0_src = torch.from_numpy(rmvpe.infer_from_audio(source_16k[0], thred=0.03)).to(device)[None]
        source_hz = _median_hz(f0_src)
        ref_hz = _median_hz(f0_ref)
        requested = spec.get("semitones", "auto")
        shift = auto_semitones(source_hz, ref_hz) if requested == "auto" else int(requested)
        shifted = f0_src.clone()
        if shift:
            shifted[f0_src > 1] = f0_src[f0_src > 1] * (2 ** (shift / 12))

        # Content and pitch are ready: free their encoders before the
        # renderer loads, so the DiT + vocoder fit beside other GPU users.
        del whisper, rmvpe, campplus
        if device.type == "cuda":
            torch.cuda.empty_cache()
        model, vocoder = load_renderer()
        say("PROGRESS", 2)

        cond, *_ = model.length_regulator(s_alt, ylens=target_lengths, n_quantizers=3, f0=shifted)
        prompt, *_ = model.length_regulator(s_ori, ylens=ref_lengths, n_quantizers=3, f0=f0_ref)

        max_window = SR // HOP * 30 - mel_ref.size(2)
        overlap_wave = OVERLAP_FRAMES * HOP
        processed = 0
        pieces = []
        previous = None
        total = cond.size(1)
        steps = int(spec.get("diffusion_steps", 30))
        cfg_rate = float(spec.get("cfg_rate", 0.7))
        # Finer progress than one tick per window: count the flow-matching
        # estimator calls (one per diffusion step) inside the current window.
        tick = {"calls": 0, "base": 0, "span": 0, "last": -1}

        def _on_step(_module, _inputs, _output):
            tick["calls"] += 1
            frac = min(1.0, tick["calls"] / max(1, steps))
            pct = int(2 + 97 * (tick["base"] + tick["span"] * frac) / max(1, total))
            if pct != tick["last"]:
                tick["last"] = pct
                say("PROGRESS", min(99, pct))

        model.cfm.estimator.register_forward_hook(_on_step)
        while processed < total:
            chunk_cond = cond[:, processed: processed + max_window]
            tick.update(calls=0, base=processed, span=chunk_cond.size(1))
            last = processed + max_window >= total
            cat = torch.cat([prompt, chunk_cond], dim=1)
            with torch.autocast(device_type=device.type, dtype=torch.float16 if fp16 else torch.float32,
                                enabled=fp16):
                vc_mel = model.cfm.inference(
                    cat, torch.LongTensor([cat.size(1)]).to(device), mel_ref, style, None, steps,
                    inference_cfg_rate=cfg_rate,
                )
                vc_mel = vc_mel[:, :, mel_ref.size(-1):]
            wave = vocoder(vc_mel.float()).squeeze()[None, :]
            if processed == 0:
                if last:
                    pieces.append(wave[0].cpu().numpy())
                    break
                pieces.append(wave[0, :-overlap_wave].cpu().numpy())
                previous = wave[0, -overlap_wave:]
                processed += vc_mel.size(2) - OVERLAP_FRAMES
            elif last:
                pieces.append(crossfade(previous.cpu().numpy(), wave[0].cpu().numpy(), overlap_wave))
                processed += vc_mel.size(2) - OVERLAP_FRAMES
                break
            else:
                pieces.append(crossfade(previous.cpu().numpy(), wave[0, :-overlap_wave].cpu().numpy(),
                                        overlap_wave))
                previous = wave[0, -overlap_wave:]
                processed += vc_mel.size(2) - OVERLAP_FRAMES

    out = np.concatenate(pieces).astype("float32")
    sf.write(spec["output"], out, SR, subtype="FLOAT")
    say("PROGRESS", 100)
    result = {
        "semitones": shift,
        "source_median_hz": source_hz,
        "voice_median_hz": ref_hz,
        "device": device.type,
        "load_s": round(load_s, 2),
        "total_s": round(time.time() - started, 2),
        "duration_s": round(len(out) / SR, 3),
        "peak_vram_mb": round(torch.cuda.max_memory_allocated() / 2**20) if device.type == "cuda" else 0,
    }
    with open(spec["result"], "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: worker.py <spec.json>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
