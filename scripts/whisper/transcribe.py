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
one JSON envelope per line on stdout:

  {"kind":"loading","stage":"import"}   before faster-whisper is imported
  {"kind":"loading","stage":"model"}    before the weights are loaded
  {"kind":"ready",...}                  once, when the model is loaded —
                                        carrying the device the model
                                        actually landed on, not the one
                                        that was asked for
  {"kind":"progress","id":...}          at most once a second while a
                                        request is being transcribed
  {"kind":"response","id":...,"ok":...} exactly once per request

The Node side keys on `kind`, so new envelope kinds are additive: a
consumer that only knows `ready` and `response` still works.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import time
from typing import Any, Callable, Iterable


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _emit(envelope: dict[str, Any]) -> None:
    """Write one line-delimited JSON envelope to stdout."""
    print(json.dumps(envelope), flush=True)


def _apply_stability_flags() -> None:
    """Best-effort: pin cuDNN to deterministic, non-benchmark code paths.
    The auto-tuner has been observed to pick kernel implementations on
    Windows that crash with STATUS_STACK_BUFFER_OVERRUN during cuDNN
    re-init. Deterministic mode picks safer paths at a small perf cost.

    Importing torch does a second job on Windows: it is what puts cuDNN's
    sub-DLLs where CTranslate2 can find them. A torch that fails to import
    therefore does not just lose these flags — it can quietly push every
    utterance onto the CPU path. That is worth a line on stderr rather
    than silence, even though torch is optional and the load proceeds."""
    try:
        import torch  # type: ignore

        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
    except Exception as exc:  # noqa: BLE001 — torch is optional
        log(
            "WARNING: torch failed to import, so the GPU path may be unavailable "
            f"and transcription may fall back to the CPU: {exc}"
        )


def _load_model(model_id: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel  # type: ignore

    return WhisperModel(model_id, device=device, compute_type=compute_type)


def _actual_device(model, requested_device: str) -> str:
    """The device the loaded model is really on.

    faster-whisper wraps a CTranslate2 model at `.model`, which reports the
    device it resolved to; a request for `cuda` can still land on `cpu`.
    Anything unexpected falls back to the requested device so a reporting
    quirk never fails a load."""
    try:
        device = getattr(getattr(model, "model", None), "device", None)
        if isinstance(device, str) and device:
            return device
    except Exception:  # noqa: BLE001
        pass
    return requested_device


def _module_version(module_name: str, dist_name: str | None = None) -> str | None:
    """Version of an importable module, or None when it is absent or broken."""
    try:
        mod = importlib.import_module(module_name)
        version = getattr(mod, "__version__", None)
        if version:
            return str(version)
    except Exception:  # noqa: BLE001
        return None
    try:
        from importlib.metadata import version as dist_version

        return dist_version(dist_name or module_name)
    except Exception:  # noqa: BLE001
        return None


def _cuda_version() -> str | None:
    try:
        import torch  # type: ignore

        cuda = getattr(getattr(torch, "version", None), "cuda", None)
        return str(cuda) if cuda else None
    except Exception:  # noqa: BLE001
        return None


def _cuda_device_count() -> int:
    try:
        import ctranslate2  # type: ignore

        return int(ctranslate2.get_cuda_device_count())
    except Exception:  # noqa: BLE001
        return 0


def _describe_runtime(model, *, model_id: str, requested_device: str, compute_type: str) -> dict[str, Any]:
    """The `ready` envelope. Every field is read defensively: a missing or
    broken optional module must never turn a successful load into a
    failure, it just reports as null."""
    return {
        "kind": "ready",
        "device": _actual_device(model, requested_device),
        "model": model_id,
        "computeType": compute_type,
        "versions": {
            "faster_whisper": _module_version("faster_whisper", "faster-whisper"),
            "ctranslate2": _module_version("ctranslate2"),
            "torch": _module_version("torch"),
            "cuda": _cuda_version(),
        },
        "cudaDevices": _cuda_device_count(),
    }


class _ProgressEmitter:
    """Writes `progress` envelopes for one request, at most once a second.

    faster-whisper hands back a lazy segment iterator, so an hour-long
    track can run for many minutes with nothing on stdout until the end.
    Reporting per segment as it lands gives the Node side something to
    show; the throttle keeps a fast GPU from flooding the pipe. Nothing in
    here may raise — a progress hiccup must never cost the transcription."""

    interval_s = 1.0

    def __init__(self, req_id: Any) -> None:
        self._req_id = req_id
        self._last_emit = 0.0

    def __call__(self, processed_ms: int, duration_ms: int) -> None:
        try:
            now = time.monotonic()
            if now - self._last_emit < self.interval_s:
                return
            self._last_emit = now
            _emit({
                "kind": "progress",
                "id": self._req_id,
                "processedMs": processed_ms,
                "durationMs": duration_ms,
            })
        except Exception:  # noqa: BLE001 — progress is advisory
            pass


def _transcribe_one(
    model,
    *,
    audio: str,
    initial_prompt: str,
    language: str,
    on_progress: Callable[[int, int], None] | None = None,
) -> tuple[list[dict[str, Any]], int, str]:
    """Run a single transcription pass on an already-loaded model.

    `on_progress`, when given, is called with (processed_ms, duration_ms)
    after each segment arrives. It must not raise.

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
        end_ms = int((seg.end or 0.0) * 1000)
        segments_out.append({
            "startMs": int((seg.start or 0.0) * 1000),
            "endMs": end_ms,
            "text": (seg.text or "").strip(),
            "words": words_out,
            "confidence": getattr(seg, "avg_logprob", None),
        })
        if on_progress is not None:
            on_progress(end_ms, duration_ms)
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
        # No progress callback: one-shot output is a single JSON document,
        # and a caller parsing stdout as one must never see a second one.
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
    # The import alone can take several seconds (torch, CUDA runtime),
    # and the weights load longer still. Each stage is announced so the
    # Node side can tell "still starting" from "hung".
    _emit({"kind": "loading", "stage": "import"})
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
    _emit({"kind": "loading", "stage": "model"})
    try:
        model = _load_model(args.model, args.device, args.compute_type)
    except Exception as exc:  # noqa: BLE001
        log(f"ERROR: failed to load model {args.model!r} on device {args.device}: {exc}")
        if args.device == "cuda":
            log("HINT: try --device cpu --compute-type int8 if no GPU is available.")
        return 4

    ready = _describe_runtime(
        model,
        model_id=args.model,
        requested_device=args.device,
        compute_type=args.compute_type,
    )
    actual_device = ready["device"]
    _emit(ready)
    if actual_device != args.device:
        log(f"[worker] requested device={args.device} but the model loaded on {actual_device}")
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
            _emit({
                "kind": "response",
                "id": None,
                "ok": False,
                "error": f"bad JSON: {exc}",
            })
            continue

        audio = req.get("audio")
        if not audio or not os.path.exists(audio):
            _emit({
                "kind": "response",
                "id": req_id,
                "ok": False,
                "error": f"audio file not found: {audio}",
            })
            continue

        started_at = time.time()
        try:
            segments_out, duration_ms, language = _transcribe_one(
                model,
                audio=audio,
                initial_prompt=req.get("initialPrompt", "") or "",
                language=req.get("language", args.language) or "en",
                on_progress=_ProgressEmitter(req_id),
            )
        except Exception as exc:  # noqa: BLE001
            log(f"[worker] req {req_id} failed: {exc}")
            _emit({
                "kind": "response",
                "id": req_id,
                "ok": False,
                "error": str(exc),
            })
            continue

        elapsed_ms = int((time.time() - started_at) * 1000)
        result = {
            "speakerId": req.get("speakerId", ""),
            "speakerDisplay": req.get("speakerDisplay", ""),
            "durationMs": duration_ms,
            "elapsedMs": elapsed_ms,
            "model": args.model,
            "device": actual_device,
            "language": language,
            "segments": segments_out,
        }
        _emit({
            "kind": "response",
            "id": req_id,
            "ok": True,
            "result": result,
        })

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
