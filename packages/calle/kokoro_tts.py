"""Kokoro-82M text-to-speech fallback for Sentinel Ops.

CLI:
    python kokoro_tts.py "Hello world" -o outputs/hello.wav

Library:
    from kokoro_tts import synthesize
    synthesize("Hello world", voice="af_heart", out="hello.wav")

Install the dependencies from requirements.txt in a Python 3.10-3.12
environment. The Kokoro model is downloaded by the `kokoro` package on first
use and cached by Hugging Face.
"""
from __future__ import annotations

import argparse
import os
import sys
import warnings
from pathlib import Path

if sys.platform == "win32":
    _ESPEAK = Path(r"C:\Program Files\eSpeak NG")
    if _ESPEAK.is_dir():
        os.environ.setdefault("PHONEMIZER_ESPEAK_LIBRARY", str(_ESPEAK / "libespeak-ng.dll"))
        os.environ.setdefault("ESPEAK_DATA_PATH", str(_ESPEAK / "espeak-ng-data"))

import numpy as np
import soundfile as sf

SAMPLE_RATE = 24000
REPO_ID = "hexgrad/Kokoro-82M"
DEFAULT_VOICE = "af_heart"
DEFAULT_OUTPUT = "outputs/output.wav"

LANGUAGES = {
    "a": ("American English", None, ("af_", "am_")),
    "b": ("British English", None, ("bf_", "bm_")),
    "e": ("Spanish", None, ("ef_", "em_")),
    "f": ("French", None, ("ff_",)),
    "h": ("Hindi", None, ("hf_", "hm_")),
    "i": ("Italian", None, ("if_", "im_")),
    "p": ("Brazilian Portuguese", None, ("pf_", "pm_")),
    "j": ("Japanese", "misaki[ja]", ("jf_", "jm_")),
    "z": ("Mandarin Chinese", "misaki[zh]", ("zf_", "zm_")),
}

VOICES = [
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella",
    "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis", "ef_dora",
    "em_alex", "em_santa", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega",
    "hm_psi", "if_sara", "im_nicola", "jf_alpha", "jf_gongitsune",
    "jf_nezumi", "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa",
    "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian",
    "zm_yunxi", "zm_yunxia", "zm_yunyang",
]

_PIPELINES: dict[str, object] = {}


def lang_for_voice(voice: str) -> str:
    if not voice or voice[0] not in LANGUAGES:
        raise ValueError(f"Cannot infer language for voice {voice!r}")
    return voice[0]


def voices_for_lang(lang_code: str) -> list[str]:
    if lang_code not in LANGUAGES:
        raise ValueError(f"Unknown language {lang_code!r}")
    return [voice for voice in VOICES if voice.startswith(LANGUAGES[lang_code][2])]


def get_pipeline(lang_code: str):
    if lang_code not in _PIPELINES:
        if lang_code not in LANGUAGES:
            raise ValueError(f"Unknown language {lang_code!r}")
        name, extra, _ = LANGUAGES[lang_code]
        try:
            from kokoro import KPipeline
        except ImportError as exc:
            requirement = f"misaki[{'ja' if lang_code == 'j' else 'zh'}]" if extra else "kokoro"
            raise ImportError(f"{name} requires `{requirement}`. Install requirements.txt first.") from exc
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)
            warnings.simplefilter("ignore", UserWarning)
            _PIPELINES[lang_code] = KPipeline(lang_code=lang_code, repo_id=REPO_ID)
    return _PIPELINES[lang_code]


def synthesize(
    text: str,
    voice: str = DEFAULT_VOICE,
    out: str | Path | None = None,
    speed: float = 1.0,
    lang_code: str | None = None,
    split_pattern: str = r"\n+",
) -> np.ndarray:
    """Return synthesized float32 audio at 24 kHz and optionally write a WAV."""
    if not text.strip():
        raise ValueError("text is empty")
    if voice not in VOICES:
        raise ValueError(f"Unknown voice {voice!r}")
    if not 0.5 <= speed <= 2.0:
        raise ValueError("speed must be between 0.5 and 2.0")

    pipeline = get_pipeline(lang_code or lang_for_voice(voice))
    chunks = [
        result.audio.numpy()
        for result in pipeline(text, voice=voice, speed=speed, split_pattern=split_pattern)
        if result.audio is not None
    ]
    if not chunks:
        raise RuntimeError("Kokoro produced no audio")

    audio = np.concatenate(chunks).astype(np.float32)
    if out is not None:
        output = Path(out)
        output.parent.mkdir(parents=True, exist_ok=True)
        sf.write(output, audio, SAMPLE_RATE)
    return audio


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Kokoro-82M text-to-speech")
    parser.add_argument("text", nargs="?", help="text to speak")
    parser.add_argument("-f", "--file", help="read text from a UTF-8 file")
    parser.add_argument("-o", "--output", default=DEFAULT_OUTPUT)
    parser.add_argument("-v", "--voice", default=DEFAULT_VOICE)
    parser.add_argument("-s", "--speed", type=float, default=1.0)
    parser.add_argument("--lang-code")
    parser.add_argument("--list-voices", action="store_true")
    args = parser.parse_args(argv)

    if args.list_voices:
        print("\n".join(VOICES))
        return 0
    if args.file:
        text = Path(args.file).read_text(encoding="utf-8")
    elif args.text:
        text = args.text
    elif not sys.stdin.isatty():
        text = sys.stdin.read()
    else:
        parser.error("provide text or --file")

    try:
        audio = synthesize(text, args.voice, args.output, args.speed, args.lang_code)
    except (ImportError, OSError, RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"{args.output} ({len(audio) / SAMPLE_RATE:.2f}s, voice={args.voice})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
