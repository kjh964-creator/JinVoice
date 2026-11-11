# JinVoice — next build

1. **Easy mode (default, only UI)** — decided 2026-11-08 by owner: "쉬운 화면만 남기고 나머지 기능은 숨기기".
   Pain points named by owner: too many menus, English/jargon, voice registration/cloning is hard.
   - Root `/` shows a minimal JinVoice shell: logo + "JinVoice" + small ⚙ 설정 (only for model/engine setup). No workspace sidebar,
     context sidebar, command palette, account corner, agent docks, GitHub star, pro, integrations.
   - Home: 3 big cards — 음성 만들기 / 내 목소리 / 만든 음성.
   - 음성 만들기: 목소리 선택 → 문장 입력(글자 수) → 말하기 속도(느리게/보통/빠르게) → [음성 만들기] → 진행 표시 → 결과 재생 / 파일로 저장 / 다시 만들기.
   - 내 목소리: list (재생, 이름 바꾸기, 삭제 with confirm) + [새 목소리 등록] wizard: ① 이름 ② 마이크로 녹음(읽을 예시 문장 표시, 3~10초, 타이머) 또는 음원 파일 선택 ③ 말한 내용 자동 인식 → 보이는 편집칸에서 확인/수정(필수 확인) ④ "내 목소리이거나 허락받은 목소리입니다" 동의 ⑤ 저장.
   - 만든 음성: newest first, 문장·목소리·날짜, 재생/저장/삭제.
   - Plain Korean copy everywhere, no "clone/TTS/engine/inference/model" words in easy screens.
   - Single switch `EASY_MODE` so it can be turned off later; other routes stay in code, unlinked.
3. **쉬운 사용법** — owner request: after everything is done, a simple guide showing how to use it.
   - In-app: small "사용법" button on the easy home → one page with 3 short illustrated steps per screen.
   - File: `JinVoice 사용법` (PDF + HTML) with real screenshots of the final app, delivered on desktop/in chat.
4. **No fake "JinVoice Pro"** — owner asked "진보이스 프로는 뭐야 돈을 받고하는거야?". The /pro page, supportPlans, account.feature_pro,
   donate and cloudsync pro strings are upstream's paid VoiceStudio Pro (checkout at voicestudio.sh). Easy mode must not link them;
   branding script must keep the upstream name ("VoiceStudio Pro") in pro/donate/supportPlans strings instead of "JinVoice Pro".
5. **고급 기능 꺼내기 스위치** — owner asked how to bring hidden features back. Turn EASY_MODE from a constant into a saved
   preference: ⚙ 설정 → bottom '모든 기능 보기 (고급)' switch (default off = easy). On → full upstream navigation; a
   '쉬운 화면으로' button in the full UI's top-left switches back. Persist the choice (localStorage/prefs), apply without restart.
2. **Loudness** — quiet reference recordings must still give loud output: normalize every saved generation (speech RMS ≈ -17 dBFS, smooth limiter ≤ -0.4 dBFS). Reference: `E:/app_make4/JinhoVoice/engine_worker.py` `master_loudness`.

## Queued (2026-11-09, user-approved)
- [in progress] Song cover: song file + registered voice -> same song sung in that voice (separation + zero-shot SVC, feature id `cover`, default off).
- [built, uncommitted, for the next build] Story song (`story_song`, `/easy/story-song`, default off): user story + registered voice -> lyrics by a LOCAL LLM (Qwen3-4B-Instruct-2507 Q4_K_M via llama.cpp b12244 Vulkan, editable before generating) -> song (ACE-Step 1.5 turbo q8_0 via audio.cpp v0.9.4 Vulkan, genre + 1/2/3 min) -> vocals re-sung in the chosen voice with the cover pipeline; both takes saved to made speech. First use downloads ~8.8 GB (+ cover files if missing).
- [done, uncommitted] Voice conversion defaults tuned by ear with the user (2026-11-11): steadier pitch (f0_steady 0.05/win 31), brighter/clearer vocal (VOICE_POLISH in song_cover.py), story-song key fit ~4 semitones above speaking+6 (KEY_FIT_ABOVE_SPEECH 10). Always applied; ship with 0.5.16 together with the advanced-mode phone layout.
