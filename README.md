Experiments in hacking a tool together to check HTML for problems and reassemble it a proper semantic manner.  Trying to prove or disprove that we can actually predictably build something as simple as a web page with LLMs with actual quality

The design is in [spec.md](spec.md). Implemented so far: milestone M0 (the parser foundation, `syntax` and `style` rules), M1a (spec data, the content-model engine, and the `content` rules), M1b (ARIA data, accessible names, and the `a11y` rules), M1c (the `semantic`, `policy`, and `bloat` rules, with escaping and whitespace for `style`), M1d (the Vanilla Breeze vocabulary and the `component` rules), M1e (`fix`, `init`, the Claude Code skill and hook, and the Nu cross-check), M1f (the evaluation harness; see [eval/README.md](eval/README.md)), M2, the assembler (component contracts, the template compiler, the house-style serializer, plans, `assemble`, the component lifecycle, and the starter registry), and from M3 the MCP server and the evaluation's condition C.

## Usage

Requires Node 22.18 or later, which runs the TypeScript sources directly.

```sh
npm install
node bin/htmlverify.js check page.html                     # strict profile, text output
node bin/htmlverify.js check "site/**/*.html" --format json
node bin/htmlverify.js check row.html --context tbody      # a fragment inside <tbody>
node bin/htmlverify.js check - --stdin-name page.html < page.html
node bin/htmlverify.js check page.html --nu                 # also cross-check with the Nu Html Checker (needs Java)
node bin/htmlverify.js fix page.html                        # a diff of the tree-preserving fixes
node bin/htmlverify.js fix page.html --write                # apply them in place
node bin/htmlverify.js init --claude                        # a config, the Claude Code skill, and the PostToolUse hook
node bin/htmlverify.js explain content/child               # what a rule checks, with examples
node bin/htmlverify.js rules --profile standard            # every rule and its severity
node bin/htmlverify.js vocab update vanilla-breeze --from ../vanilla-breeze   # rebuild the vocabulary snapshot
node bin/htmlverify.js assemble plan.json --out page.html  # build a page from components; written only when it passes
node bin/htmlverify.js assemble plan.json --draft          # allow unreviewed components; the page goes to stdout
node bin/htmlverify.js catalog --query form                # the components a plan can use, one line each
node bin/htmlverify.js component new content/callout --author "A. Author"   # scaffold a component
node bin/htmlverify.js component check content/callout --update            # render its fixtures; write expected outputs to review
node bin/htmlverify.js component approve content/callout --by "A. Reviewer" # after a clean check with full branch coverage
node bin/htmlverify.js registry check                      # the CI gate: every component checks clean and is approved
node bin/htmlverify.js mcp                                 # the MCP server on stdio, for an LLM client
```

Exit codes: 0 pass, 1 fail, 2 usage, config, or input error, 3 incomplete.

`check` and `rules` read `htmlverify.config.json` from the working directory or its nearest ancestor (or `--config <file>`):

```json
{
  "extends": "strict",
  "vocabularies": ["vanilla-breeze@0.3.1"],
  "registry": "registry",
  "options": { "voidElements": "xhtml", "booleanValue": "true", "adHocPrefix": "x-" },
  "rules": { "style/void-element": "warning", "bloat/depth": ["warning", { "max": 16 }], "policy/elements": ["error", { "deny": ["iframe"] }] },
  "maxWarnings": 0
}
```

Unknown keys, rules, and severities are errors. `registry` points at a directory, relative to the config, whose `elements.json` declares the project's own custom elements in the html-validate format, and whose `components/` holds the components `assemble` builds pages from:

```json
{ "app-card": { "flow": true, "permittedContent": ["@flow"], "attributes": { "tone": { "enum": ["calm", "loud"] }, "open": { "boolean": true } }, "role": "region" } }
```

## What it checks

- `syntax/*`: parse errors, plus the repairs parse5 makes silently. It compares the tag tokens with the tree to find implied elements, missing and stray end tags, dropped start tags, misnested formatting, and content moved out of tables.
- `style/*` (strict profile): double-quoted attributes, `name="true"` booleans, lowercase names, `<br />`, explicit start and end tags, `<!doctype html>`, escaped `&` and `>`, space indentation, no trailing whitespace, and one newline at the end. Mechanical fixes come with each finding and are verified to leave the parsed tree unchanged; whitespace inside text, comments, and attribute values is content, so those lines are listed without a fix.
- `content/*`: HTML conformance against a pinned WHATWG snapshot. Child grammars (with transparent content), order and counts, descendant prohibitions, contexts, unknown and obsolete elements and attributes, attribute values (keywords, numbers, URLs, dates, language tags, `srcset`, `sizes`, `autocomplete`, …), required attributes, and IDs and ID references.
- `a11y/*`: static accessibility against WAI-ARIA and ARIA in HTML. Page language and title, image alternatives, inline `svg`, accessible names and form labels (with the source of each computed name), roles and `aria-*` attributes, focusable content under `aria-hidden`, `tabindex`, heading levels, landmarks, link text, radio and checkbox groups, data tables, and media. A failure is evidence; a pass is never a WCAG claim. What only a person can judge, such as whether an alt text is accurate, becomes a review item.
- `component/*`: custom elements against the Vanilla Breeze vocabulary, a snapshot compiled from VB's `api.json` manifests (134 elements at VB 0.3.1), and the project's `elements.json`. Unknown and misspelled elements, attributes and their values (enums, numbers, presence booleans, where `="false"` turns the feature on), children the manifest doesn't permit, required structure such as `<details>` panels in `<accordion-wc>`, flow-only elements in phrasing content, and attributes the component sets itself. Ad-hoc `x-*` elements are warnings.
- `semantic/*`: native features over rebuilt ones (`span role="button"`, `href="#"`, ARIA dialogs and disclosures, text inputs for email and phone), sections without headings, `br` used for spacing, empty spacer elements, fragment links with no target, and placeholder text such as lorem ipsum, TODO, `{{…}}`, and `example.com` links. Likely headings and lists become review items.
- `policy/*`: the house rules: no `div`, one `h1`, typed buttons, no inline handlers, styles, or `javascript:` URLs, the icon component over inline `svg`, `strong` and `em` over `b` and `i`, `charset` first and a viewport in `head`, a configurable element denylist (off by default), and clean `class` lists.
- `bloat/*`: share of generic elements, wrapper chains, class counts, depth, and size, with thresholds set per rule. The metrics are in every JSON report, whether or not a threshold is crossed.

`fix` applies the fixes that findings propose, in verified rounds: each round must leave the parsed tree unchanged and add no error, or the fixes that break it stay suggestions. Running it twice changes nothing the second time. `--nu` cross-checks documents with the Nu Html Checker: its messages attach to the local findings they confirm, and the rest become `conformance/nu` findings. `init --claude` sets up the Claude Code skill and a `PostToolUse` hook that checks each `.html` file Claude writes and hands failures back to the model.

## Assembling pages

A plan names components from the registry, their data, and what goes in their slots; `assemble` builds the page and checks it. The assembler owns the markup: escaping, IDs from key paths (`contact/email` + `@input` is `contact-email-input`), heading levels from nesting, pruned references, and the house style. A plan with `{ "key": "…", "html": "…" }` inserts hand-written HTML where no component fits; it must pass `strict` and is reported as a registry gap.

```json
{ "page": { "use": "page/basic", "data": { "title": "Contact us", "description": "How to reach us.", "heading": "Contact us" }, "slots": {
  "main": [ { "use": "content/section", "key": "write", "data": { "title": "Write to us" }, "slots": { "body": [
    { "use": "form/form", "key": "contact", "data": { "action": "/contact" }, "slots": {
      "fields": [ { "use": "form/text-field", "key": "email", "data": { "label": "Email", "name": "email", "type": "email" } } ],
      "actions": [ { "use": "action/submit", "key": "send", "data": { "label": "Send" } } ] } } ] } } ] } } }
```

`assembly/*` findings are located in the plan by line, column, and JSON Pointer. Each finding in the output carries its origin, classified so the fix goes to the right place: **plan** (wrong data or component choice: fix the plan), **composition** (components that don't fit together: pick others), or **component** (a defect in the component itself: it needs repair and re-review). `strict` assembles only approved components; `--draft` allows the rest with a warning. See `test/assemble/contact.plan.json` and the components in `test/registry/`.

An LLM client can do the same through `htmlverify mcp`, an MCP server on stdio with the tools `check_html`, `fix_html`, `list_components`, `get_component`, `assemble`, and `explain_rule`. For Claude Code, add it to a project's `.mcp.json` as `{ "mcpServers": { "htmlverify": { "command": "npx", "args": ["htmlverify", "mcp"] } } }`, and give the model `assets/claude/assemble/SKILL.md`, the assembling workflow, as a skill. Results are the text reports; `--structured` adds the JSON, which Claude Code would show the model instead.

The starter registry in `registry/` holds 37 Vanilla Breeze components, from `page/basic` and `page/article` to forms, dialogs, and tabs; `catalog` lists them, and the CLI uses them when the config names no registry of its own.

A component is `components/<group>/<name>/` in the registry: `component.json` (the contract), `template.html`, and `fixtures/<name>.json` with the `.html` each renders. `component check` renders every fixture in the component's context under `strict`, compares it with the expected output, and reports branch coverage: each `vb-if` both ways, each `vb-each` with no, one, and several items, each optional parameter given and left out, and each enum value used. `component approve` records the reviewer and the digest of the exact files reviewed; any later change makes the approval stale, which `registry check` fails.

When several rules report one defect (a missing title is `content/order` and `a11y/title`), the earliest family keeps it and lists the others in `alsoReportedBy`.

Content inside `<svg>`, `<math>`, and `<noscript>` isn't modeled, and coverage says so.

## Spec data

Each data file is generated from a checkout of its spec's repository and records the commit:

```sh
node tools/extract/html.ts ../whatwg-html             # data/html.json from whatwg/html
node tools/extract/aria.ts ../aria                    # data/aria.json from w3c/aria (the editor's draft)
node tools/extract/html-aria.ts ../html-aria          # data/html-aria.json from w3c/html-aria
node bin/htmlverify.js vocab update vanilla-breeze --from ../vanilla-breeze   # data/vocab/vanilla-breeze@<version>.json
npm test                                               # fails if hand-encoded spec text changed
```

When a test names changed elements or rows, review them in `src/spec/model.ts`, `src/spec/html-aria.ts`, or `src/vocab/overlay.ts`, then run `UPDATE_GOLDEN=1 npm test` to pin the new text in `data/overlay-basis.json`, `data/html-aria-basis.json`, and `data/vocab-basis.json`.

## Development

```sh
npm test                    # fixtures, mutation corpus, unit, ARIA, docs, config, assembler, and CLI tests
npm run typecheck
UPDATE_GOLDEN=1 npm test    # rewrite test/fixtures/**/*.json and test/assemble/*.html after an intended change; review the diff
HTMLVERIFY_VNU_JAR=path/to/vnu.jar node --test test/nu.test.ts   # the Nu differential
```

The mutation corpus (`test/corpus.ts`) injects one defect per rule into a known-good page, and each must trigger its rule. The Nu differential checks every document fixture, known-good page, and mutant with Nu: each Nu error or warning must match a local finding or be listed in `test/nu-gaps.json`, which says why htmlverify doesn't report it, and each listed message must still occur on its example. CI runs it with `vnu-jar`.
