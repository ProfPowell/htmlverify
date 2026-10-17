# Pilot: conditions A and B

Run on 2026-10-17 with the harness at commit `0b5d79c`: five briefs (article, contact, data-report, faq, product-detail), two runs per condition, the agent driver, and `claude-sonnet-5-5`. `summary.md` has the numbers, and each run's directory has its page, hook log, and Claude Code result.

This is a pilot: 10 runs per condition, enough to test the harness and see the direction, not to decide anything (spec §13 calls for 20 briefs × 3 runs).

## Results

| | A: free-form | B: with the check loop |
| --- | --- | --- |
| Pass `strict` on the first attempt | 0 of 10 | 3 of 10 |
| Pass `strict` at the end | 0 of 10 | 10 of 10 |
| Pass `standard` (conformance)¹ | 10 of 10 | 10 of 10 |
| Errors per page (`strict`) | 7.1 | 0 |
| Checklist met | 95% | 97% |
| Structural variance | 0.25 | 0.13 |
| Cost and wall time per page | $0.08, 18 s | $0.14, 27 s |

¹ With the house boolean form (`required="true"`) noted rather than counted, since HTML itself allows only `""` or the attribute name.

## What the loop changes

- **Conformance was never the problem.** Every page in both conditions is valid HTML: the model writes conforming markup on its own. The loop's value is everything past conformance.
- **House style, policy, and vocabulary.** A's 71 errors break down as:
  - 19 bare boolean attributes.
  - 12 void elements written `<br/>`.
  - 11 `div`s.
  - 13 invented custom elements in one FAQ: `faq-list`, `faq-question`, `faq-answer`.
  - 8 `href="#"` placeholders.
  - 8 uppercase doctypes.
  
  B's final pages have none of these.
- **Consistency.** B's runs of a brief are about twice as alike as A's (variance 0.13 against 0.25): the rules narrow the ways to write the same page.
- **Cost.** The loop costs about 1.7 times as much (1.4 times the output tokens) and takes 1.5 times the wall time: one repair round on most pages.

## Caveats

- **The house skills disagree with the config**, as spec §10.4 says. `xhtml-author` prescribes `<br/>` and `checked=""`, while the config wants `<br />` and `="true"`. That disagreement explains 31 of A's 71 errors. Fixing the skills, which §10.4 asks for, would make A look better on `strict`, though not on the `div`s, placeholders, or invented elements.
- **The skill isn't always followed.** It asks for `<!doctype html>`, yet 8 of 10 A pages used `<!DOCTYPE html>`. Headless runs may not load a skill unless the model reaches for it.
- **Failing checks overcount repairs.** The hook checks every edit, and the model sometimes fixes one finding per edit. In contact B-1, that made 7 failing checks in 9 seconds. The cap of 3 then stopped the feedback partway through a repair, though the page still passed.
- **One brief was ambiguous.** It named four product photos without files. Both B runs left the photos out, and so did one A run, which cost each of them a checklist item.
- **No rubric scores yet.** The semantics, accessibility, and leanness ratings of spec §13 need human raters or a calibrated agent judge.

## Next

- The full matrix: 20 briefs × 3 runs × A and B, about 120 runs, roughly $13 and 25 minutes at `--parallel 4`, with `node eval/run.ts run --briefs all --runs 3 --parallel 4`.
- The same matrix after the house skills agree with the config.
- The rubric.
