#!/usr/bin/env python3
"""
Whisper sidecar invoked by the Express server.

Two modes:

  1. One-shot (default — back-compat): reads `--audio` and prints the
     transcription as a single JSON document on stdout, then exits.

  2. Persistent worker (`--serve`): loads the model once at startup,
     then enters a loop reading line-delimited JSON requests on stdin
     and writing line-delimited JSON responses on stdout. Used by the
     Node-side WhisperWorker (server/whisper/worker.ts) so a single
     Python process handles every utterance in a session — eliminating
     the back-to-back CUDA/cuDNN re-init crash (STATUS_STACK_BUFFER_OVERRUN
     / 0xC0000409) that plagued the one-shot path on Windows.

Errors go to stderr; non-zero exit code on fatal failure. Normal output
in one-shot mode is a single JSON object on stdout. Worker mode writes
one JSON envelope per line on stdout — `{"kind":"ready",...}` once when
the model is loaded, then `{"kind":"response","id":...,"ok":...}` per
request.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Iterable


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _apply_stability_flags() -> None:
    """Best-effort: pin cuDNN to deterministic, non-benchmark code paths.
    The auto-tuner has been observed to pick kernel implementations on
    Windows that crash with STATUS_STACK_BUFFER_OVERRUN during cuDNN
    re-init. Deterministic mode picks safer paths at a small perf cost.
    No-ops if torch isn't installed (CTranslate2 doesn't require it)."""
    try:
        import torch  # type: ignore

        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
    except Exception:  # noqa: BLE001 — torch is optional
        pass


def _load_model(model_id: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel  # type: ignore

    return WhisperModel(model_id, device=device, compute_type=compute_type)


def _transcribe_one(model, *, audio: str, initial_prompt: str, language: str) -> tuple[list[dict[str, Any]], int, str]:
    """Run a single transcription pass on an already-loaded model.

    Returns (segments_out, duration_ms, detected_language)."""
    segments_iter, info = model.transcribe(
        audio,
        language=language,
        beam_size=5,
        temperature=[0.0, 0.2, 0.4],
        initial_prompt=(initial_prompt or None),
        vad_filter=True,
        word_timestamps=True,
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
    )
    segments_out: list[dict[str, Any]] = []
    duration_ms = int((info.duration or 0.0) * 1000)
    for seg in segments_iter:
        words_out = []
        if seg.words:
            for w in seg.words:
                words_out.append({
                    "startMs": int((w.start or 0.0) * 1000),
                    "endMs": int((w.end or 0.0) * 1000),
                    "text": (w.word or "").strip(),
                    "confidence": getattr(w, "probability", None),
                })
        segments_out.append({
            "startMs": int((seg.start or 0.0) * 1000),
            "endMs": int((seg.end or 0.0) * 1000),
            "text": (seg.text or "").strip(),
            "words": words_out,
            "confidence": getattr(seg, "avg_logprob", None),
        })
    detected_language = getattr(info, "language", language)
    return segments_out, duration_ms, detected_language


def _one_shot(args: argparse.Namespace) -> int:
    if not os.path.exists(args.audio):
        log(f"ERROR: audio file not found: {args.audio}")
        return 2
    try:
        import faster_whisper  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        log(
            "ERROR: faster-whisper is not installed in this Python environment. "
            "Install via `pip install -r scripts/whisper/requirements.txt`."
        )
        log(str(exc))
        return 3
    _apply_stability_flags()
    try:
        model = _load_model(args.model, args.device, args.compute_type)
    except Exception as exc:  # noqa: BLE001
        log(f"ERROR: failed to load model {args.model!r} on device {args.device}: {exc}")
        if args.device == "cuda":
            log("HINT: try --device cpu --compute-type int8 if no GPU is available.")
        return 4

    started_at = time.time()
    try:
        segments_out, duration_ms, language = _transcribe_one(
            model,
            audio=args.audio,
            initial_prompt=args.initial_prompt,
            language=args.language,
        )
    except Exception as exc:  # noqa: BLE001
        log(f"ERROR: transcribe() failed: {exc}")
        return 5

    payload = {
        "speakerId": args.speaker_id,
        "speakerDisplay": args.speaker_display,
        "durationMs": duration_ms,
        "elapsedMs": int((time.time() - started_at) * 1000),
        "model": args.model,
        "device": args.device,
        "language": language,
        "segments": segments_out,
    }
    json.dump(payload, sys.stdout)
    sys.stdout.flush()
    return 0


def _serve(args: argparse.Namespace) -> int:
    """Persistent worker mode. Load the model once, then process JSON
    requests on stdin until stdin closes."""
    try:
        import faster_whisper  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        log(f"ERROR: faster-whisper not installed: {exc}")
        return 3
    _apply_stability_flags()
    log(
        f"[worker] loading model={args.model} device={args.device} "
        f"compute_type={args.compute_type}"
    )
    try:
        model = _load_model(args.model, args.device, args.compute_type)
    except Exception as exc:  # noqa: BLE001
        log(f"ERROR: failed to load model {args.model!r} on device {args.device}: {exc}")
        if args.device == "cuda":
            log("HINT: try --device cpu --compute-type int8 if no GPU is available.")
        return 4

    print(
        json.dumps({
            "kind": "ready",
            "device": args.device,
            "model": args.model,
        }),
        flush=True,
    )
    log("[worker] model loaded; awaiting requests on stdin")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
        except json.JSONDecodeError as exc:
            print(
                json.dumps({
                    "kind": "response",
                    "id": None,
                    "ok": False,
                    "error": f"bad JSON: {exc}",
                }),
                flush=True,
            )
            continue

        audio = req.get("audio")
        if not audio or not os.path.exists(audio):
            print(
                json.dumps({
                    "kind": "response",
                    "id": req_id,
                    "ok": False,
                    "error": f"audio file not found: {audio}",
                }),
                flush=True,
            )
            continue

        started_at = time.time()
        try:
            segments_out, duration_ms, language = _transcribe_one(
                model,
                audio=audio,
                initial_prompt=req.get("initialPrompt", "") or "",
                language=req.get("language", args.language) or "en",
            )
        except Exception as exc:  # noqa: BLE001
            log(f"[worker] req {req_id} failed: {exc}")
            print(
                json.dumps({
                    "kind": "response",
                    "id": req_id,
                    "ok": False,
                    "error": str(exc),
                }),
                flush=True,
            )
            continue

        elapsed_ms = int((time.time() - started_at) * 1000)
        result = {
            "speakerId": req.get("speakerId", ""),
            "speakerDisplay": req.get("speakerDisplay", ""),
            "durationMs": duration_ms,
            "elapsedMs": elapsed_ms,
            "model": args.model,
            "device": args.device,
            "language": language,
            "segments": segments_out,
        }
        print(
            json.dumps({
                "kind": "response",
                "id": req_id,
                "ok": True,
                "result": result,
            }),
            flush=True,
        )

    log("[worker] stdin closed; exiting")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe with faster-whisper (one-shot or persistent worker).")
    parser.add_argument("--audio", help="One-shot mode: path to the audio file to transcribe.")
    parser.add_argument("--speaker-id", default="", help="Discord user ID (one-shot only).")
    parser.add_argument("--speaker-display", default="", help="Speaker label (one-shot only).")
    parser.add_argument("--initial-prompt", default="", help="Glossary-biased initial prompt (one-shot only).")
    parser.add_argument("--model", default="large-v3", help="faster-whisper model id or local path.")
    parser.add_argument("--device", default="cuda", help="cuda or cpu.")
    parser.add_argument("--compute-type", default="int8_float16", help="faster-whisper compute_type.")
    parser.add_argument("--language", default="en", help="Whisper language code (default: en).")
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Persistent worker mode: load model once, read JSON requests on stdin.",
    )
    args = parser.parse_args()

    if args.serve:
        return _serve(args)
    if not args.audio:
        log("ERROR: --audio is required in one-shot mode (omit it and pass --serve for worker mode).")
        return 2
    return _one_shot(args)


# Kept for accidental external callers; deprecated in favour of the
# private _transcribe_one helper that operates on an already-loaded model.
def _as_list(it: Iterable) -> list:
    return list(it)


if __name__ == "__main__":
    sys.exit(main())
