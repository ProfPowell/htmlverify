---
name: htmlverify
description: Check, fix, and verify HTML with htmlverify before handing it back. Use whenever you create or edit an .html file, a component template, or a snippet.
---

# htmlverify

htmlverify checks HTML as a browser parses it, against the WHATWG HTML standard, WAI-ARIA, the Vanilla Breeze vocabulary, and this project's house rules in `htmlverify.config.json`. A hook runs it after every write to an `.html` file, and its report comes back to you when the file fails.

## Workflow

1. Check: `npx htmlverify check page.html`. For a fragment, such as a component or a snippet, name the element it goes inside: `--context tbody`.
2. Apply the mechanical fixes: `npx htmlverify fix page.html --write`. They change only the form of the markup (quotes, case, `<br />`, boolean values, explicit tags, escaping, whitespace), never the parsed tree.
3. Fix the rest by hand, errors first. `npx htmlverify explain <rule>` says why a rule exists and shows a failing and a passing example.
4. Check again. Stop after three rounds, or when the same finding survives two rounds, and report what remains.
5. Hand back the result with its status and its open review items.

## Reading a report

- `error` fails the file; `warning` and `info` don't.
- Each finding gives its rule, its position, and what to do. `[fix]` marks one that `fix` applies.
- `review` lines are questions only a person can answer, such as whether an alt text describes its image. Pass them on to the user; never answer them yourself.
- `untested` lists checks that didn't run. Don't claim they passed.

## Rules of engagement

- Fix the cause, not the rule. Never turn rules off, lower their severity, or edit `htmlverify.config.json` to get a pass.
- Never invent content to satisfy a check: no made-up alt text, labels, captions, titles, or review answers. Ask the user for the real content.
- Use Vanilla Breeze elements and attributes as declared; the messages name the declared ones. Don't rename an element to an ad-hoc `x-*` one to get past `component/unknown-element`.
- Prefer native HTML to ARIA on generic elements: `<button>` over `<span role="button">`, and `<dialog>` and `<details>` over rebuilt widgets.
