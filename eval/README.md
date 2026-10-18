# Evaluation

Does a check loop make LLM-written HTML predictably good, and does assembling
pages from reviewed components do better still? This harness runs the briefs of
spec §13 under three conditions and measures the results with htmlverify itself.

| | Condition |
| --- | --- |
| A | free-form HTML, with the house skills |
| B | the same, plus the htmlverify skill and the `PostToolUse` hook, at most 3 repair rounds |
| C | the house skills, plus the assembler skill and htmlverify's MCP server: the page is assembled from the starter registry's components, at most 3 failing assemblies |

## Running

```sh
node eval/run.ts run --briefs contact,faq --conditions A,B,C --runs 3        # agent driver: headless Claude Code
node eval/run.ts run --briefs all --conditions C --runs 1 --draft            # C before the registry is approved
node eval/run.ts run --briefs all --runs 3 --driver human                     # prepare runs for a person
node eval/run.ts score eval/results/<name>                                    # (re)score and summarize
```

Options: `--conditions` (default `A,B,C`), `--model` (default `claude-sonnet-5-5`), `--out` (default `eval/results/<timestamp>`), `--parallel` (default 2), `--max-turns` (40), `--timeout` (minutes, 20), `--title`, and `--draft`, which lets C assemble unreviewed components with a warning instead of an error.

Each run gets its own directory, `<out>/<brief>/<condition>-<n>/`:

- `work/`: a fresh project with `brief.md` and the house skills from `eval/skills/` (a snapshot of Vanilla Breeze's `xhtml-author`, `forms`, `patterns`, and `custom-elements` skills at commit `1817856`). The copies drop the skills' `allowed-tools` lines: headless Claude Code refuses a skill that grants tools, so without that the skills never load, as in the M1 pilot, and with it each condition keeps the tools the harness gives it. The model writes `work/page.html`.
  - B adds the htmlverify skill, config, and hook.
  - C adds the assembler skill (`assets/claude/assemble/SKILL.md`), the config, and `.mcp.json`, which starts `htmlverify mcp --emit-failed` on the starter registry. Project settings deny the model's own writes to `.html` files, so `page.html` can only come from an assembly. The model writes `work/plan.json`.
- `prompt.txt`: the prompt, the same in every condition. It never mentions htmlverify.
- `meta.json`: the driver, the model, the wall time, how the run ended, and for C whether it drafted.
- `transcript.jsonl`: Claude Code's stream-json transcript, for the failure analysis; `agent.json` is its result: tokens, cost, turns.
- `hook.jsonl` (B): one line per hook check of `page.html`.
- `mcp.jsonl` (C): one line per assembly: its status, the file it wrote, its errors by rule and origin, its HTML nodes, its components, and the plan as sent.
- `score.json`: the measures for this run.

`summary.md` and `summary.json` aggregate the runs by condition. With C, `registry.json` records each component's version, digest, and review status when the runs started.

## Drivers

- **agent**: `claude -p` in the run's `work/` directory, with its own session ID, no saved session, project settings only, no MCP servers but C's, and edits accepted without prompts. In B it may also run `npx htmlverify`, which resolves to this checkout; in C it may call the htmlverify MCP tools.
- **human**: the harness prepares each run and writes `INSTRUCTIONS.md`. A person opens Claude Code in `work/`, approves the project's MCP server in C, pastes the prompt, lets it finish, and then runs `score`. The driver is recorded in each run's log.

The rubric, blind human raters or an agent judge calibrated against them, isn't part of this harness yet.

## Measures

- **Status on the first attempt**: for B, the first hook check of `page.html`; for C, the first assembly; for A, the final file, since A has no loop.
- **Status at the end**: `page.html` checked with the `strict` profile and the default vocabulary. A C run with no passing assembly is scored on its last failing output, `page.failed.html`.
- **Repair rounds**: failing hook checks of `page.html`, or in C failing assemblies. B's hook stops blocking after 3, and the run is marked capped; C's third failing assembly says to stop and report what remains.
- **Errors per page by family**, from the final check.
- **For C**: the HTML nodes in the last assembly (registry gaps), every assembly's errors by origin (plan, composition, component), and whether `page.html` was written some other way than by an assembly.
- **Tool calls refused** by the run's permissions, from Claude Code's result.
- **Checklist**: the brief's semantic expectations, as selectors over the parsed page, such as `form label` or `table > caption`.
- **Structural variance**: the mean pairwise edit distance between the element skeletons (tag names in document order) of runs of the same brief and condition, normalized by the longer skeleton; 0 means identical structure.
- **Tokens, cost, and wall time**, from Claude Code's result.

## Briefs

`briefs/<id>.json` holds 20 briefs, one per page type in spec §13. Each brief has fixed content for a fictional outdoor-gear cooperative, so writing quality isn't a variable, and a checklist of what the page should contain.
