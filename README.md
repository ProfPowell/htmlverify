Experiments in hacking a tool together to check HTML for problems and reassemble it a proper semantic manner.  Trying to prove or disprove that we can actually predictably build something as simple as a web page with LLMs with actual quality

The design is in [spec.md](spec.md). Implemented so far: milestone M0 (the parser foundation, `syntax` and `style` rules) and M1a (spec data, the content-model engine, and the `content` rules).

## Usage

Requires Node 22.18 or later, which runs the TypeScript sources directly.

```sh
npm install
node bin/htmlverify.js check page.html                     # strict profile, text output
node bin/htmlverify.js check "site/**/*.html" --format json
node bin/htmlverify.js check row.html --context tbody      # a fragment inside <tbody>
node bin/htmlverify.js check - --stdin-name page.html < page.html
node bin/htmlverify.js explain content/child               # what a rule checks, with examples
node bin/htmlverify.js rules --profile standard            # every rule and its severity
```

Exit codes: 0 pass, 1 fail, 2 usage, config, or input error, 3 incomplete.

`check` and `rules` read `htmlverify.config.json` from the working directory or its nearest ancestor (or `--config <file>`):

```json
{ "extends": "strict", "options": { "voidElements": "xhtml", "booleanValue": "true" }, "rules": { "style/void-element": "warning" }, "maxWarnings": 0 }
```

Unknown keys, rules, and severities are errors; keys the spec reserves for later milestones are rejected with the milestone that adds them.

## What it checks

- `syntax/*`: parse errors, plus the repairs parse5 makes silently. It compares the tag tokens with the tree to find implied elements, missing and stray end tags, dropped start tags, misnested formatting, and content moved out of tables.
- `style/*` (strict profile): double-quoted attributes, `name="true"` booleans, lowercase names, `<br />`, explicit start and end tags, `<!doctype html>`. Mechanical fixes come with each finding and are verified to leave the parsed tree unchanged.
- `content/*`: HTML conformance against a pinned WHATWG snapshot. Child grammars (with transparent content), order and counts, descendant prohibitions, contexts, unknown and obsolete elements and attributes, attribute values (keywords, numbers, URLs, dates, language tags, `srcset`, `sizes`, `autocomplete`, …), required attributes, and IDs and ID references.

The `component`, `a11y`, `semantic`, `policy`, and `bloat` families come in later M1 steps and are reported as untested until then. Content inside `<svg>`, `<math>`, and `<noscript>` isn't modeled, and coverage says so.

## Spec data

`data/html.json` is generated from a checkout of [whatwg/html](https://github.com/whatwg/html) and records its commit:

```sh
node tools/extract/html.ts ../whatwg-html             # rewrites data/html.json
npm test                                               # fails if an element’s spec text changed
```

When the test names changed elements, review their models in `src/spec/model.ts`, then run `UPDATE_GOLDEN=1 npm test` to pin the new text in `data/overlay-basis.json`.

## Development

```sh
npm test                    # fixtures, unit, docs, config, and CLI tests
npm run typecheck
UPDATE_GOLDEN=1 npm test    # rewrite test/fixtures/**/*.json after an intended change; review the diff
```
