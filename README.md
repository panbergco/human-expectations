# human-expectations

**Your agent should remember what you meant, without making you repeat yourself.**

Long projects span many conversations. Requests get forgotten, corrections get lost, and “done” can mean little more than someone said it was done. Human Expectations keeps a shared project record of what you asked for, how your intent changed, and what has actually been verified.

> **Early release:** history recovery, expectation records and outcome grouping are available. The fully invisible mode—reconciling inside already-running agent work without separate model requests—is still being completed. Automatic review is off by default; keep it off until that mode is ready. Current manual history reviews make additional model requests.

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

Supporting records stay in the same folder, as Markdown. Larger reports can be split into linked sections with your approval; the extension does not scatter them around the project automatically.

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

**Release status:** project-level controls exist; global activation and the invisible in-turn processing path are not yet complete. Global installation availability is not the same as global activation. For now, leave automatic processing off.

## Using the current release

To inspect an existing project record, ask Pi:

> “Show me my expectations and what is still unverified.”

Or use `/human-expectations report` directly. `/human-expectations status` shows whether history is still pending and whether the last review encountered a problem. `/human-expectations off` stops automatic processing without deleting the record.

For a deliberate initial history review, `/human-expectations bootstrap` recovers recorded inputs, proposes expectations and checks, and organises a large record into a high-level overview. **This current review path uses additional model requests and can consume substantial quota on a long history. It is not yet the invisible mode described above.**

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

These are acceptance requirements for the invisible mode still being completed. The current release preserves source references, corrections and observation timestamps, but does not automatically prove that every stored interpretation or old test result remains valid.

## Keep your project history private

The `.human-expectations/` folder can contain your original words, contextual excerpts and private evidence. **Keep it out of public Git history.** This release does not automatically modify a target project's Git ignore rules; ensure the folder is ignored before enabling collection or publishing that project.

This public repository contains only reusable code and documentation. Saved test cases, real transcripts and project reports stay in their respective local project folders.

## More detail

- [Bundled method](SKILL.md) — how intent, decomposition, evidence and corrections are handled.
- [Extraction instructions](PROMPT.md) — the rules used to interpret source history.
- [MIT licence](LICENSE).

Local tests cover capture, reconciliation, evidence arithmetic, grouping and isolated Pi operation. They do not establish perfect interpretation, universal platform compatibility or actual completion of the projects being assessed.
