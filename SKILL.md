---
name: human-expectations
description: Recover the human's intended outcomes across a project's sessions, reconcile new requests and changed intent with existing expectations, and validate delivery against measured evidence. Use for expectations, unmet intent, delivery gaps, progress reports, completion percentages, and source-backed corrections. Keep the human view at outcome level, with MECE detail underneath.
---

# Human expectations

## Purpose

Recover and reconcile **what the human meant**, establish **what delivery demonstrably does**, and report **the remaining gap**. A populated ledger, busy agent, commit, new test or completion claim is not itself delivery.

The extension and this skill are one self-contained pi package. No other skill, service, database, model SDK or package is required beyond pi and Node's built-ins. The method below is incorporated in full; do not delegate it to another skill.

## Start with the shared project record

Use the `human_expectations` tool with `action: "status"` or `"report"`. Persistent output belongs exclusively to `<project>/.human-expectations/` and uses **Markdown files only**. `EXPECTATIONS.md` is the human report. Dot-prefixed Markdown files contain internal state/control records in fenced JSON, source text, judgments, checkpoints and model usage; they are not additional reports. Do not directly edit these while the extension is running.

All sessions for the exact project directory share one expectation record. Each cycle discovers transcripts by their header working directory, not just filename similarity. Newly discovered sessions are read in full; already enrolled transcripts are read from their byte checkpoints; unchanged transcripts are skipped. Standard pi storage and the running session's custom storage directory are searched. Other custom session roots require explicit enrollment through a transcript bootstrap. No implicit merge of different working directories, repositories, symlink-mismatched paths or worktrees.

A source link records the immutable session UUID plus entry ID, timestamp and original words. Display names/windows are useful labels, not identity. Preserve first mention, later repetition, correction and verification separately. Never assume the first receiving session owns the work. Fork copies are not additional human requests. Related requirements across sessions become one canonical expectation with several sources.

### Triggers and cost

`/he on [minutes]` opts this project in; `/he on --global` opts every project in; a project-level `off` always wins over a global `on`. Nothing runs until enabled. `/he status` reports the effective setting and its source.

Automatic mode never starts a model request. Background work is mechanical only: native file notifications and observer-only session events mark changes, and a worker thread reads appended transcript bytes at most once per interval (default 30 minutes). Interpretation rides a turn the human already started: a bounded bookkeeping instruction (≤ 6 source inputs / ≤ 12 KB, plus a compact index of known outcome titles) is appended to the tail of the model input for that request only. It is not persisted, it does not change the system prompt or the cached prefix, and the model's answer to the user is unaffected. The model appends one hidden data block at the end of its answer; the extension validates it, stores the result, and strips the block from the transcript and the display. If the model omits or malforms the block, the sources simply stay pending for a later turn — there is no repair request, no retry request, and no follow-up turn. Consolidation into the outcome hierarchy rides a turn the same way when the catalogue is small enough (≤ 40 KB); otherwise it waits for an explicit pass.

The only separate model requests are explicit, user-invoked passes: `/he bootstrap [transcript]` (whole pending history, batched) and `/he review` (one batch). Both say so and record their usage. `/he collect [transcript]` reads sources without any inference. One project-wide lease prevents two sessions from carrying the same batch.

There is **no zero-overhead guarantee**: the ridden turn carries extra input tokens and a short extra output block; static tool/skill definitions occupy prompt space; workers use CPU/memory. Nothing else is touched: no injected turns, no replaced tools/prompts/models/thinking settings, no UI beyond what is explicitly requested.

## Recover the exchange, not an isolated quote

1. Read the input's own words first. It may introduce a genuinely new outcome unrelated to the preceding discussion. Topic similarity is never a condition for capture.
2. Use relevant messages before **and after** it to interpret references, proposals, approvals, misunderstandings and clarifications. Follow parent links, not nearby text on a different conversation branch.
3. Resolve "go", "yes" and numbered choices against the recommendation at that exact moment. Approval of a transient operation is steering, not automatically a durable requirement.
4. If a response has not arrived, context remains pending. Bounded excerpts indicate truncation; read the cited original transcript when that prevents a reliable judgment. A clear standalone new request does not become ambiguous just because its neighbours are unrelated.
5. Later human corrections override an unsupported assistant interpretation. Assistant and bot text can supply context, but never gains human authority or independently proves delivery.

Historical `role: user` is NOT authenticated human authorship. Bots and RPC/terminal automation can create the same role. Explicit locally configured automation prefixes are pattern evidence, not identity proof. Routed/replayed messages remain quarantined until sender attribution is established. Repetition alone is not a bot detector: repeated human complaints are valuable. Classify human-supported, automation-supported and uncertain origin separately; uncertainty must not silently become a human obligation or disappear.

Every input retains a disposition and reason: expectation, approval, steering, noise, framework or needs-context. Source originals remain recoverable. Do not claim complete intent coverage while unprocessed or unattributed inputs remain.

## Reconcile meaning before creating another row

Compare each human-supported input with the project's existing active, delivered and superseded expectations, using intended outcome and scope—not keywords.

- **New outcome:** explain how it differs from the nearest plausible existing expectation, if any; never force an artificial match.
- **Repeat:** retain one stable expectation ID and every original source/date. Do not inflate the denominator or silently deduplicate independent repeated requests.
- **Refinement:** incorporate the new constraint beneath the same human-level outcome while preserving applicable earlier intent.
- **Related but distinct:** cross-reference the relationship without merging separate obligations or double-counting shared work.
- **Reversal:** identify the newer human ruling and what it supersedes; retain the old wording and history. Never let older backfill undo a newer decision. Unclear conflicts remain explicit, pending source-backed reconciliation.
- **Regression:** a human report that claimed delivery is still wrong reopens the relevant evidence for investigation, even if the old test was green.

Record the relationship, cited IDs and reasoning. Quotes must be exact excerpts of the human input; interpretations are labelled separately. Never invent thresholds, owners, deadlines, scope or approval. Tentative ideas remain tentative until adopted.

The automated formulation contract is [PROMPT.md](PROMPT.md) for explicit passes and the condensed in-turn contract in `src/ride.mjs` for ridden turns (same data shape). It cannot set evidence or completion. Compact origin sets expand into per-input provenance mechanically. Missing classifications remain pending and are retried alone; unsupported proposals are quarantined, not granted human authority. Affected human exchanges get one focused intent retry. New model labels are local aliases; the store allocates durable IDs. Structural validation does not certify semantic judgment or identity.

## Decompose for measurement; show outcomes to the human

**Read and decompose first; judge delivery in a separate pass.** The human report is a small set of higher-level outcomes, not a task tracker. Acceptance obligations sit underneath to make the roll-up defensible.

1. Bound the source by explicitly naming all transcript spans and referenced specifications in scope. Open and read them in full. Unopened material is not reviewed coverage.
2. Choose **one cut dimension per level**, usually observable user outcomes. Do not mix components, phases, severity and actors at one level.
3. Give each obligation a stable ID. One verdict must answer it; if one half passes and another fails, split it. A convenient implementation milestone is not a substitute for the intended outcome.
4. Organise meaningful groups of **3–7 members**, nesting larger groups rather than widening indefinitely. Do not pad genuinely tiny expectations. Name groups by their governing conclusion, not "miscellaneous".
5. Reconcile both directions: every in-scope statement maps to an obligation or a deliberate exclusion with a reason; every obligation cites its source. No orphan source or orphan verdict.
6. Check MECE: no duplicated obligations, no mixed cut dimension, no unexplained gaps. Shared implementation may support several outcomes, but the same acceptance obligation has one canonical home and is counted only once.
7. Preserve issued IDs when adding headings or moving detail into files. Parent nodes organise/roll up leaves; they are not extra completed tasks.
8. Mark decomposition reconciled only after an explicit coverage/MECE audit. The helper records that attestation; it cannot prove semantic exhaustiveness. Otherwise all percentages remain provisional.

When intake has no pending inputs, the bundled runtime automatically consolidates a large catalogue into the outcome hierarchy. It reruns only when expectation definitions change, not merely because evidence was recorded. A small catalogue already fits the overview. This step uses `src/consolidation.mjs` from this same package and the existing `structure` validator; it does not invoke a separate skill. Automated grouping is not a semantic completeness attestation.

### Offer a structural split, never split arbitrarily

Start with one `EXPECTATIONS.md`. If detail makes it unwieldy, offer the human a split: a short outcome-level overview linking to coherent detail files beneath the same `.human-expectations/` folder, all `.md`.

File size may prompt the offer, but boundaries follow the decomposition: one cut dimension per level, meaningful 3–7 groups, stable IDs, traceable source coverage and no duplicate ownership. Do not split by line count, arbitrary batches, session ownership or task status when those divide the same expectation. Do not split automatically.

Create/review the hierarchy using `human_expectations` with `action: "structure"`, the latest `revision`, and `structure: {dimension, groups}`. A node is an existing HE-id (a leaf) or `{id: "GX-0001", title: "governing conclusion", dimension: "one child cut dimension", children: [...]}`. Every active expectation must occur exactly once; each internal group holds 3–7 members. New intent that arrives later is visibly unplaced until reconciled; never hide it to preserve an old outline.

After approval, `/he split` materialises the reviewed hierarchy into an overview, linked `GX-*.md` group overviews and `HE-*.md` expectation details. Large unstructured reports refuse a split until the grouping exists. Stable expectation/check IDs do not change. `/he single` restores the full main report. Existing detail files remain as old generated views; do not treat them as competing state.

## Verify: `/he audit`, then record

`/he audit` (a whole outcome, up to 7 expectations) or `/he audit HE-0012` starts a turn in which the agent drives each obligation against the real project — commands, files, the running system, a driven user path — writes an audit file under `.human-expectations/audits/` and records verdicts with the tool. `--project <dir>` audits another project. During ordinary work, an agent that genuinely observed something settling an obligation may report it in the hidden block; it is recorded as an in-turn self-report with its own audit note. Nothing is ever recorded from memory or from transcript claims.

Driving an audit across many outcomes: verify the RECORD changed after each one (new verdicts, a new audit file) before moving on. A finished turn is not evidence that anything was measured — a refused request looks exactly like a quiet one.

## Validate against hard delivery facts

For each acceptance obligation, use ordinary project tools to obtain:
- **Method:** command/query, experiment or actual user journey performed.
- **Scope:** build/commit, environment, surface, dataset and time window.
- **Observation:** measured result or reproducible behaviour, compared with the target.
- **Evidence:** an existing project-local evidence file containing the measured result and its command/tool-result references, checker, source session and observation time; the extension records its SHA-256 fingerprint.

Verdicts are passed, failed, blocked or unknown. Missing evidence is unknown, not automatically false or complete. A commit establishes implementation, not necessarily live behaviour. A green test counts only when its path and instrument answer the human's expectation. When the human's experience contradicts it, investigate the test's blind spot.

Use `human_expectations` with `action: "record"` after actually obtaining the evidence:

```json
{
  "action": "record",
  "update": {
    "revision": 4,
    "expectation": "HE-0001",
    "holder": "actual-builder-session",
    "session": "actual-recording-session",
    "reconciled": true,
    "coverageEvidence": "path/to/source-coverage-audit.md",
    "checks": [{
      "id": "HE-0001.1",
      "verdict": "failed",
      "observed": "18 of 20 samples agree; 2 are stale",
      "method": "Side-by-side observation during streaming",
      "artifact": "path/to/observations.md",
      "scope": "Named build and environment, stated observation window",
      "checkedBy": "actual-checker-session",
      "session": "actual-verification-session"
    }]
  }
}
```

Use the latest revision from `status`; concurrent stale updates are rejected. For historical checks, include `observedAt` on each check with the actual ISO observation time, not today's recording time. The current recording session is captured separately. Older observations cannot overwrite newer ones; simultaneous contradictory verdicts become unknown. No evidence string is executed by this tool. Recorded evidence is an attestation by the caller—not automatic proof that a test ran or that the checker is independent. Name self-checks honestly; follow the project's own independent-review requirements without spawning agents unless authorised. Source inspection uses `action: "source", ref: "session/entry"`.

## Percentages and attribution

**Acceptance coverage = passed active atomic obligations ÷ all active atomic obligations.** Show passed/total, failed/blocked/unknown counts, last check and scope version beside the bar.

- No decomposition means not yet measurable. Unknown/blocked work earns no completion credit.
- An unaudited decomposition means **provisional** coverage, not exhaustive product completion.
- Project totals sum unique active finite-outcome leaves, not an average of parent percentages and never parents plus children.
- Standing expectations show compliance at the last check, separately from finite delivery. A successful sample does not retire a standing rule.
- Scope additions/changes remain in history; changed or challenged checks lose stale credit. Never improve the number by dropping inconvenient requirements.
- Session reporting separates newly passed/recovered checks, lost passing status, unchanged re-verifications and pre-existing project evidence. Use `human_expectations {action:"report",session:"this"}` or an exact/unique-prefix session ID. A session that observed or recorded evidence is not automatically the session that authored the implementation; work attribution needs its own commit/deployment evidence.
- A 3/5 bar means 60% of defined acceptance checks pass—not 60% of effort, time, code or the whole product.

## Report the measured gap

Lead with the intended outcome, a progress bar and one short explanation of what works and what is still owed. Keep atomic rows, original quotes and evidence in supporting detail.

Example (illustrative, not a measurement):

> **Trustworthy live status — ██████░░░░ 60% acceptance coverage (3/5).** One check fails and one is untested. This session recovered one check; two already passed. The remaining failure is stale activity during streaming. Scope and timestamp accompany the evidence.

Always reveal pending input, uncertain origin, unresolved intent, scope changes, verification freshness and extraction failures. Zero expectations with pending sources does not mean nothing owed. Do not turn old measurements into current truth. Separate genuine human decisions from matters already delegated elsewhere.

The inspectable chain is: **human exchange → reconciled outcome → atomic obligation → measured evidence → remaining gap**.

## Privacy and failure boundaries

Project records contain original words and contextual excerpts. They are mode 0600 but are not automatically Git-ignored, because the extension does not modify another tool's Git/configuration files. Before committing or publishing a project, explicitly exclude or sanitise `.human-expectations/`. Never publish raw records or real transcripts as test fixtures.

Only pi and Node built-ins are used. Worker jobs hold short file locks; model reasoning holds a separate project lease, never the file-mutation lock. Crash-left `.review-lock.md`/`.writer-lock.md` files must be removed only after verifying their recorded PID is dead. No automatic stale-lock theft. Errors preserve pending sources; one model-format repair is allowed per batch, not an unbounded retry loop. Use `off` to stop maintenance; shutdown aborts extraction and clears watchers/timers.
