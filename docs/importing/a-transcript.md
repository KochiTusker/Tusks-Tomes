# Import a transcript

The simplest route in: you already have the text, and Tomes turns it into a
chronicle. Nothing to install, no GPU, no Python.

Tomes doesn't care where the text came from — a previous Whisper run, a manual
notetaker, a NotebookLM export, a Discord chat log, a Roll20 or Foundry log, or
a transcript someone else produced.

## The short version

1. Open the **Chronicle** tab.
2. Paste your transcript into the **Raw transcript** box.
3. Set a campaign name and session number, then **Begin the Chronicle**.

That's the whole route. Everything after it is the same six-phase pipeline the
other two routes feed.

## What good input looks like

The pipeline works from whatever it's given, but it works better with some
structure:

- **Speaker labels help enormously.** A line like `[Kaziel] I open the door` is
  far easier to attribute than a bare stream of prose. If your source has them
  in any form, keep them.
- **Timestamps are optional.** They give the chunker better segmentation
  boundaries, but plain text is perfectly workable.
- **Length is not a problem.** The chunker sizes input to whichever model each
  phase is routed to; a three-hour session is ordinary.

> [!TIP]
> **A glossary matters more than the transcript's polish.** Phase 1 grounds
> names against your glossary and lore, so a transcript riddled with misheard
> fantasy names still comes out right — provided the correct spellings are in
> the [Tome of Lore](../settings/configuration.md). Fix a name once and it
> stays fixed for every future session.

## On an AMD or Intel GPU? Read this before you go hunting

If you're here because the built-in transcriber won't use your card, this is
the relevant background — it only accelerates on NVIDIA, and it's natural to
assume some other Whisper build will use your card. Here's what I found when I
actually went looking, to save you the same afternoon:

| Project | Prebuilt GPU backends | Verdict |
|---|---|---|
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | CPU, BLAS *(still CPU)*, CUDA | Its Vulkan backend exists in source but **is not in any release build**. You'd have to compile it yourself with the Vulkan SDK. |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | CPU, CUDA | No DirectML build shipped. |
| [Const-me/Whisper](https://github.com/Const-me/Whisper) | DirectCompute — **any DirectX 11 GPU** | Genuinely works on AMD and Intel. Windows-only, and no release since July 2023. |

So the only ready-made thing that will actually use an AMD or Intel card is
Const-me/Whisper, and it's been unmaintained for years. If you're willing to
accept that, it produces plain text you can paste straight in via this route.

> [!TIP]
> **Compiling whisper.cpp with `GGML_VULKAN=1` yourself works well**, and Tomes
> has a [whisper.cpp bridge](../extras/whisper-cpp.md) built in for exactly
> that case. It detects your build, reads its capability line so it can tell
> you outright if you've ended up with a CPU-only binary, and falls back to the
> built-in engine rather than failing a run. Nothing is downloaded; you supply
> the build and the model.

If neither appeals, [importing YouTube captions](youtube-captions.md)
needs no GPU at all and is the route I'd point most people to.

## Next

- [Recommended settings](../chronicling/recommended-settings.md) — what to run once you're in
- [Import YouTube captions](youtube-captions.md) — if you'd rather not paste
- [Choosing a provider](../models/choosing-a-provider.md) — which model runs this
