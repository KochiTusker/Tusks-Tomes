# Tusk's Vault

Once you've got a couple of years of chronicles saved, a new problem appears:
you have a genuinely good archive and no way to ask it anything. Someone says
"wait, who was Vellichor the Pale again?" and you're scrolling through
seventeen files trying to remember which session she turned up in.

That's what **[Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault)** is
for — a sibling project that answers questions about your campaign lore in
plain language, in Discord. It's publishing shortly; this page covers how the
two fit together.

They're two halves of the same idea. Tomes records what happened; Vault
remembers it for you. Each works perfectly well on its own — you don't need
Vault to get value from this — but paired, the loop closes.

> **play → record → transcribe (Tomes) → chronicle (Tomes) → ingest as lore (Vault) → query in Discord (Vault)**

> ** Free-tier Gemini key?** Vault is the better home for it. Vault is a single retrieval-augmented query per turn (a few KB of indexed lore in, one citation-grounded paragraph out) — orders of magnitude lower token use than Tomes' six-phase generation pipeline across a 3-hour transcript. A free Gemini quota carries Vault's per-query workload comfortably. Tomes itself requires a paid Gemini key for the main pipeline; a free key in Tomes is optional and routes only to Phase 4 extras under Smart Budget. If you have one key to spend, Vault is where it earns its keep.

<details class="docs-section">
<summary><h2>At a glance</h2></summary>
<div class="docs-section-body">


| Tusk's Tomes (this repo) | Tusk's Vault |
|---|---|
| Records → transcribes → chronicles each session | Indexes the whole campaign and answers questions about it |
| Whisper + 6-phase LLM pipeline | Local semantic retrieval + citation-grounded Discord answers |
| **Output**: Markdown chronicles in `Sessions/<campaign>/...` | **Input**: anything you drop in `Lore/` |
| Use case: "We just finished Session 17, write me a recap" | Use case: "`@Tusk` who is Vellichor the Pale and what did the party last hear about him?" |


</div>
</details>

<details class="docs-section">
<summary><h2>Auto-pairing — how it works</h2></summary>
<div class="docs-section-body">


Drop the repos as **siblings** on disk and they find each other automatically. With Tusk's Lore in the mix the canonical layout is:

```
Documents/
├── Tusks-Tomes/        ← this repo, cloned from github.com/KochiTusker/Tusks-Tomes
├── Tusks-Vault/        ← Vault repo, cloned from github.com/KochiTusker/Tusks-Vault
└── Tusks-Lore/         ← shared lore base — Tomes creates it from Settings → "Create Tusk's Lore"
    ├── tusks-lore.json
    └── Sessions/
        └── <campaign>/
            └── Session-NN-<date>-<full|condensed>.docx
```

Tomes looks for any of these sibling folder names for Vault: `tusks-vault`, `Tusks-Vault`, `tusks_vault`. A directory is recognised as a Vault install if it has both a `Lore/` subdirectory and a `package.json` whose `name` field is `tusks-vault` (case-insensitive). The second check stops random folders named "tusks-vault" from triggering false positives.

For Tusk's Lore the lookup is the same shape: `Tusks-Lore`, `tusks-lore`, `tusks_lore`. The marker is a `tusks-lore.json` file with a version field — written automatically when you click "Create Tusk's Lore" in Settings.

> **About this repo's folder name:** keep this checkout named **`Tusks-Tomes`** (the default `git clone` directory name). The Vault repo's mirror-side detector looks for that exact name as a sibling. Renaming this folder to anything else breaks the Vault-side auto-discovery.

If your repos live somewhere other than as siblings, set `TUSKS_VAULT_DIR` (Vault) and `TUSKS_LORE_DIR` (shared lore folder) in `.env` to absolute paths.


</div>
</details>

<details class="docs-section">
<summary><h2>What you get when paired</h2></summary>
<div class="docs-section-body">


- **From the Tomes side:** Settings → **"Paired with Tusk's Vault"** card shows status. Every finished chronicle has a **Send to Vault** button that pushes it into `<vault>/Lore/Tomes/<campaign>/<file>.md`. Separately, Settings → **"Tusk's Lore — shared lore base"** scaffolds the sibling lore folder and surfaces **Save full .docx** / **Save condensed .docx** buttons on each chronicle that write structured `.docx` files into `<Tusks-Lore>/Sessions/<campaign>/`.
- **From the Vault side:** a **"Paired with Tusk's Tomes"** card on the Knowledge tab listing every chronicle, with one-click bulk import. Vault also reads the shared `Tusks-Lore/` folder as a lore corpus — the same documents Tomes saves into it.

The `Tomes/` prefix inside `Lore/` keeps Tomes-generated chronicles namespaced separately from your hand-written lore documents, so they don't collide. The shared `Tusks-Lore/Sessions/` is the .docx archive both projects converge on.


</div>
</details>

<details class="docs-section">
<summary><h2>The closed-loop pitch</h2></summary>
<div class="docs-section-body">


The reason these two projects exist as a pair: once everything is set up, the recurring per-week work is:

1. Record your session (Craig / YouTube / nothing — your choice).
2. Drop the recording or transcript into Tomes → click **Run** → wait.
3. Click **Send to Vault** when the chronicle finishes.
4. In Discord: `@Tusk` whatever you need to know.

**That's it.** No re-tagging, no re-uploading, no maintaining a separate wiki. The minimum-effort long-run cost of running a campaign archive drops to roughly "one click per session, plus the time the LLM spends thinking."


</div>
</details>

<details class="docs-section">
<summary><h2>Setting up Vault</h2></summary>
<div class="docs-section-body">


See the [Tusk's Vault repo](https://github.com/KochiTusker/Tusks-Vault) for its own setup walkthrough. The TL;DR: clone it next to this one, run its setup, point it at your Discord, done. Same MIT licence, same local-first philosophy, same zero-subscription promise.


</div>
</details>
