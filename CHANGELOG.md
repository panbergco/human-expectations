# Changelog

## 0.2.0 — 2026-09-07

- Bookkeeping rides turns you already started; it never starts a model request of its own (probe + real providers).
- `/he` (alias `/human-expectations`) with autocompleting verbs; `--project <dir>` on every verb; standalone `he` CLI for the mechanical verbs.
- Activation is opt-in per project or global; the first `/he on` asks which history to include (none / this session / full).
- `/he report` drill-down: outcomes → sub-outcomes → expectation → checks, at most three grouping levels; `/he report recheck` lists passes that no longer count.
- `/he audit [id]`: a user-invoked turn that drives the checks against the project and records evidence with scope, build and observation time.
- Evidence freshness (current / stale / needs-review / historical); only current passes count; rewording keeps evidence, changing an obligation loses it.
- `/he bootstrap --estimate`, confirmation before spending, live `.human-expectations/BACKFILL.md` ledger, status-line progress, related-detail index (~57% smaller requests).
- `/he tidy`: proposed merges of duplicate outcomes and splits of compound checks, applied only after approval.
- Split storage: small live record + separate source log; readers skip sources (drill 62 ms, save 105 ms on a 342-session project).
- Per-turn ride budget (`/he on --budget 4000`); no rides above 80% context; warning when the record folder is not Git-ignored.

## 0.1.0 — 2026-09-06

- First public release: history intake, expectation extraction, outcome grouping, Markdown record, MIT licence.
