# Changelog

What changed between versions. The rest of the documentation describes how the
current version works and does not carry version history — if you want to know
what something used to do, this is the page for it.

## 2026-11 — Runs that finish what they start

**Version 2.8.0: pick up where a run stopped, edit a chronicle, and
documentation with drawings.** The updater asks you to run `npm install` once
after it pulls this version, because Vite and the test tools are on their
current releases.

**Continue a run after the page closes.** If the page closes or reloads
mid-run, the **Run interrupted** screen offers **Continue from** the step it
reached. It skips the steps that finished and runs only the outputs that are
still missing, without a second entry in Saved Chronicles. **Start again from
Phase 1** and **Reset** are still there.

**Edit a chronicle.** An **Edit** button beside the chronicle, in the result
view and in a chronicle opened from **Saved Chronicles**, turns the prose into a
text box with **Save** and **Cancel**. Saving updates your saved copy and, from
the result view, the Markdown file in your campaign's sessions folder. Both
Markdown downloads give the same file.

**Chronicle files take your campaign's name.** The Markdown copy in
`Sessions/<campaign>/` is named `<campaign> - Session N.md`. Files already on
disk keep their names.

**A warning before browser storage fills up.** When browser storage passes 90%
of its usual limit, a notice says so once per page load and offers the same
backup download as the storage-full message.

**Choose whether the model list keeps itself up to date.** New models and price
changes reach the cost estimates and the model picker without you doing
anything: the app checks OpenRouter's public lists at most once a day. Untick
**Keep the model list up to date automatically** in the Model lists strip under
**Settings → Providers & models** to keep using the saved lists until you press
**Re-check**.

**Claude Code phases run on the prompt alone.** A phase gives the same result
whatever is set up in your own Claude Code; its personal settings, MCP servers
and slash commands play no part.

**The app's typefaces come with it.** Headings and text appear in their
intended faces offline and on the very first load.

**Keys kept by uninstall work after a reinstall.** `npm run uninstall` keeps
your keys unless you pass `--purge-user-data`, and they now open again once you
reinstall.

**Setup checks the ffmpeg download.** If npm skipped it, setup says how to fetch
it, so audio import does not fail later.

**Condense is now Phase 5.** Polish, which does not run today, is numbered 3.5,
between Chronicle and Extras where it would run, so the numbers count the passes
that do run. Saved settings and routing are unaffected.

**Drawings in the documentation and the Help tab.** 25 hand-drawn diagrams
explain the pipeline, the ways in, routing, pausing and resuming, and where
files live, and the Help tab now shows them as GitHub and the docs site do. The
documentation was checked page by page against the app, and the security
overview opens with a plain-English list of known risks and what you can do
about each.

**Version 2.7.0 needs Node.js 22.** Earlier releases run on Node.js 20; from
2.7.0 the app needs Node 22 or newer. Setup refuses an older Node. An install
that is already set up still starts on one, but warns with the install command
at every start, and the updater says so after it pulls, until you upgrade. The
[installation guide](../getting-started/installation.md) has the steps.

**A finished transcription says so.** When every track of a recording has been
transcribed, the transcript panel now reads **Transcription finished**, with how
many tracks were transcribed and what to press next, instead of leaving a
progress bar at 100%.

**Saving from two tabs at once no longer fails on Windows.** With Tomes open in
two tabs, a chronicle saved from both at the same moment could now and then be
refused by Windows, which showed as an error in the browser console. A save that
is briefly refused is now retried. Nothing was lost either way.

**Current Gemini and OpenAI libraries.** The Gemini and OpenAI connections, and
the libraries that handle uploads and web requests, are on their current
releases. Runs behave as before. Because the dependencies changed, the updater
asks you to run `npm install` once after it pulls this version.

**The Help pages describe the app as it is.** Pages that still mentioned an
Upload tab, a **Test connection** button or old file locations now match the
current app.

**Under the hood.** The code is organised by feature, duplicated code is merged
and code nothing used is gone. Nothing changes on screen, and the settings,
chronicles and sessions saved by earlier versions load as they did. Six local
server endpoints that the app itself never called were removed with it:
`POST /api/parse/pdf`, `POST /api/diagnostics/clear-ring`,
`POST /api/lore/index/rebuild`, `GET /api/obsidian/preview`,
`GET /api/sessions/:id` and `POST /api/local/list-models`.

**A stopped Reforge keeps its work.** When a Reforge stops part-way — a
provider out of credits, a model error, or **Cancel** — the chunks it finished
are kept. The panel says what stopped it, what was kept and what a resume will
still run, and **Resume Reforge** carries on from that point on the same
models.

**The condensed recap no longer drops part of the session.** A Condense chunk
whose answer could not be read used to be skipped without a word, so the
Condensed and Recap tabs could begin partway through the session. Slightly
malformed answers are now recovered, an unreadable chunk is re-run once, and
if it still fails the phase stops and says so rather than returning a recap
with a gap in it.

**Audit questions survive on Claude Code.** A short, valid answer — a handful
of DM questions, or none — was being read as a refusal, which left Claude Code
runs with no DM questions at all. An answer that parses as the expected JSON
now counts as an answer, however short.

**Paid OpenRouter models run at full speed.** They were waiting about a minute
before every chunk after the first; they now pause only when OpenRouter asks
them to.

**Claude Code's model list stays current.** New Claude releases appear in the
picker without an update, models chosen from the OpenRouter catalogue are no
longer flagged as possible typos, and a failed Claude Code call shows the
CLI's own reason, with a sign-in hint when the login has expired.

**Model lists say when they were last checked.** **Customise phases** now
shows when the Gemini key test last ran and when the OpenRouter catalogue was
last fetched, with a button beside each to check again. The catalogue row
covers Claude Code too, since its model list is drawn from the same
catalogue. A check that gets no answer says so and keeps the list it had,
rather than reporting an update.

**Your own models are no longer buried in the picker.** Recommended now opens
on its top six with the rest one click away, so the Gemini key, Claude Code
and Codex folders sit just below it rather than under hundreds of OpenRouter
models, and the picker opens on the folder holding the model already chosen.

**A running Reforge stays in sight.** Collapsing the panel used to hide a run
without a trace; the header now shows that it is running, the current step and
its progress, and the panel opens itself when a run starts.

## 2026-09 — Reforge picks a model per phase, and a letter means one thing

**Reforge chooses a model per phase, from the whole catalogue.** Chronicle,
Extras and Condense can each run on their own model, graded for that phase
rather than for the run as a whole, and the finished result lands on the
Chronicle screen as the chronicle on show. Phases you kept are carried over
exactly as they were.

**The lore now reaches Audit, Chronicle and Extras.** Only Ground used to see
the Knowledge Base, so the audit was weighing candidates against canon it
could not read, and the narrator had no way to put right what the table had
said wrongly about a character. Audit and Extras take the compact form;
Chronicle takes the full text in its cacheable prefix, narrowed by retrieval
when it would not fit the model's window. The cost estimate and the structural
check both account for it.

**A letter grade is capability, and nothing else.** A grade used to be quality
passed through a cost rule, so a cheap model could gain a step and the
strongest model in the catalogue read as middling. The letter now says how
well a model did; cost is a column beside it, and "quality per dollar" is a
sort the picker offers against today's prices. The Ground rubric is written
down as thresholds, so a run scores the same way next year.

**Most models carry a prediction.** Where nothing has been measured, a grade
is inferred from a model's purpose, its declared size, or how its own line has
scored, and drawn dashed so it can never be mistaken for a run. A measurement
of the same line and size outranks a prediction, and a prediction never hides
a model from the default list.

**The routing dropdowns start shorter.** Models measured poorly, models
declaring fewer than 10B parameters, and free models are held back behind a
single tick, with the same note about what free models cost instead of money
wherever the tick applies — the Reforge picker included.

**A tab switch no longer throws work away.** An in-flight run keeps running
when you leave the Chronicle tab, and a routing change you have not saved is
still there when you come back to Settings. If the routing was changed
elsewhere in the meantime, by the setup wizard or a fallback, the unsaved edit
is dropped rather than restored over it, and says so.

**Saving a route accepts every configured connection.** A per-phase route
pointing at Claude Code, Codex or OpenRouter was rejected on save; each is
accepted now.

**A transcription stays in view.** Leaving the Sessions tab while Whisper
worked used to drop the upload panel back to an empty dropzone with no way
back into the running transcript; the panel now stays mounted across tab
switches, remembers the session across a reload, and every session in the
list has a *View transcript* toggle, whether it is running or finished. A
reforge finishing no longer pulls you off whatever tab you were on; it offers
the switch instead. A chronicle run interrupted by a reload says so, with
the resume banner where the checkpoint is.

**You can tell slow from stuck.** The transcription view shows how much of
the audio is done in hours and minutes, which speaker track is in progress
and when it started, the rate against real time and an estimate of what is
left, and which engine and device are doing the work. A counter shows when
the server last reported progress; it turns amber after a minute of silence
with a note that long tracks take several minutes, and red only after far
longer than a track has been taking. A run the server lost to a restart says
it was interrupted rather than sitting at zero for ever.

**The app answers as soon as it starts.** The port is bound first and a
numbered list of start-up steps prints with elapsed times, ending in a READY
line. Opening the address early shows a starting page that names the current
step and turns into the app on its own, and the launchers open the browser on
READY instead of on a timer, so the first start after an update no longer
lands on a connection error.

**Whisper reports the device it actually ran on**, and the model load no
longer counts against the request timeout on a first-run download. A machine
without a working GPU pays for that discovery once, then runs every track on
a CPU engine that stays loaded instead of reloading the model per track. The
whisper.cpp bridge is used as soon as its binary and model check out, with no
separate install step. The speed figures in the documentation now match what
a mid-range NVIDIA card measures: about ten minutes per hour of session with
five or six speaker tracks.

## 2026-08 — OpenRouter, and a smaller set of things to configure

**One key reaches around 400 models.** OpenRouter is now a first-class
connection. Any model in its catalogue can be assigned to any phase, and the
model picker is populated from the public catalogue before you have pasted a key
at all.

**The direct Anthropic and OpenAI key slots were retired.** OpenRouter fronts
both vendors at pass-through rates — the same models, the same prices, reached
with one key. Three keys bought nothing over two except more to configure, two
more adapters to keep current as vendor SDKs move, and two more rate-limit
header formats to parse. Routing that names a retired provider is rewritten on
read to the same model in the OpenRouter namespace, matched by model and never
swapped for something cheaper, and the change is logged rather than made
silently.

**Gemini stays a separate, direct connection.** It is measurably cheaper direct
— the same Pro model lists roughly a fifth dearer through OpenRouter — and the
only generation that collapsed into a repetition loop during the comparison was
Gemini routed through OpenRouter, while the same model on the direct key was
clean on identical input. The cause was not content filtering: a deliberately
graphic passage sent three ways produced identical uncensored output on all
three.

**Six of the seven optional modules stopped being installations.** Their install
step only ever wrote a marker file and then asked for a server restart —
install-shaped ceremony for code that already shipped in the bundle. Only Audio
Transcription installs anything now. Whether one of the others is *usable* is a
detection question its own status row answers.

**Uninstalling Personas can no longer delete your work.** The old uninstall
removed `personas.json`, the file holding personas you had written yourself.
Personas is built in now and has no uninstall path, so that way of losing your
own authoring is gone by construction rather than by remembering not to click
the button.

**Routing became one surface.** It had been split across a model profiles
editor, a hybrid routing panel and two generations of preset buttons. It is now
a single list of phases with a ladder of complete presets above it, and the
per-phase detail one disclosure deep.

**Run-start provider selection was removed.** Choosing a provider at the moment
you press Run asked the question at the point of least context. A banner above
the Chronicle controls now states which connection the next run will use.

**Cost estimates were recalibrated against real billing.** Thinking tokens bill
at the output rate, and on the chronicle phase they run near the model's
ceiling on every call — none of which was being counted. Two real bills put the
old estimate at roughly a fifth of actual. The estimator now accounts for them,
so the figures it shows are several times higher than before and considerably
closer to the truth.

## 2026-08 — Documentation

**Reorganised by what a reader is trying to do.** Pages sit on shelves —
getting started, bringing a session in, writing the chronicle, models and cost,
extras, settings, privacy, troubleshooting — and are named for the task rather
than for the file. Every previously published URL still resolves; the site
emits a forwarding page at each old path.

**Costs are generated, not typed.** Every publish prices each routing against
the live OpenRouter catalogue using the same estimator the app shows before a
run, so a model getting cheaper updates the docs without anyone editing them.

**Emoji were replaced by colour.** Red marks a warning, orange a notice, green
something that got simpler. Sections render open rather than collapsed.

## Earlier

Version history before this point was not kept separately; the
[roadmap](roadmap.md) records what shipped and when.
