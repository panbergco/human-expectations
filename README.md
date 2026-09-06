# human-expectations

**Your agent should remember what you meant, without making you repeat yourself.**

Human prompts are the scarcest, most expensive signal in an agent system. Long agent runs lose them: requests get buried between tool output and assistant text, half-implemented, or silently dropped — and the human has no ledger of their own asks to hold the system to account.

Human Expectations keeps that ledger: a shared project record of what you asked for, how your intent changed, and what has actually been verified — so “done” means more than someone said it was done.

> **How it runs:** once enabled, bookkeeping rides turns you already started. A small, bounded note is appended to the model input for that request only; the model adds a hidden data block at the end of its normal answer; the extension stores the result and removes the block before it is displayed or saved. It never starts a model request of its own and never adds a turn. The only separate requests are the ones you invoke explicitly (`bootstrap`, `review`).

## What you get

- **Less repetition:** requests and later corrections remain connected to your original words.
- **One project memory:** expectations collected across the project's conversations, not scattered across individual agents.
- **An understandable overview:** a few meaningful outcomes, with the detail underneath.
- **Honest progress:** measured results rather than activity counts or unsupported completion claims.
- **A record you can inspect:** see where an expectation came from, what changed and what remains uncertain.

The intended experience is simple: **notice that the agent remembers, not that another system is running.** No unsolicited reports or extra participant in the conversation.

## What the output looks like

An illustrative overview—not real project measurements:

| What you want | Verified checks | What remains |
|---|---|---|
| A service that recovers unattended | ██████░░░░ 60% · 3/5 | Recovery after a network outage is untested |
| Status you can trust | ████░░░░░░ 40% · 2/5 | Some displayed information is still stale |
| A usable browser interface | ░░░░░░░░░░ Not yet verified | No browser evidence recorded |

The overview links to specific expectations, checkable conditions and supporting evidence. **60% means 3 of 5 defined checks passed—not 60% of the effort or the whole product.** Unreviewed interpretations are labelled provisional. Uncertain authorship is not silently treated as a human requirement.

Your project's report lives at:

```text
.human-expectations/EXPECTATIONS.md
```

Supporting records stay in the same folder, as Markdown: a small live record (expectations, checks, evidence) and a separate source log (your captured words with context), so reports stay fast however long the history grows — measured on a 342-session project: outcome view 62 ms, save 105 ms, 75 MB of sources untouched unless something new arrived. Larger reports can be split into linked sections with your approval; the extension does not scatter them around the project automatically.

## Install — one command

In your project's terminal, run:

```sh
pi install -l git:github.com/panbergco/human-expectations
```

Open a new Pi session in that project to load it. This installs the extension and its bundled skill together. **No separate decomposition skill, database or service to install.** You need Pi with a working model connection and Node 24 or newer.

The `-l` keeps this installation local to the project. Installation does **not** activate automatic processing.

## Activation: your choice, never a surprise

The activation policy is:

- **Off by default:** installing must not start processing every project.
- **Project-only opt-in:** enable it for the project you choose.
- **Global opt-in:** enable it across projects only through an explicit global choice.
- **Project overrides:** a project can remain off even when global activation is on.

```text
/he on            # this project
/he on --global   # every project (still overridable per project)
/he off           # this project, even if global is on
```

Installation availability is not activation. `status` shows the effective setting and where it comes from.

## Using the current release

To inspect an existing project record, ask Pi:

> “Show me my expectations and what is still unverified.”

Or drill down yourself:

```text
/he report            outcomes with progress bars (3–7 lines)
/he report GX-0100    one outcome: its sub-outcomes or expectations
/he report HE-0080    one expectation: its checks, verification dates, your own words
/he status            what is pending, what rode recent turns, last error
```

Levels appear only when a project needs them: a small project lists its expectations directly, a medium one gets outcomes, a large one gets outcomes and sub-outcomes — never more than that. Every verb autocompletes after `/he `, and the same operations exist as a terminal command (`he status`, `he report`, `he collect`, `he on|off`) for scripts and dashboards — the CLI never calls a model.

`/he off` stops automatic processing without deleting the record.

For a deliberate initial history review, `/he bootstrap` recovers recorded inputs, proposes expectations and checks, and organises a large record into a high-level overview. **This explicit pass makes separate model requests and can consume substantial quota on a long history; it only runs when you ask for it.** Without it, history is picked up gradually by your ordinary turns. `/he collect` reads new transcript text without any inference.

What a ridden turn costs: a per-turn budget you set (`/he on --budget 4000`, default 4,000 tokens — the outcome-title index and the batch fit inside it) plus a short hidden output block — on that request only, never as an extra request. Turns already above 80% of the context window are never ridden.

Scraping history does not prove delivery. The agent must check the actual project and record evidence before a check becomes passed. A zero bar after setup means “not verified yet,” not “nothing has been built.”

## Memory must not become stale authority

Remembering an old interpretation is not the same as knowing what you want now. The record must distinguish your original words, the agent's interpretation, and evidence collected at a particular time.

The design rules are:

- A current human correction takes precedence over an older stored interpretation.
- Superseded instructions stay in history, not in the active list of things owed.
- Previously passing evidence is not automatically valid for changed code, scope or circumstances.
- Missing or contradictory evidence is shown as uncertain or needing review—not quietly carried forward as done.
- Reading or rewriting the memory does not reset the age of its supporting evidence.
- Freshness comes from source changes and observations during existing agent work, not additional scheduled model turns.

Every pass carries a derived freshness — **current**, **stale** (a later human statement or a changed obligation), **needs-review** (the human said it is still broken), **historical** (measured on an earlier build) — and only current passes count toward a bar. Freshness is computed from what happened since the observation; reading or rewriting the record never refreshes it. It does not automatically prove that every stored interpretation or old test result remains valid — that needs new evidence from real work.

## Keep your project history private

The `.human-expectations/` folder can contain your original words, contextual excerpts and private evidence. **Keep it out of public Git history.** This release does not automatically modify a target project's Git ignore rules; ensure the folder is ignored before enabling collection or publishing that project.

This public repository contains only reusable code and documentation. Saved test cases, real transcripts and project reports stay in their respective local project folders.

## More detail

- [Bundled method](SKILL.md) — how intent, decomposition, evidence and corrections are handled.
- [Extraction instructions](PROMPT.md) — the rules used to interpret source history.
- [MIT licence](LICENSE).

Local tests cover capture, reconciliation, evidence arithmetic, grouping and isolated Pi operation. They do not establish perfect interpretation, universal platform compatibility or actual completion of the projects being assessed.
