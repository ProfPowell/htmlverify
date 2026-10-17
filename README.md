Experiments in hacking a tool together to check HTML for problems and reassemble it a proper semantic manner.  Trying to prove or disprove that we can actually predictably build something as simple as a web page with LLMs with actual quality

The design is in [spec.md](spec.md); the v0.2 draft is in PR #1. This branch implements milestone M0: the parser foundation plus the `syntax` and `style` rules.

## Usage

Requires Node 22.18 or later, which runs the TypeScript sources directly.

```sh
npm install
node bin/htmlverify.js check page.html                     # strict profile, text output
node bin/htmlverify.js check "site/**/*.html" --format json
node bin/htmlverify.js check row.html --context tbody      # a fragment inside <tbody>
node bin/htmlverify.js check - --stdin-name page.html < page.html
```

Exit codes: 0 pass, 1 fail, 2 usage or input error, 3 incomplete.

## What M0 checks

- `syntax/*`: parse errors, plus the repairs parse5 makes silently. It compares the tag tokens with the tree to find implied elements, missing and stray end tags, dropped start tags, misnested formatting, and content moved out of tables.
- `style/*` (strict profile): double-quoted attributes, `name="true"` booleans, lowercase names, `<br />`, explicit start and end tags, `<!doctype html>`. Mechanical fixes come with each finding and are verified to leave the parsed tree unchanged.
- `content/attribute-value` for boolean attributes: `disabled="false"` still disables.

Every other rule family in the spec is reported as untested.

## Development

```sh
npm test                    # fixtures, unit, and CLI tests
npm run typecheck
UPDATE_GOLDEN=1 npm test    # rewrite test/fixtures/**/*.json after an intended change; review the diff
```
