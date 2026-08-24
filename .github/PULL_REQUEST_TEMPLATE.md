<!--
Thanks for opening a PR! For larger changes (new provider, new ingest
format, new pipeline phase), it helps to sketch the idea in an issue
or via the feedback form first — saves you wasted effort if the design
lands somewhere unexpected.
Feedback form: https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header
A community Discord with a #dev-talk channel is on the roadmap (see ROADMAP.md).
-->

## What this changes

<!-- One or two sentences. What does the diff do? -->

## Why

<!-- The motivation. Bug fix? Roadmap item? Feedback-form request?
     Link the issue / PR / form-response summary if there is one. -->

Fixes #

## How to test

<!-- The exact steps a reviewer should run to verify this works.
     If you added new behaviour, name the scenario it unblocks. -->

- [ ]
- [ ]
- [ ]

## Pre-flight checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds
- [ ] If this touches the Whisper sidecar: tested on CPU and (if possible) GPU
- [ ] If this adds a new LLM provider or pipeline phase: README/architecture.md updated
- [ ] If this touches the encrypted keystore or `.env`: SECURITY-relevant changes called out below
- [ ] Manual smoke test in the dashboard (the affected tab / flow)

## Anything reviewers should know

<!-- Trade-offs, follow-ups, anything you ran out of time for. -->
