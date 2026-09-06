# human-expectations

A self-contained **pi extension + skill** that reconciles human intent with measurable delivery across a project's sessions.

**Decomposition is included in this package.** Its source-to-obligation method, MECE rules, hierarchy validation and progress roll-ups live here; installing or invoking a separate `decompose` skill is not required.

**Initial setup:** bootstrap extracts expectations and proposed acceptance checks, then automatically consolidates a large record into a nested 3–7-outcome overview using the method bundled here. Subsequent completed intake cycles reconsolidate when the expectation catalogue changes. Structural validation enforces unique, exhaustive membership; semantic coverage and actual delivery still require evidence-backed review. No files are split automatically.

The human view is a small set of higher-level outcomes with progress bars. Atomic checks, source exchanges and evidence support the roll-up; they are not a task list the human must read.

```text
Trustworthy live status   ██████░░░░  60% acceptance coverage (3/5)
One check fails; one is untested. Last checked on the stated build/time window.
```

*Illustration only. Percentages are calculated from recorded checks, never estimated effort.*

## Install

```sh
pi install git:github.com/panbergco/human-expectations
```

Or try a local checkout without editing settings:

```sh
pi -e /path/to/human-expectations/extensions/index.ts \
   --skill /path/to/human-expectations/SKILL.md
```

Requires pi's current extension/model-registry APIs and Node 24+. Tested against pi 0.84.2 and Node 26 on Linux. Imports only Node built-ins and packages already supplied by pi; no database, embeddings, external service, Python runtime or additional skill dependency. A model provider configured in pi is required for semantic extraction.

## Commands

| Command | Effect |
|---|---|
| `/human-expectations on [minutes]` | Enable project maintenance; default 30 minutes. |
| `/human-expectations off` | Stop automatic updates; keep the record. |
| `/human-expectations status` | Intake, pending/unresolved inputs, model usage and last error. |
| `/human-expectations bootstrap [transcript]` | Rebuild from complete history and drain pending batches; an explicit path restricts a proof run to that transcript. |
| `/human-expectations review` | Review one pending batch now. |
| `/human-expectations report [session-id\|this]` | Show the project overview, or source/verification activity for one session (not implementation credit). |
| `/human-expectations split` | After human approval, create a structural overview and linked detail files. |
| `/human-expectations single` | Restore the full main report; previously generated detail views remain. |

The `human_expectations` tool supports report, status, source lookup, one-batch review, evidence recording and a reviewed MECE hierarchy. See [SKILL.md](SKILL.md) for the method and argument examples. `--he-project /path/to/project` explicitly selects another project for an isolated proof run; it does not steer that project's running sessions.

Automatic review starts **off**. Enabling is project-local. It sends bounded source batches to the selected pi provider, so it can consume subscription quota or API spend. A first historical bootstrap can take substantially longer and cost more than a normal incremental cycle.

## Triggers—not a constant agent loop

1. Filesystem notifications and observer-only session events mark possible changes.
2. One deferred callback waits until the interval is due **and** the foreground agent is idle.
3. A busy session is not polled; `agent_settled` supplies the next opportunity. Resuming after days catches up once.
4. Each cycle discovers all matching project transcripts. New files are read in full; known files use byte checkpoints; unchanged files are skipped.
5. One project-wide lease admits the reviewer. File updates use short locks and pi's mutation queue; no file lock is held while the model reasons.
6. If no unreviewed candidate input remains, there is no extraction request. Known local automation templates bypass inference. Unrecognised bot traffic may still need classification.
7. Foreground activity cancels/defer background extraction. Closing/reloading clears watchers and the deferred callback; pending sources survive.

There is no always-running daemon. A skill alone cannot guarantee a schedule; the bundled extension provides these triggers while pi is open. Platforms/paths that cannot be watched rely on session events and resume. Normal cycles process bounded batches rather than silently creating an unlimited backlog-draining job.

**No zero-overhead claim:** registering the tool/skill adds static prompt metadata; workers consume CPU/memory; model calls consume quota. Parsing and file processing run in worker threads, not the foreground event loop. The extension does not inject maintenance turns, replace tools, mutate inputs, alter system prompts/model selection/compaction, or replace the editor/footer. Automatic work has no unsolicited UI output. Reports appear on request.

The separate model-registry requests do **not** invoke foreground provider-request hooks. Leave automatic review off if a deployment depends on such hooks to enforce every request's policy. Coexistence is not quota isolation.

## One project directory, Markdown only

```text
project/
  .human-expectations/
    EXPECTATIONS.md       # main human-readable report
    HE-0001.md            # optional expectation detail after a split
    GX-0001.md            # optional structural group overview
    .STATE.md             # canonical internal record in fenced JSON
    .CONTROL.md           # opt-in cadence and local automation prefixes
    .STATUS.md            # compact machine-readable status in Markdown
    .REJECTED.md          # last rejected model result, if any
```

Internal records preserve full original user-role text, source/session IDs, nearby before/after context, classifications, stable expectation/check IDs, recorded evidence, source changes and usage. They are Markdown containers, not a second independent report. Generated views are rebuilt from the canonical record; do not hand-edit them.

A split is **offered**, never automatically chosen. Its boundaries follow the MECE hierarchy—not arbitrary line counts, timestamps or session ownership. One dimension per level; meaningful 3–7-member groups; every active expectation has one canonical home; stable IDs survive regrouping. The tool validates references, group sizes and exhaustive membership. Semantic completeness still needs source review.

New expectations not yet placed in an existing hierarchy are shown explicitly as awaiting structural reconciliation. They never disappear because the old outline lacks a place for them.

Project scope uses canonical exact working-directory matches. Different working directories/worktrees are not silently merged. Standard pi session storage and the current session's custom storage directory are searched; additional custom sources can be bootstrapped explicitly. A first load does not impose a recent-history cutoff.

## Human origin and contextual meaning

`role: user` is not proof of human authorship. RPC, scripts and terminal automation can generate the same role. The extension retains three distinct outcomes:

- **Human-supported:** a contextual interpretation supported as human input, not authenticated identity.
- **Automation:** explicitly configured automation templates or model-classified framework traffic.
- **Uncertain:** routed/replayed or otherwise ambiguous authorship/context; not human authority.

Repeated wording alone is not a bot filter. Copied fork entries do not inflate repeated-ask counts. Every source keeps its full session UUID/entry reference even when compact batch-local references are used for inference. Grouped classifications expand back to one disposition per input, with exact coverage checks.

Before/after excerpts follow parent relationships and stop at the next user input. Original transcripts remain the deeper source when excerpts are truncated or an older branch cannot be reconstructed from bounded persisted context. Images are flagged, not silently interpreted. A response that arrives later can complete a pending exchange.

A genuinely new request is not forced into the current topic. New input is compared with existing outcomes by meaning, constraints and intended user experience. Repetition/refinement retains identity; related-but-distinct work is cross-referenced; regressions invalidate stale credit; unsupported assistant interpretations do not gain human authority.

Extraction uses the local [PROMPT.md](PROMPT.md) and a structured data-return schema. The model is not given executable project tools. Normal batches are capped by input count/bytes; bootstrap uses larger but bounded batches. Compact origin sets and sparse expectation patches avoid repeating bookkeeping for every input. At most one format repair is attempted per batch. Duplicate/unknown source references are refused. Valid partial classifications are retained, with omitted inputs retried alone. Unsupported authority or incomplete definitions are quarantined outside human expectations; affected human exchanges get one focused intent retry rather than repeatedly resending a whole batch. Nothing unclassified is silently marked complete.

## What a progress bar means

**Passed active acceptance obligations / all active acceptance obligations.** Always shown as `passed/total` with scope and freshness in the evidence.

- Unknown, blocked and in-progress work earns no completion credit.
- An unaudited decomposition is **provisional**, not exhaustive product completion.
- Parent percentages roll up unique leaves; parents are not additional tasks. Mixed groups report finite outcomes separately from standing compliance.
- Standing standards remain applicable after a successful check.
- A new/changed/challenged obligation loses stale evidence credit; history remains.
- The session that recorded evidence is not automatically the session that authored the work.

**Extraction never marks delivery passed.** The working agent must obtain real observations and call the evidence-recording tool with method, measured result, build/environment/time scope, artifact, checker and session. Evidence must be an existing project-local file; its SHA-256 fingerprint is recorded. An optional observation timestamp distinguishes historical evidence from recording time; older imports cannot overwrite newer observations, and conflicting simultaneous verdicts become unknown. Recording an attestation/file fingerprint is not proof that the check ran correctly or that an observer was independent. The extension executes no evidence command strings and does not periodically re-run project tests on its own.

A zero bar after bootstrap means **no accepted measurement has been recorded**, not “the project has delivered nothing”. The source-to-outcome interpretation must also be reviewed before claiming completeness.

## Privacy and publication

Real transcripts and project reports must **never** be published as repository fixtures. The public repository contains reusable implementation and documentation only; test cases and validation artifacts remain in their respective local project folders. Generated files use private file permissions, but the extension does not change Git configuration or create a non-Markdown `.gitignore` in the report directory. Explicitly exclude or sanitise `.human-expectations/` before committing a target project.

Model-reported usage is recorded separately from the foreground pi totals. Failed/aborted requests without returned usage may incur unreported cost; this is not an invoice. There is no cumulative spending cap in this first version. Use `off` to stop further maintenance.

A crash can leave a `.review-lock.md` or `.writer-lock.md`. Check its recorded PID is dead before removing only that lock. Locks are not silently stolen. Corrupt records fail visibly rather than resetting to empty.

## Validation and limits

```sh
npm run check
```

This runs syntax checks on the main entry points, not a behavioural test suite.

Local validation covered intake, project isolation, forks, surrounding context, automation ambiguity, partial retries, evidence arithmetic, historical observations, hierarchy roll-ups, writer coordination and Markdown persistence. Isolated real-pi exercises covered background extraction, an independent input observer, report rendering and discovery of a sibling transcript while a batch was in flight. Test cases and artifacts are not distributed in the public repository.

These checks do not certify semantic completeness, every provider/platform, or the actual delivery of any project being assessed. Extracted interpretations and acceptance scopes still require review; delivery needs measured evidence.
