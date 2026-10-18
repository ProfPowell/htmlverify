# Pilot: condition C, and A, B, and C side by side

Run on 2026-10-18 with the agent driver and `claude-sonnet-5-5`, one run per brief, on all 20 briefs, from commit `32b2a6d`. No starter component is approved yet, so C ran with `--draft`: each component it used gave a warning, never an error. The full run of spec §13 needs the approvals first.

- This directory: A, B, and C on the same harness, once the house skills could load (see below).
- `../2026-10-18-pilot-c-before/`: C with the starter registry as merged in #13 (28 components).
- `../2026-10-18-pilot-c-after/`: C after the fixes those runs led to (37 components), before the house skills could load.

One run per brief shows direction, not variance: structural variance needs at least two runs of a brief, and there are no rubric scores yet.

## Results

| | A: free-form | B: with the check loop | C: assembled |
| --- | --- | --- | --- |
| Pass `strict` on the first attempt | 0 of 20 | 0 of 20 | 20 of 20 |
| Pass `strict` at the end | 0 of 20 | 20 of 20 | 20 of 20 |
| Pass `standard` (conformance)¹ | 19 of 20 | 20 of 20 | 20 of 20 |
| Median repair rounds | – | 1 | 0 |
| Errors per page (`strict`) | 9.9 | 0 | 0 |
| HTML nodes per page (registry gaps) | – | – | 0.3 |
| Checklist met | 96% | 99% | 94% |
| Cost and wall time per page | $0.10, 17 s | $0.10, 21 s | $0.09, 19 s |

¹ With the house boolean form (`required="true"`) noted rather than counted.

- **C passed every page on its first assembly**, so it never needed the loop. B passed every page in the end, but none on its first write.
- **The house skills now load, and they make A and B worse on `strict`.** `xhtml-author` loaded in all 40 A and B runs. It prescribes `<br/>` and `checked=""` where the config wants `<br />` and `="true"` (spec §10.4), so on the M1 pilot's five briefs A's style errors rose from 3.9 a page to 7.6, and every B page needed a repair round, where the M1 pilot's B passed 3 of 10 at once. C writes no markup, so it loaded only its own skill.
- **C's lower checklist score is the photos.** Five of C's seven misses are photos that the briefs describe but give no file for. A and B made up paths and sizes, such as `/img/ridgeline-40.jpg` at 320 × 320. C declined to: its image components need a real source and size, and its skill says not to invent content. The other two misses, `time` in the about page and `address` in the event page, A missed too.
- **C's six HTML nodes are all buttons**: five that the briefs give nothing to do, such as "Rent now", "Save to wishlist", and "Cancel membership", and a form's reset button. Nothing in the registry writes a button without an action, which is right; a reset button could become part of `action/submit`.

Against §13's decision, provisionally: C passes on at least 90% of runs (100%) with a median of at most 1 repair round (0). Whether it varies less than A and B, and rates at least as well as B, needs the full run's three runs per brief and the rubric.

## What C's first rounds found, and what changed

| | Registry as merged | After the fixes |
| --- | --- | --- |
| Pass on the first assembly | 16 of 20 | 18 of 20 |
| Pass at the end | 19 of 20 | 20 of 20 |
| HTML nodes per page | 0.55 | 0.30 |
| Checklist met | 82% | 91% |
| Cost and wall time per page | $0.09, 19 s | $0.10, 21 s |

### The MCP server

- **Claude Code shows a model an MCP result's `structuredContent` instead of its text.** In a first round on the M1 pilot's five briefs (two runs each, not kept), the catalog reached the model as 24 KB of JSON instead of 4 KB of text, and anything only in the text, such as the stop message after the third failing assembly, would never have reached it. Results are now text only; `--structured` adds the JSON for programs. On those five briefs a page cost $0.16 with JSON results and $0.09 with text.

### The assembler

- **A plan with unbalanced brackets failed three times running** (event, before): the model wrote compact JSON, and the parser's "Expected ',' or '}'" never said which bracket. The message now names it ("the "]" at 22:89 can't close the "{" at 1:1, which needs "}""), and the skill asks for indented plans.
- **Style findings in HTML nodes failed assembly** (search results, before): `<input>` without its slash, a bare `checked`. The serializer rewrites both in the house style anyway, so the check of a value or node now leaves the style rules to the check of the output.
- **The slot pre-check looked only at a component's root** for a `form` inside a `form`. `form/search`'s form sits under `<search>`, and the property tests found the gap; it now checks every element of the template, as §9.6 always said.
- **Two bindings the template compiler refused**: an `integer` for a number input's `min`, `max`, and `value`, which the attribute index lists as varying, and a `boolean` for an untyped `data-*` attribute, such as `nav.steps`'s `data-completed`.

### The starter registry

- **A form's `action` became optional.** No brief gives an endpoint, the assembler rejects `#`, so every form invented one (`/subscribe`, `/cart`) or failed on it: all three runs that failed their first assembly in the first round, and one of four in `c-before`. Without an action, a form submits to its own page.
- **Optional where the content may not have it**: a quote's author (a pull quote), a footer's legal links, and the page title on the home page, which read "Larkspur Supply Co. | Larkspur Supply Co.".
- **Nine new components** for what pages wrote as HTML nodes or left out: `page/article` (the article's `h1` and byline in its own header, as A and B write it), `content/address`, `content/result-list`, `form/fieldset`, `form/checkbox-group`, `form/number-field`, `form/file-field`, `form/search`, and `nav/steps`. A footer can also carry contact details.
- **Two left out, because a contract can't promise them yet**, as the property tests showed: a preselected option or radio, since nothing says only one item may be selected, and a starting value for a text field, whose validity depends on its type.

### The skill

Indented plans, `<time datetime>` for dates in inline and prose values, and `content/prose` rather than HTML nodes for plain paragraphs.

### The harness

- **The house skills never loaded in A or B, in the M1 pilot or before this round.** Their frontmatter grants tools (`allowed-tools`), and headless Claude Code refuses such a skill: in the M1 pilot, 31 calls in A and 17 in B. The run's copies now drop that line, so the skills load and each condition keeps the tools the harness gives it. The M1 pilot's A and B numbers are without the house skills.
- **Transcripts.** Each run keeps Claude Code's stream-json transcript; its result event isn't always the last line.

## Still open

- **Photos without files.** Five briefs describe photos but give no file or size. C declines to invent them, which costs it checklist items in all five; A and B make up paths and sizes. Giving the briefs each photo's file and size would make the checklist fair to every condition. Cards with photos would then need a contract that can require a group of fields together, or a card component whose image fields are all required.
- **Site names and URLs.** Some briefs name no site, and few give link targets; `page/basic` requires a site name, so C made some up ("Blog"), and every condition has to invent link targets or use `#`, which B's check and C's assembler reject.
- **Approval** of the 37 components, and **the rubric**.
- **The house skills still disagree with the config** (§10.4), which now costs A and B on every page. Fixing the skills would make the comparison about the loop and the assembler rather than about the skills' syntax.
