# Graphify

[`safishamsi/graphify`](https://github.com/safishamsi/graphify) is a Claude
Code skill that reads the project's source files and builds a queryable
knowledge graph (functions, types, dependencies, cross-file calls). Once
installed, Claude Code uses it to answer "where does X get called?" /
"what depends on Y?" without having to grep the repo from scratch each
time.

Dev-only tooling — not a project dependency, not shipped to end users.

## Prerequisites

- Python ≥ 3.10 (this project already requires Python for the Whisper
  transcription module; check with `python --version`).
- Claude Code CLI installed and working.

## Install (one-time, per machine)

```sh
# PyPI package name is `graphifyy` (double y); the CLI is `graphify`.
pip install graphifyy

# Register the skill with Claude Code (writes ~/.claude/skills/graphify/SKILL.md).
graphify install

# Verify.
graphify --version
```

On Windows, if `graphify` is not found after install, add Python's
`Scripts/` directory to PATH or use `pipx install graphifyy` instead.

## Build the graph for this project

```sh
# From the repo root. AST-only extraction — no LLM needed for code files.
# Takes ~30s on this codebase (~300 files, ~2500 nodes, ~5000 edges).
graphify update .
```

Outputs into `graphify-out/` (gitignored — regenerate per machine):

- `graph.json` — the knowledge graph
- `graph.html` — interactive in-browser visualizer (open in any browser)
- `GRAPH_REPORT.md` — readable summary of clusters + key modules
- `cache/` — per-file extraction cache so subsequent `update` calls are
  incremental

## Use it from Claude Code

After install, the `/graphify` slash command is available:

```
/graphify .                            # rebuild (same as `graphify update .`)
/graphify path "runPhase4" "chunkedGenerate"   # call-chain navigation
/graphify explain src/lib/pipeline.ts          # high-level summary
/graphify query "what depends on RateLimitDialog?"
/graphify affected "completePhase4"            # reverse-traversal — who calls X
/graphify watch .                              # auto-rebuild on file changes
```

`query` does a BFS over the graph and caps the response budget; useful
for cross-cutting "where in the codebase does Y happen" questions that
otherwise need multiple Explore-agent passes.

## When to rebuild

`graphify update .` is incremental — only re-extracts files that changed.
Run it:

- After a substantial refactor that moved or renamed many symbols
- After landing a new top-level feature (e.g. the optional-outputs
  refactor in commit `92b3fdc` or the diagnostic stack in `5552a7d`)
- If `/graphify query` starts returning stale results

For continuous live-rebuild during a feature branch:

```sh
graphify watch .
```

leaves it running in a second terminal; the graph stays current with
every save.

## Why this is dev-only

- Graph artefacts (~5 MB on this codebase) are derived data — committing
  them creates merge noise on every file change.
- The skill writes to `~/.claude/skills/graphify/SKILL.md` (per-user
  Claude Code config), not into the repo.
- No production code depends on it. Removing it does not affect builds,
  tests, or runtime.

## Uninstall

```sh
graphify uninstall            # removes the SKILL.md from ~/.claude/skills/
graphify uninstall --purge    # also deletes graphify-out/
pip uninstall graphifyy
```
