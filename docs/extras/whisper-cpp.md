# whisper.cpp bridge

This is the route for **AMD, Intel and Apple GPUs**. It's more involved than
the other add-ons, and I want to be straight about why rather than dress it up.

The built-in transcriber only accelerates on NVIDIA. I went looking for a
ready-made alternative that would use other cards and didn't find a good one:

| Project | Prebuilt GPU backends | Verdict |
|---|---|---|
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | CPU, BLAS *(still CPU)*, CUDA | Has a **Vulkan** backend in source — but it is in **no release build**. |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | CPU, CUDA | 300+ release assets, no DirectML. |
| [Const-me/Whisper](https://github.com/Const-me/Whisper) | DirectCompute — any DirectX 11 GPU | Genuinely works on AMD/Intel. No release since July 2023. |

So there is no maintained binary I could bundle that would use your card. I
could compile and ship one, but that would make this project a binary
publisher — signing, checksums, platform gatekeepers — for software I can't
test on the hardware it's for. I'd rather not make a promise I can't keep.

**So this is a bridge, not an installer.** You build or obtain whisper.cpp
yourself; Tusk's Tomes detects it, checks it, and uses it. Same arrangement as
[Claude Code](claude-code.md) and [Codex](codex.md): you own the tool, I own
the integration.

> [!TIP]
> **It downloads and installs nothing — and now it doesn't even write a marker
> file.** The bridge ships with the app and is always available; it simply
> looks for the paths you set. Your whisper.cpp build and model files are
> yours and are never touched.

---

## What you'll need

1. A **whisper.cpp build compiled with a GPU backend** for your card.
2. A **model file** in GGML format.

Both live wherever you like. Tusk's Tomes only stores the paths.

> [!CAUTION]
> **Downloading an official release will not give you GPU acceleration.**
> The release binaries are CPU-only, or CUDA if you have NVIDIA — in which case
> use the normal Audio Transcription module instead, it's easier. For AMD or
> Intel you have to compile with Vulkan yourself. Tomes reads your binary's own
> capability line and will tell you plainly if it's a CPU-only build, so you
> won't be left wondering why it's slow.

---

## Building whisper.cpp with Vulkan

Vulkan is the backend worth having: one build covers AMD, Intel and NVIDIA.

The authoritative instructions are in the project's own README —
**[github.com/ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp#vulkan-gpu-support)** —
and you should prefer those if they differ from what's below. This is what the
process looks like in practice.

### Windows

You'll need [Visual Studio](https://visualstudio.microsoft.com/downloads/)
with the "Desktop development with C++" workload, [CMake](https://cmake.org/download/),
and the [Vulkan SDK](https://vulkan.lunarg.com/sdk/home) from LunarG.

```powershell
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_VULKAN=1
cmake --build build --config Release
```

The binary lands at `build\bin\Release\whisper-cli.exe`.

### Linux

```sh
# Vulkan headers + loader, via your package manager. On Debian/Ubuntu:
sudo apt install vulkan-tools libvulkan-dev glslc cmake build-essential

git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_VULKAN=1
cmake --build build --config Release
```

The binary lands at `build/bin/whisper-cli`.

### macOS

Don't use Vulkan here — Apple Silicon has a better option. Metal is enabled by
default, so a plain build already uses your GPU:

```sh
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build
cmake --build build --config Release
```

### Checking it worked

Run the binary with no arguments and look for the `system_info:` line. You want
`VULKAN = 1` (or `METAL = 1` on a Mac). If everything reads `0`, the build
didn't pick up the SDK — the add-on will also tell you this once configured.

---

## Getting a model

The models live in the whisper.cpp repo's Hugging Face mirror. `large-v3` is
what the built-in engine uses and gives the best results; `medium` is a
reasonable compromise on a smaller card.

```sh
# from inside the whisper.cpp checkout
./models/download-ggml-model.sh large-v3    # or: medium, small, base
```

On Windows use `models\download-ggml-model.cmd large-v3`. The file lands in
`models/` and is roughly 3 GB for `large-v3`.

If you'd rather download directly, the files are at
[huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main).
Take the `.bin` — the add-on rejects anything under 20 MB, since that's
invariably a Git-LFS pointer rather than real weights.

---

## Setting it up in Tusk's Tomes

1. **Settings → whisper.cpp bridge.** There is no install step and no
   restart — the bridge is always mounted and simply waits for a path.
2. Set two paths:
   - the binary, e.g. `C:\dev\whisper.cpp\build\bin\Release\whisper-cli.exe`
   - the model, e.g. `C:\dev\whisper.cpp\models\ggml-large-v3.bin`

   Both must be absolute paths.
3. The panel then reports what it found. You're looking for
   **"Ready, with GPU acceleration via Vulkan"**. If it says *"this is a
   CPU-only build"*, the compile didn't pick up Vulkan — revisit the SDK step.

---

## What could go wrong

**"That binary didn't run."** Usually the path is wrong, or on Linux/macOS the
file isn't executable — `chmod +x whisper-cli`. On Windows, if you moved the
`.exe` out of its build folder, put it back: it needs the DLLs alongside it.

**"CPU-only build."** The compile didn't find the Vulkan SDK. On Windows, open
a fresh terminal after installing the SDK so `VULKAN_SDK` is set, then delete
`build/` and configure again.

**"Model file is missing or too small."** Almost always a Git-LFS pointer file
rather than the real weights. Re-download using the script above.

**It runs but is no faster than before.** Check the `system_info:` line
directly. Some drivers expose a Vulkan device that falls back to software
rendering, which reports as available but performs like CPU.

---

## Honestly, is it worth it?

If you've a decent AMD or Intel card and you're comfortable with a build
toolchain: yes. You get proper GPU transcription instead of waiting hours.

If any of the above made you wince: **use the
[YouTube route](../importing/README.md) instead**. Upload the recording as an unlisted
video, let Google transcribe it, import the captions. It needs no GPU, no
compiler and no Python, and it's what I'd recommend to most people in this
position. The trade-off is speaker attribution, covered in that page.

Making this as easy as the main Whisper add-on is on the
[roadmap](../about/roadmap.md) — it needs an upstream project to ship a
vendor-neutral GPU build, or for me to take on publishing signed binaries.
Neither is true today, and I'd rather say so than pretend otherwise.
