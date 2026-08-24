# Contributing to Tusk's Tomes

Welcome — and thank you for even reading this far. Tusk's Tomes is a
small project with a small but growing community of DMs and players,
and **every contribution counts**, whether it's a typo fix, a bug
report, a setup-help reply in a GitHub issue thread, or a new LLM
provider integration.

If you've never contributed to an open-source project before, this
repo is a good first one. The codebase is intentionally modular, the
test surface is small, and the maintainer () is happy to mentor
through your first PR.

---

<details class="docs-section">
<summary><h2>TL;DR — the fastest paths to help</h2></summary>
<div class="docs-section-body">


| You have… | The most-useful way to help |
| --- | --- |
| 5 minutes | [Star the repo](https://github.com/KochiTusker/Tusks-Tomes) + share a thought via the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) |
| A bug to report | [Open an issue](https://github.com/KochiTusker/Tusks-Tomes/issues/new/choose) — there's a template that asks for exactly the info needed |
| A feature idea | Sketch it in the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) first, then [open a feature request](https://github.com/KochiTusker/Tusks-Tomes/issues/new/choose) |
| Setup-help energy | Watch GitHub issues for setup questions and chip in — that's the single biggest unblock for newcomers (a community Discord with a dedicated support channel is on the [roadmap](docs/about/roadmap.md)) |
| A small code fix | Send a PR straight from your fork; the template guides you |
| Time for a larger change | Open an issue or sketch the design via the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) before coding |
| Money | [Buy me a coffee](https://buymeacoffee.com/kochitusker) — 100% optional, 100% appreciated |

---


</div>
</details>

<details class="docs-section">
<summary><h2>Code of Conduct</h2></summary>
<div class="docs-section-body">


Participation in this project is governed by the
[**Tuskers' Code of Conduct**](.github/CODE_OF_CONDUCT.md). By
participating, you agree to uphold it. The short version: **be kind,
be patient with newcomers, and disagree well**.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Development setup</h2></summary>
<div class="docs-section-body">


The end-user-facing setup walkthrough lives in [README.md](README.md).
For developers, the dev-facing nuance (env vars, test commands, common
pitfalls) lives in [SETUP.md](docs/getting-started/installation.md). The full system design lives
in [architecture.md](docs/about/how-its-built.md).

The fastest dev loop:

```sh
git clone https://github.com/KochiTusker/Tusks-Tomes.git
cd Tusks-Tomes
npm run setup        # checks deps, runs npm install + whisper:setup
npm run dev          # Express + Vite middleware on http://localhost:5173
```

Useful scripts during development:

```sh
npm run typecheck    # tsc --noEmit for both client and server configs
npm run build        # vite build + tsc -p tsconfig.server.json
npm run smoke-test   # End-to-end health check
```

---


</div>
</details>

<details class="docs-section">
<summary><h2>Where things live (so you know where to drop new code)</h2></summary>
<div class="docs-section-body">


The codebase is intentionally modular — each LLM provider, each API
route, each pipeline phase lives in its own file. Adding a new one
rarely requires touching anything else.

| If you're adding… | Put it in… | Pattern to follow |
| --- | --- | --- |
| A new cloud LLM provider (e.g. Mistral, Together.ai) | `src/lib/providers/<name>.ts` | Existing `claude.ts` / `openai.ts` / `gemini.ts`. Don't forget the `RateLimitState` wiring (response-header parsing in `rateLimit.ts`) and the chunk-size row in `src/lib/chunking.ts`. |
| A new pipeline phase | `src/lib/pipeline.ts` + `src/lib/chunking.ts` | Existing `phase1Cleanup` / `phase3Chronicle`. Add a chunk-size column to each profile in `CLOUD_CHUNK_SIZES` and the local row. |
| A new HTTP API route | `server/api/<resource>.ts` | One router per resource. Mount from `server/index.ts` for core routes; from a module's `registerRoutes()` for optional ones. |
| A new UI tab / panel | `src/components/<Name>.tsx` | Existing `RefinementTool.tsx` / `CaptionRepair.tsx` / `DocsViewer.tsx`. Gate optional ones on `useAddons().isLoaded(name)`. |
| A new ingest format (e.g. SRT, VTT) | `server/upload/` + `src/lib/` | Existing multitrack zip extractor / SBV parser |
| A new module (e.g. live transcription, OCR) | `server/addons/registry.ts` (new entry) + `server/api/<routes>.ts` + `docs/add-ons/<slug>.md` | Pick `kind` first. `kind: 'builtin'` if it downloads nothing — declare only `registerRoutes` (and `docSlug`), and detection lives on its own status route. `kind: 'install'` only if it genuinely puts bytes on disk — then it also declares `isReady` / `install` / `uninstall`. `audio-addon` is the only install today; the other six are builtins. |
| A new local-LLM backend | `server/localProbe/` + `server/api/localLLM.ts` (these are inside the `local-llm-addon`) | Existing Ollama / LM Studio / Unsloth detection |

---


</div>
</details>

<details class="docs-section">
<summary><h2>Pull request etiquette</h2></summary>
<div class="docs-section-body">


- **Keep PRs focused.** One change per PR is easier to review and easier to revert.
- **Match the existing style.** TypeScript strict, no unnecessary abstractions, no half-finished code paths.
- **No new dependencies without a reason.** Tusk's Tomes is intentionally small. If you need a library, mention what problem it solves in the PR body.
- **Run `npm run typecheck` and `npm test`** before pushing — CI runs them on every PR, but local feedback is faster. `npm run build` catches Vite-only issues if you've touched bundler config.
- **Update docs.** If you added a feature, the README (and `architecture.md` for anything structural) should mention it. The PR template asks about this.
- **No new outbound network calls without a discussion first.** Tusk's Tomes is local-first; anything that contacts the network needs to be justified.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Code style</h2></summary>
<div class="docs-section-body">


- TypeScript on the client and server. The Python sidecar is scoped to `faster-whisper` invocation only.
- Prefer small, focused modules.
- Comments are rare and reserved for *why*, not *what*. Names should carry the rest.
- React 19 + Tailwind CSS for the UI. Lucide-react for icons.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Reporting security issues</h2></summary>
<div class="docs-section-body">


**Please do not open public issues for security problems.** See
[SECURITY.md](.github/SECURITY.md) for the disclosure process.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Questions?</h2></summary>
<div class="docs-section-body">


- **GitHub Issues** — for bugs, feature requests, and tracked discussions
- **[Feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header)** — for design sketches, half-formed ideas, sharing chronicles, and anything that doesn't fit a GitHub issue. A community Discord is on the [roadmap](docs/about/roadmap.md) and will replace this channel once there's enough signalled interest.

Thank you for helping make Tusk's Tomes better.


</div>
</details>
