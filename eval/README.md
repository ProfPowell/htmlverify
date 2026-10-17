# Evaluation

Does a check loop make LLM-written HTML predictably good? This harness runs the
briefs of spec §13 under two conditions and measures the results with
htmlverify itself. Condition C, the assembler, comes with M3.

| | Condition |
| --- | --- |
| A | free-form HTML, with the house skills |
| B | the same, plus the htmlverify skill and the `PostToolUse` hook, at most 3 repair rounds |

## Running

```sh
node eval/run.ts run --briefs contact,faq --conditions A,B --runs 3          # agent driver: headless Claude Code
node eval/run.ts run --briefs all --runs 3 --driver human                     # prepare runs for a person
node eval/run.ts score eval/results/<name>                                    # (re)score and summarize
```

Options: `--model` (default `claude-sonnet-5-5`), `--out` (default `eval/results/<timestamp>`), `--parallel` (default 2), `--max-turns` (40), `--timeout` (minutes, 20), `--title`.

Each run gets its own directory, `<out>/<brief>/<condition>-<n>/`:

- `work/`: a fresh project with `brief.md`, the house skills from `eval/skills/` (a snapshot of Vanilla Breeze's `xhtml-author`, `forms`, `patterns`, and `custom-elements` skills at commit `1817856`), and for B the htmlverify skill, config, and hook. The model writes `work/page.html`.
- `prompt.txt`: the prompt, the same in both conditions. It never mentions htmlverify.
- `meta.json`: the driver, the model, the wall time, and how the run ended.
- `agent.json`: Claude Code's JSON result: tokens, cost, turns.
- `hook.jsonl` (B): one line per hook check of `page.html`.
- `score.json`: the measures for this run.

`summary.md` and `summary.json` aggregate the runs by condition.

## Drivers

- **agent**: `claude -p` in the run's `work/` directory, with its own session ID, no saved session, project settings only, no MCP servers, and edits accepted without prompts. In B it may also run `npx htmlverify`, which resolves to this checkout.
- **human**: the harness prepares each run and writes `INSTRUCTIONS.md`. A person opens Claude Code in `work/`, pastes the prompt, lets it finish, and then runs `score`. The driver is recorded in each run's log.

The rubric, blind human raters or an agent judge calibrated against them, isn't part of this harness yet.

## Measures

- **Status on the first attempt**: for B, the first hook check of `page.html`; for A, the final file, since A has no loop.
- **Status at the end**: `page.html` checked with the `strict` profile and the default vocabulary.
- **Repair rounds**: failing hook checks of `page.html`. After 3, the hook stops blocking, and the run is marked capped.
- **Errors per page by family**, from the final check.
- **Checklist**: the brief's semantic expectations, as selectors over the parsed page, such as `form label` or `table > caption`.
- **Structural variance**: the mean pairwise edit distance between the element skeletons (tag names in document order) of runs of the same brief and condition, normalized by the longer skeleton; 0 means identical structure.
- **Tokens, cost, and wall time**, from Claude Code's result.

## Briefs

`briefs/<id>.json` holds 20 briefs, one per page type in spec §13. Each brief has fixed content for a fictional outdoor-gear cooperative, so writing quality isn't a variable, and a checklist of what the page should contain.
