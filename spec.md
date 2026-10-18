# htmlverify specification

**Version** 0.2, implementation draft · **Date** 2026-10-17 · **Replaces** the 1.0 proposal (commit `d99d631`); §15 lists what changed and why.

htmlverify lets an LLM build HTML the way you build with Lego. It picks expert-reviewed bricks (components), snaps them together through typed connection points (slots and parameters), and a deterministic assembler writes the markup. A strict checker verifies each brick, each connection, and the finished page against the HTML standard, accessibility requirements, and the house style. The same checker works on hand-written HTML, so the LLM can also repair markup it wrote itself.

The project tests the hypothesis in the README: **an LLM produces web pages predictably, with real quality, when it composes verified parts instead of generating markup freely.** §13 defines how the experiment proves or disproves it.

## 1. Scope

### 1.1 The Lego model

| Lego | htmlverify | § |
| --- | --- | --- |
| Brick | Component: versioned template and typed contract, approved by a human | 9.3–9.4 |
| Studs | Slots and parameters; what fits a slot is derived from the HTML content model | 9.5–9.6 |
| Printing on the brick | Typed data: text, URLs, restricted inline HTML | 9.5 |
| Instructions | Assembly plan (JSON), written by the LLM | 9.7 |
| Clutch check | Assembly-time type checks, then full verification of the output | 9.8 |
| Factory QA | `component check`: fixtures, branch coverage, approval bound to a digest | 9.10 |

### 1.2 Goals

1. **Check** any HTML document or fragment: syntax as the browser parses it, authored form, content model, static accessibility, semantics, house style, structural bloat.
2. **Assemble** pages from components with guarantees by construction: escaping, IDs, heading levels, content-model fit.
3. **Talk to an LLM**: compact findings with exact locations and fixes, and a component catalog to choose from.
4. **Be deterministic**: the same input, config, and registry give byte-identical output and reports.

### 1.3 Non-goals for v1

- Certifying WCAG conformance. Static checks establish failures, never a pass; reports list what remains for runtime or human review.
- Rendering-dependent checks (contrast, focus visibility, target size, keyboard behavior) before M4.
- Browser-support data (Baseline). Features are checked against the pinned spec snapshot; the house decides what to use.
- Linting CSS or JavaScript, or reading framework sources (JSX, Vue, server templates). Check their HTML output.
- Sanitizing untrusted HTML. Restricted-HTML parameters are validated and rejected, never cleaned.
- XML parsing. "XHTML style" here means an authored form of `text/html`, parsed by the HTML parser.

## 2. Principles

1. **The browser's parser is ground truth.** Checks run on the tree the WHATWG algorithm builds and on the source tokens that built it. A checker with its own parser disagrees with browsers (§4.3).
2. **Construct, don't generate.** The LLM chooses components and supplies content and intent; code writes markup.
3. **Truthful outcomes.** A check that didn't run is `untested`, never a pass. Judgments the tool can't make (is this alt text accurate?) become review items.
4. **Labeled authority.** Each rule is `standard` (HTML, ARIA, or WCAG requirement), `vocabulary` (the documented contract of a component library, Vanilla Breeze by default), `policy` (house rule), or `heuristic` (likely problem). Policy is never reported as an HTML error. Where the house style deliberately departs from HTML (`disabled="true"`, §6.2), the departure is still reported, at info severity.
5. **Actionable.** Each finding says where, what, why, and how to fix it, in one line when possible.
6. **Platform first.** Output uses native elements and attributes (`button`, `details`, `dialog`, `popover`, `command`/`commandfor`) before scripted widgets. The tool uses Node built-ins before packages.

## 3. Architecture

### 3.1 Pipelines

```text
check     bytes → decode → parse5 (tree + token log) → reconcile tokens with tree
          → indexes (ids, references, names, headings, landmarks, metrics)
          → rules → findings + reviews + coverage → status, score → text | json

assemble  plan → validate → resolve components → instantiate (types, slots, ranks, ids, refs)
          → serialize → reparse and compare → check in context
          → map findings to plan or template → html + report
```

### 3.2 Technology

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node ≥ 22.18, ES modules | Runs TypeScript directly (type stripping); verified on 22.22 |
| Language | TypeScript, erasable syntax only | No build step in development; `tsc --noEmit` checks types; JS is emitted only for npm publishing, because Node won't strip types inside `node_modules` |
| HTML parser | `parse5` 8, the only direct runtime dependency (it brings `entities`) | WHATWG tree construction, fragment parsing with context, source locations |
| CLI, tests, hashes, globs, URLs | `util.parseArgs`, `node:test`, `node:crypto`, `fs.glob`, WHATWG `URL` | Built-ins |
| Schemas | JSON Schema files, validated by an in-repo validator for the subset used | The same schemas serve as MCP tool input schemas |
| Conformance cross-check | Nu Html Checker (`vnu.jar`), optional, needs Java | Independent oracle (§6.9) |
| Runtime accessibility (M4) | Playwright and axe-core, optional | Rendered-state checks |

### 3.3 Modules

| Module | Responsibility |
| --- | --- |
| `parse` | decoding, limits, parse5 wrapper, token log, reconciliation |
| `spec` | element, attribute, and ARIA data; content-model engine |
| `analysis` | ID and reference index, accessible names, heading outline, landmarks, metrics |
| `rules` | rule functions and their docs |
| `report` | findings, deduplication, status, score, formats |
| `fix` | edit planning and reparse verification |
| `assembly` | template compiler, contracts, plans, instantiation, serializer, origins |
| `registry` | component discovery, digests, review status, catalog |
| `cli`, `mcp`, `hook` | interfaces; the only modules that touch the filesystem or process |

The core (everything except the interfaces) is pure functions over strings, so it also runs in a browser or a worker.

### 3.4 Specification data

`data/` holds JSON generated by `tools/extract/` from pinned snapshots of WHATWG HTML (element, attribute, and category indices), WAI-ARIA (roles, states, properties, from the 1.3 editor's draft in `w3c/aria`, which already defines roles such as `image`, `mark`, and `suggestion`), and ARIA in HTML (implicit roles, allowed roles and attributes, from `w3c/html-aria`). Each file records its source URL, snapshot date, and SHA-256. Exact child grammars and descendant prohibitions, which the indices only summarize, are hand-written overlays that cite their spec sections; elements whose content model is plain "Flow content.", "Phrasing content.", "Nothing.", "Text.", or "Transparent." are derived from the data. `data/overlay-basis.json` pins a hash of each element's categories, contexts, and content-model text, so a regenerated snapshot that changes them fails a test until the overlay is reviewed. ARIA in HTML is a prose table: the extractor parses its regular phrasings into structured fields, the conditional rows (`li` in a list, `header` outside sectioning content, `img` with empty `alt`, …) are encoded by hand, and `data/html-aria-basis.json` pins their text the same way. Updating data is an explicit command whose diff is reviewed; checks never fetch anything.

**Vocabulary snapshots.** Custom elements and web components come from Vanilla Breeze (§7.4). `htmlverify vocab update vanilla-breeze --from <checkout>` compiles its `api.json` registry (`src/web-components/*/api.json`, `src/custom-elements/*/api.json`, and `src/htmlvalidate/api-overrides.json`, the files VB's own registry builder reads) into `data/vocab/vanilla-breeze@<version>.json`, recording the version, the commit read from `.git` (git isn't run), the number of manifests, and a SHA-256 over their paths and bytes. The npm package doesn't ship the manifests, so `--from` takes a checkout. The config's `vocabularies` names the snapshots a check uses (default: the bundled `vanilla-breeze@0.3.1`), and the report's profile hash covers each snapshot's SHA-256. Checks read only the snapshot.

## 4. Input and parsing

### 4.1 Input kinds

| Kind | Meaning | Parsed with |
| --- | --- | --- |
| `document` | complete page | `parse()` |
| `fragment` | partial markup inside a context element | `parseFragment(context, …)` |
| `template` | component template | fragment parsing in the component's `context` (§9.4) |
| `plan` | assembly plan | JSON and its schema |

The command and its flags decide the kind; file extensions and content don't. Fragment context is a tag (`--context tbody`) or a descriptor:

```json
{ "parent": "tbody", "ancestors": ["table", "main", "body"], "ids": ["email-hint"] }
```

`ancestors` feed transparent-content and descendant checks; `ids` let references resolve against the host page. Document-level rules (title, `lang`, single `main` and `h1`) are `untested` for fragments.

### 4.2 Decoding and limits

UTF-8 only, decoded with `TextDecoder("utf-8", { fatal: true })`; invalid bytes stop analysis with `syntax/encoding`. A BOM is accepted and preserved by fixes. Limits are configurable: 5 MiB per file, 100,000 elements, depth 512. Exceeding one gives status `incomplete`.

### 4.3 Reconciling tokens with the tree

parse5 reports tokenizer errors but performs most tree-construction repairs silently. In the spike (parse5 8.0.1) it reported nothing for content foster-parented out of a table, misnested formatting, `</p>` with no open `p`, `</br>`, a nested `<form>`, an `<h1>` closed by `<h2>`, or `<tr>` dropped in a `div` context. htmlverify therefore logs every start and end tag token the tree builder consumes, by wrapping the parser's `onStartTag` and `onEndTag`. That also yields correct tokenizer states for `script`, `textarea`, and foreign content. The log is reconciled with the tree:

| Signal | Detection | Finding |
| --- | --- | --- |
| Implied element | element without a source location | `style/explicit-start-tag` for `html`, `head`, `body`, `tbody`, `colgroup`, whose start tags are optional; any other implied element is reported with the token that caused it: `syntax/stray-end-tag` (`p` from `</p>`, `br` from `</br>`) or `syntax/misplaced-start-tag` (the `tr` around a `td` placed directly in `table`) |
| Missing end tag | non-void element without an end-tag location | `style/explicit-end-tag` where the optional-tag rules (HTML §13.1.2.4) allow omission; `syntax/unclosed-element` otherwise |
| Dropped start tag | start token that no element owns | `syntax/misplaced-start-tag` |
| Stray end tag | end token that no element owns | `syntax/stray-end-tag` |
| Cloned element | two elements share one start token | `syntax/misnested` |
| Moved content | source offsets decrease in document order | `syntax/reordered` |

Messages name the cause: "`</p>` at 4:21 has no open `<p>`. The `<p>` from 4:1 was closed at 4:9 by `<div>`, which `p` can't contain."

**Why this matters.** The `custom-elements` skill documents void custom elements: `<icon-element name="star"/>`, `<user-avatar src="/a.jpg" alt="Jo"/>`. In `text/html` the `/` is ignored, so the parser leaves them open and they swallow what follows. In the spike the avatar became the parent of the next link. A validator that trusts `void: true` metadata accepts this; browsers don't. → `syntax/self-closing-non-void`.

### 4.4 Locations

Positions are parse5's: `line` and `column` are 1-based in UTF-16 code units; `offset` and `endOffset` are 0-based indexes into the decoded string, counting CR. That is the LSP default encoding, so editors need no conversion. Fixes edit the decoded string and re-encode it as UTF-8 with the original BOM and line endings.

## 5. Findings, reports, status

### 5.1 Finding

```json
{
  "rule": "a11y/label",
  "severity": "error",
  "authority": "standard",
  "message": "<input name=\"email\"> has no label. Add <label for=\"…\">…</label> or wrap the input in a label.",
  "path": "contact.html",
  "line": 14, "column": 5, "endLine": 14, "endColumn": 40, "offset": 391, "endOffset": 426,
  "evidence": { "name": "", "placeholder": "Email" },
  "ref": "https://www.w3.org/TR/WCAG22/#labels-or-instructions",
  "related": [],
  "fix": null,
  "origin": null
}
```

- `severity`: `error` fails the gate; `warning` and `info` don't.
- `evidence`: rule-specific facts, such as the computed name and its source, raw attribute text, metric values.
- `fix`: tree-preserving edits (§8), or `null`. Fixes never invent content such as alt text or labels.
- `alsoAt`: other places the defect shows, as lines and columns, such as where the parser closed an unclosed element; omitted when there are none.
- `origin`: where an assembled node came from (§9.8).

**Deduplication.** When several rules report one defect at one location (a missing title: `content/order` and `a11y/title`), the report keeps the finding from the first family in the order syntax, content, component, a11y, semantic, policy, style, bloat, and lists the others in `alsoReportedBy`. A syntax finding absorbs the style findings it explains: there is no separate `style/explicit-end-tag` for the `<p>` behind a stray `</p>`.

### 5.2 Review items

Judgments the tool can't make are listed apart from findings and never counted as passes or failures:

```json
{ "rule": "a11y/img-alt", "line": 9, "column": 5, "ask": "Does alt=\"Team photo\" convey what the image shows here?" }
```

Examples: alt accuracy, whether `alt=""` is really decorative, whether a heading describes its section, link purpose in context, whether `lang` matches the content, component review obligations.

### 5.3 Coverage

`coverage.untested` lists every applicable check that didn't run, with the reason: `conformance/nu (java not found)`, `a11y/contrast (runtime, M4)`, `content rules for <math> (not modeled)`, document-level rules for a fragment.

### 5.4 Status and exit codes

| Status | Condition | Exit |
| --- | --- | --- |
| `pass` | no errors; all required checks ran | 0 |
| `fail` | at least one error | 1 |
| none | usage, config, or input error (unknown flag, unreadable file, invalid plan JSON) | 2 |
| `incomplete` | a required check couldn't run (limit exceeded, engine crash); known findings are kept | 3 |

For several files the exit code is the first of 2, 3, 1, 0 that occurred. Warnings fail only when the config sets `maxWarnings`.

### 5.5 Score (for benchmarks only)

The score compares runs in §13; it never overrides the status.

- Penalties: error 10, warning 3, info 0. Each rule contributes at most its 3 largest penalties, so clean padding can't dilute a defect and one repeated mistake can't sink the page.
- Dimension score = max(0, 100 − penalties). Weights: syntax and style 20, content and component 25, a11y 25, semantic and policy 20, bloat 10. Overall = round(Σ weight × dimension ÷ 100).
- A dimension with an `untested` required check scores `null`, and so does overall.

### 5.6 Output formats

`--format text` is the default: one line per item, sized for an LLM's context window.

```text
contact.html
  3:7    error    style/attr-quotes   Quote the value: class="hero".  [fix]
  14:5   error    a11y/label          <input name="email"> has no label. Add <label for="…">…</label> or wrap it in a label.
  22:3   warning  a11y/headings       <h4> follows <h2>; use <h3>.
  9:5    review   a11y/img-alt        Does alt="Team photo" convey what the image shows here?
✗ fail · 2 errors · 1 warning · 1 review · strict · untested: conformance/nu (java not found)
```

`--format json` is the canonical report: findings, reviews, coverage, metrics, score, tool and data versions, profile name and config hash, input SHA-256. Canonical means sorted keys, no insignificant whitespace, UTF-8, relative POSIX paths, findings sorted by path, then offset, then rule, and no timestamps. `--timing` prints durations to stderr.

## 6. Checker rules

IDs are `family/name` and never change meaning; a renamed rule keeps its old ID as an alias. `htmlverify explain <rule>` prints what the rule checks, why, its authority and spec reference, a failing and a passing example, and how to fix it. Documentation examples run as test fixtures.

Severity columns give the **strict** and **standard** defaults: E error, W warning, I info, R review, – off. Auth: S standard, V vocabulary, P policy, H heuristic. M: milestone.

### 6.1 `syntax`: the browser builds a different tree than the source suggests

All standard, error in both profiles, M0, no automatic fix.

| Rule | Detects |
| --- | --- |
| `syntax/parse-error` | parse5 errors not covered below, with the spec's error code (`eof-in-tag`, `missing-whitespace-between-attributes`, `unexpected-null-character`, …) |
| `syntax/duplicate-attribute` | repeated attribute; the parser keeps the first |
| `syntax/self-closing-non-void` | `/>` on a non-void element (`<div/>`, `<textarea/>`, `<icon-element/>`); the element stays open |
| `syntax/unclosed-element` | element closed by end of file, a parent's end tag, or a start tag it can't contain, where its end tag isn't optional |
| `syntax/stray-end-tag` | end tag that matches nothing: ignored, or turned into an element |
| `syntax/misplaced-start-tag` | start tag the parser dropped (nested `form`, `tr` outside a table, a second `body`) or wrapped in an implied element (`td` directly in `table` gets a `tr`) |
| `syntax/misnested` | overlapping elements, closed early (`<b><i></b></i>`) or repaired by cloning (`<b><i></b>x</i>`) |
| `syntax/reordered` | content the parser moved (foster-parented out of a table) |
| `syntax/doctype` | missing or non-conforming doctype; quirks or limited-quirks mode |
| `syntax/encoding` | invalid UTF-8; charset declaration missing from the first 1024 bytes or not `utf-8` |

### 6.2 `style`: authored form; the tree is the same either way

All policy, off in `standard`.

| Rule | Detects | strict | Fix | M |
| --- | --- | --- | --- | --- |
| `style/attr-quotes` | value not double-quoted, including bare non-boolean attributes (`<a href>`) | E | yes | 0 |
| `style/boolean-attr` | presence-based boolean attribute, native or Vanilla Breeze, not in the configured form: `name="true"` (default), `name=""`, or `name="name"`; by default it flags bare `disabled`, `disabled=""`, and `disabled="disabled"` | E | yes¹ | 0 |
| `style/lowercase` | uppercase HTML names; foreign names not in canonical case (`viewbox` → `viewBox`) | E | yes | 0 |
| `style/void-element` | void element not in the configured form: `<br />` (`xhtml`, the default), `<br/>` (`tight`), or `<br>` (`html`) | E | yes | 0 |
| `style/explicit-start-tag` | implied `html`, `head`, `body`, `tbody`, `colgroup` | E | yes | 0 |
| `style/explicit-end-tag` | omitted optional end tag (`</p>`, `</li>`, `</td>`, `</body>`) | E | yes | 0 |
| `style/doctype` | doctype not exactly `<!doctype html>` | E | yes | 0 |
| `style/escape` | literal `&`, `<`, `>` in text, or `&` in attribute values, where HTML would accept them: an `&` the tokenizer reads as a character without a parse error, any `>`, and `<` in `title` and `textarea`; raw text (`script`, `style`, `noscript`, …) excepted | W | yes | 1 |
| `style/whitespace` | tab indentation, trailing whitespace, and anything but one line break at the end of the file, outside `pre`, `textarea`, `listing`, `plaintext`, `xmp`, `script`, and `style`; option `tabWidth` (default 2) sets the tab stops the fix expands to | W | yes² | 1 |

¹ Automatic, because boolean attributes compare by presence (§8). HTML itself allows only `""` or the attribute name, so `content/attribute-value` still reports `="true"` on native boolean attributes: at info when `booleanValue` is `"true"` (the `strict` default), and as an error in `standard`. Custom-element attributes have no such restriction. Any other value is an error in both profiles. In particular, `disabled="false"` disables the control, because presence means on.
² Where the whitespace is inside a tag, in whitespace-only text, or dropped by the parser (§8). Inside other text, comments, and attribute values it is content: the finding lists those lines without a fix. The end of the file is reported only where one line break changes no content, so not after an open `<p>Text` or at the end of a fragment for a phrasing context.

### 6.3 `content`: HTML conformance

All standard, error in both profiles, M1.

| Rule | Detects |
| --- | --- |
| `content/unknown-element` | neither an HTML element nor a valid custom-element name; valid names go to `component/unknown-element` |
| `content/obsolete` | obsolete elements and attributes (`center`, `font`, `align`, `bgcolor`, …), with the replacement; the spec's "obsolete but conforming" features (`<img border="0">`, `<style type="text/css">`, `<a name>`, …) are warnings |
| `content/unknown-attribute` | attribute not allowed on the element, or not applicable to it (`placeholder` on a checkbox, `target` on `a` without `href`), with JSX hints (`className` → `class`, `htmlFor` → `for`) and typo suggestions; RDFa Lite attributes (`property`, `typeof`, … as in Open Graph tags) are accepted, as the Nu checker does |
| `content/attribute-value` | invalid enumerated, boolean, numeric, date/time, BCP 47, `autocomplete`, `command`, or URL-syntax value; `disabled="false"` still disables; `="true"` on a boolean attribute is accepted by `strict` at info (§6.2) |
| `content/missing-attribute` | required attribute absent (`img[src]`, `optgroup[label]`, `link[rel]`, `link[href]`, `track[src]`, …) |
| `content/child` | child element or text the parent's content model doesn't allow |
| `content/order` | ordered models and counts: `summary` first, `figcaption` first or last, `legend` first, table parts in order, exactly one `title`, at most one `base`, `caption`, `thead`, `tfoot` |
| `content/descendant` | forbidden descendants: interactive content or `[tabindex]` in `a` or `button`, `form` in `form`, `label` in `label`, `header`/`footer`/`main` in `header`/`footer`, headings or sectioning content in `address`, `th`, `dt` |
| `content/context` | element outside its contexts: `li` outside `ul`/`ol`/`menu`, `dt`/`dd` outside `dl`, `figcaption` outside `figure`, `main` not hierarchically correct |
| `content/duplicate-id` | duplicate `id` in one scope (the document, each template's contents, each shadow root) |
| `content/invalid-id` | empty `id`, or one containing whitespace |
| `content/idref` | `for`, `form`, `list`, `headers`, `aria-*` references, `popovertarget`, `commandfor`, `itemref`, `usemap` that don't resolve or name the wrong kind of element (`for` → labelable, `list` → `datalist`, `popovertarget` → `[popover]`, `headers` → `th` in the same table) |
| `content/document` | more than one visible `main`; more than one `meta charset` |

### 6.4 `component`: the Vanilla Breeze contract

All vocabulary, M1, checked against the vocabulary snapshot (§7.4).

| Rule | Detects | strict | standard |
| --- | --- | --- | --- |
| `component/unknown-element` | custom element in neither the vocabulary nor the project's declarations, with the nearest declared name; an ad-hoc `x-*` element is a warning; a child a component's `permittedContent` or `childAttributes` names (`tour-step` in `page-tour`) is accepted inside that component | E | W |
| `component/attribute` | attribute not in the element's manifest (global, `aria-*`, event-handler, and `data-*` attributes are accepted, except a `data-*` one within an edit or two of a declared one); invalid enum value; non-numeric `number`; missing required attribute; a presence boolean written `="false"`, which switches the feature on, or with another value; `childAttributes` values checked on the children they name | E | E |
| `component/content` | children not in `permittedContent`; missing required structure (`accordion-wc` without `details`); a flow-only vocabulary element in phrasing content (`layout-stack` in `p`), which HTML itself allows, since it treats every custom element as phrasing content | E | E |
| `component/output-attribute` | authored attribute the component sets itself (`direction: output`, `purpose: output-state` or `internal-hook`, or `public: false`), such as `page-tour[data-active]` | W | W |

### 6.5 `a11y`: static accessibility

The target is WCAG 2.2 A and AA. A failure is evidence of a criterion failure; a pass is never reported as conformance. Parse errors aren't mapped to the removed SC 4.1.1. All M1.

| Rule | Detects | Auth | strict | standard |
| --- | --- | --- | --- | --- |
| `a11y/lang` | `html[lang]` missing; any `lang` value not well-formed BCP 47 (3.1.1); review: matches the content | S | E | E |
| `a11y/title` | title missing or empty (2.4.2); review: describes the page | S | E | E |
| `a11y/img-alt` | `img`, `input[type=image]`, `area[href]` without `alt`; `role="img"` without a name (1.1.1); every alt gets a review item | S | E | E |
| `a11y/svg` | inline `svg` that is neither `aria-hidden="true"` nor `role="img"` with a name | S | E | E |
| `a11y/name` | name-requiring role without a computed name (§7.5): links, buttons, `iframe`, `dialog`, ARIA widgets (4.1.2); evidence shows the name and its source | S | E | E |
| `a11y/label` | form control without a programmatic label; placeholder only → E, title only → W (1.3.1, 3.3.2) | S | E | E |
| `a11y/aria-role` | unknown or abstract role; role not allowed on the element (ARIA in HTML) | S | E | E |
| `a11y/aria-attr` | unknown, deprecated, or disallowed `aria-*`; wrong value type; missing required state (`role="checkbox"` without `aria-checked`); a name on a role that prohibits one (`aria-label` on `div`, `span`, `p`) | S | E | E |
| `a11y/aria-redundant` | explicit role equal to the implicit one (ARIA in HTML: SHOULD NOT), with an allowlist for known workarounds such as `ul role="list"` | S | W | W |
| `a11y/aria-hidden-focus` | `aria-hidden="true"` on or above a focusable element | S | E | E |
| `a11y/tabindex` | positive `tabindex`; `tabindex="0"` on an element with no role | P | E | W |
| `a11y/headings` | empty heading (E); skipped level (W); first heading of a page isn't `h1` (W) | S/H | E | E |
| `a11y/landmarks` | repeated `nav`, `aside`, or named `section` without distinct names; more than one top-level `header` or `footer` | H | W | W |
| `a11y/link-text` | generic link names ("click here", "read more", "more", "here") in the configured language | H | W | W |
| `a11y/form-group` | two or more radios or checkboxes sharing a `name`, outside `fieldset` + `legend` or a named group | H | W | W |
| `a11y/table` | data table without `th`; a table that looks like layout → review | H | W | W |
| `a11y/media` | `video` without a captions `track` (review); `autoplay` without `muted` (W) | S | W | W |

### 6.6 `semantic`: meaning and native features

All M1.

| Rule | Detects | Auth | strict | standard |
| --- | --- | --- | --- | --- |
| `semantic/generic-control` | `div`, `span`, or custom element acting as a control (`role="button"` or `"link"`, `onclick`, or for `div` and `span` `tabindex="0"`) → `button` or `a`; `tabindex="0"` alone merges into `a11y/tabindex` | H | E | W |
| `semantic/link-href` | `a` without `href`, or with `href="#"` or `""` → `button` for actions, a real URL for navigation | H | E | W |
| `semantic/native-alternative` | ARIA rebuilding a native element: `role="dialog"` → `dialog`, `progressbar` → `progress`, `search` → `search`, an `aria-expanded` disclosure → `details`; text inputs named email, phone, url → matching `type` | H | W | I |
| `semantic/section-heading` | `section` without a heading (W); `article` without one (review) | S | W | I |
| `semantic/heading-candidate` | `p` containing only `strong` or `b`, followed by body text → review "a heading?" | H | R | R |
| `semantic/list-candidate` | three or more consecutive siblings with the same tag and classes → review "a list?" | H | R | – |
| `semantic/br-spacing` | two or more consecutive `br`, `br` at the start or end of a block, or a block holding only `br` | H | W | I |
| `semantic/empty-element` | empty `p`, `li`, `span`, or `div` with at most a `class` | H | W | I |
| `semantic/fragment-link` | `href="#x"` with no `id="x"` (`#` and `#top` excepted) | H | W | W |
| `semantic/placeholder-content` | lorem ipsum, TODO, `[Your …]`, `example.com` links, unresolved `{{…}}`, `{%…%}`, `<%…%>`, `${…}` | H | W | W |

### 6.7 `policy`: house rules

Defaults come from the `xhtml-author` skill. All policy, M1.

| Rule | Detects | strict | standard |
| --- | --- | --- | --- |
| `policy/no-div` | `div`, except `dl > div` → a semantic element with `data-layout`, a Vanilla Breeze element such as `layout-stack`, or styling the parent | E | – |
| `policy/single-h1` | a page without exactly one `h1` | E | – |
| `policy/button-type` | `button` without `type`, which defaults to `submit` | E | – |
| `policy/inline-handler` | `on*` attributes → `command`/`commandfor` or a script module | E | W |
| `policy/javascript-url` | `javascript:` URLs | E | E |
| `policy/inline-style` | `style` attributes | W | – |
| `policy/inline-svg` | inline `svg` → the icon component (`icon-wc`) | E | – |
| `policy/prefer-strong-em` | `b`, `i` → `strong`, `em` when they mean importance or stress; HTML gives `b` and `i` meanings of their own, so this is policy | W | – |
| `policy/head` | `meta charset` not first in `head`; no `meta name="viewport"` | E | – |
| `policy/elements` | elements on the configured denylist (default `iframe`, `object`, `embed`) | – | – |
| `policy/class` | empty `class`; duplicate class tokens | W | I |

### 6.8 `bloat`: structural economy

All policy, warnings, M1; thresholds are configurable. Let *E* be the HTML elements under `body` (a fragment's top level), hidden ones included and `script`, `style`, and template contents excluded, and *N* = |*E*|. **Generic** elements are `div`, `span`, and custom elements whose declaration gives no role, including Vanilla Breeze's `layout-*` elements. Renaming `div` to `x-wrapper` changes nothing; the attribute form, `data-layout` on a semantic element, adds no element at all.

| Rule | Metric | Default threshold |
| --- | --- | --- |
| `bloat/generic-ratio` | generic ÷ *N*; skipped when *N* < 20 | > 0.35 |
| `bloat/wrapper-chain` | longest chain of generic elements in which each is its parent's only element child, with no non-whitespace text beside it | > 3 |
| `bloat/class-count` | most classes on one element; 95th percentile (ascending, index ⌈0.95 *N*⌉ − 1) when *N* ≥ 20 | > 6; > 4 |
| `bloat/depth` | deepest element; children of `body` have depth 1 | > 12 |
| `bloat/size` | *N* per file | > 1500 |

Metrics are reported even when under threshold. Bloat never gets automatic fixes, because removing a wrapper or class can break CSS or scripts the checker can't see.

### 6.9 Nu cross-check

- `--nu` runs `vnu.jar` (the config's `nu.jar`, relative to the config file, or `node_modules/vnu-jar/build/dist/vnu.jar`) once per check, with `--format json`, over every document; fragments are `untested` for it. A Nu message on a line of a local finding, or at another place the finding names in `alsoAt` (where the parser closed an unclosed element, the misplaced child an order error points to), is attached to the nearest one as `related` evidence. A Nu warning on the line of a review item is attached to that item; an error never is, since a question to a person can't account for one. Nu's document-level messages (no doctype, no `lang`, no `title`, the end of the file with elements open) match the local finding wherever each checker places it. The rest become `conformance/nu` findings, verbatim, with Nu's severity, and the report's `tool.nu` names the version.
- Messages htmlverify disagrees with by design are dropped: the trailing-slash info when the house void form is `xhtml` or `tight`; CSS messages, since htmlverify leaves CSS to CSS tools and Nu's CSS checker lags current CSS (`container-type`, `@property`); and the info that an attribute is "never allowed" on an autonomous custom element, which HTML allows.
- Measured on 2026-10-17 (vnu 26.10.12, Java 21): about 1.4 s for one file, mostly JVM startup, and 14 s for the 960 Vanilla Breeze demo pages in one run. On those pages, Nu's messages became 1,167 related notes on findings, 347 on review items, and 41 `conformance/nu` findings, all listed in `test/nu-gaps.json`: 22 notes recommending a single top-level `h1` (`policy/single-h1` covers half of them in `strict`), 18 `slot` attributes on `svg`, and 1 comment that isn't XML-compatible. The first run's gaps are now local rules: `aria-label` on a `label` that labels a control and on a role-less custom element, `aria-disabled` on `a[href]`, `aria-hidden` beside `hidden`, controls inside roles with presentational children, an `itemprop` outside any item, and a required `select` without a placeholder option. Probing Nu with common defects added `meter` and `progress` values out of order, a single-choice `select` with more than one `selected` option, and a width-described `source` without `sizes`.
- A long-running Nu server (`nu.validator.servlet.Main`) for repeated runs, such as the hook's, is left for later.
- Nu stops at its first fatal error ("Cannot recover after last error" after foster parenting), checks only documents, and knows nothing of house style or most accessibility rules. It complements local rules; it doesn't replace them.
- Without Java, `conformance/nu` is `untested` and the status comes from local rules. Registry CI requires Nu.

## 7. Content model, vocabulary, names

### 7.1 Element data

```ts
type ElementSpec = {
  name: string;                                               // HTML-namespace local name
  void?: true;
  categories: Category[];                                     // "flow", "phrasing", "interactive", ...
  categoriesWhen?: Record<Condition, Category[]>;             // a: { "[href]": ["interactive"] }
  content: Grammar;                                           // §7.2
  contentWhen?: Record<Condition, Grammar>;                   // colgroup: { "[span]": "empty" }
  contexts?: string[];                                        // li: ["ul", "ol", "menu"]
  forbidDescendants?: Selector[];                             // a: ["@interactive", "a", "[tabindex]"]
  counts?: Record<string, [min: number, max: number | null]>; // head: { title: [1, 1], base: [0, 1] }
  attributes: Record<string, AttrSpec>;                       // element-specific; globals live in one table
  obsolete?: { use?: string };
  ref: string;                                                // spec URL with anchor
};
```

### 7.2 Child grammars

A grammar is a regular expression over child elements: element names, `@category`, `#text`, `%transparent`, sequence (space), `|`, `?`, `*`, `+`, parentheses, and the keywords `empty` and `text`. Inter-element whitespace and comments always match; `script` and `template` are skipped where the spec says "optionally intermixed with script-supporting elements".

| Element | Grammar |
| --- | --- |
| `table` | `caption? colgroup* thead? (tbody* \| tr+) tfoot?` |
| `dl` | `(dt+ dd+)* \| div+` |
| `details` | `summary @flow*` |
| `figure` | `figcaption @flow* \| @flow* figcaption?` |
| `picture` | `source* img` |
| `hgroup` | `p* @heading p*` |
| `ul`, `ol`, `menu` | `li*` |

Grammars compile to small NFAs. A failed match names the first child with no transition and what would have been accepted: "expected `li`, found `div`".

### 7.3 Context rules

- **Transparent** elements (`a`, `ins`, `del`, `map`, `object`, `audio`, `video`, `canvas`, `slot`) are checked as if replaced by their children, against the nearest non-transparent ancestor, including the fragment context.
- **Descendant prohibitions** walk ancestors, so they apply across component boundaries and fragment contexts.
- **Template contents** and **declarative shadow roots** are separate scopes with their own IDs and metrics and no inherited context.
- **Foreign content** (`svg`, `math`): namespaces and case are handled; internal content models aren't modeled in v1 and appear in coverage as `untested`. The a11y rules for `svg` still apply.
- Elements missing from the data leave content rules `untested` for that subtree.
- Evolving models, such as customizable `select`, follow the pinned snapshot. The parser can lag the spec: parse5 8.0.1 predates the customizable `select` parsing changes and drops `button`, `div`, `legend`, and `selectedcontent` inside `select`, as older browsers do; `syntax/misplaced-start-tag` reports each one.

### 7.4 Custom elements and web components

The vocabulary is Vanilla Breeze's `api.json` registry, compiled into a pinned snapshot (§3.4). At commit `1817856` it declares 134 elements in VB's own classification: 98 web components, 35 custom elements, and one native element (`dl`). VB's `custom-elements.json` isn't enough on its own: it has no content models or enum values, and it lacks 36 elements, `icon-wc` and the `layout-*` family among them.

| `api.json` field | Use in htmlverify |
| --- | --- |
| `element`, `type` | element name; web component, custom element, or native |
| `htmlvalidate.flow`, `.phrasing`, `.permittedContent` | categories and child grammar |
| `attributes[]` with `type: "boolean"` | presence boolean: written `="true"`, removed to turn it off |
| `attributes[]` with `type: "enum"`, `values`, `default` | allowed values; `""` in `values` allows the empty form |
| `attributes[]` with `required`, `type: "number"`, `type: "string"` | required check, numeric check, free text |
| `attributes[]` with `direction: "output"` or `purpose: "output-state"`/`"internal-hook"` | set by the component, never authored (`component/output-attribute`) |
| `childAttributes[]` | attributes allowed on named children (`tour-step[data-placement]`) |
| `structure[]` | expected children, in prose ("`<ul>` or `<ol>`", "any element with data-trigger", optional sources marked only in the description); the requirements a manifest states plainly, and the component's own lookup confirms, are encoded by hand in `src/vocab/overlay.ts`, and `data/vocab-basis.json` pins the text they were written against |

- **Custom elements always have open and close tags.** A vocabulary entry with `void: true` is rejected when the snapshot is built; declare empty content (`permittedContent: []`) instead. VB's `.claude/schemas/elements.json` declares `toggle-thumb` void today. An entry without html-validate data is taken as flow content with any children.
- **Native entries** (`dl`) contribute attribute values only. HTML's content models stay in charge of native elements, so `dl > dl-item`, which VB's own html-validate config permits, is still a `content/child` error; `dl > div` is the conforming form.
- **Opt-out booleans** are on by default and turned off with `="false"`. They must be declared `enum` with `values: ["true", "false"]` and a `default`, because their `="false"` is meaningful, unlike a presence boolean's. Several are typed `string` today (`carousel-wc[indicators]`, `geo-map[marker]`), so their values can't be checked until the manifest changes.
- **Static checks see markup before upgrade.** Under progressive enhancement, the authored markup must already be valid and accessible without JavaScript. The upgraded DOM is checked at runtime in M4.
- **Semantics stay native.** Custom elements carry intent for authors and CSS, but assistive technology sees `generic` unless script assigns a role. So components put native semantics inside them, as `accordion-wc` does with `details` and `summary`.
- **Project additions.** Project-specific elements go in `<registry>/elements.json` (the html-validate subset: `flow`, `phrasing`, `permittedContent`, and `attributes` with `required`, `enum`, `boolean`, and `omit`), plus `role` (default `generic`) and `description`. Unknown keys and regular-expression `enum` values are errors, and so is a name a configured vocabulary already defines. The declared `role` is the one script gives the element after upgrade; the static rules use it only to decide whether the element is generic (§6.8). Ad-hoc elements with the configured prefix (`x-`) are accepted as flow and phrasing content with any children, count as generic, and draw a warning.

### 7.5 Accessible names

A static subset of Accessible Name 1.2 for HTML:

1. Skip hidden content (`hidden`, `aria-hidden="true"`, template contents) unless it's reached through `aria-labelledby`.
2. `aria-labelledby`: concatenated text of the referenced elements.
3. `aria-label`, trimmed, if non-empty.
4. Native sources: `label` (explicit `for` and wrapping), `alt`, `value` or the default label of `input` buttons, `legend`, `caption`, `figcaption`, `summary`, `iframe[title]`, `svg > title`.
5. Content, for roles named from content (`button`, `link`, `heading`, `cell`, `tab`, `option`, …), including the `alt` of nested images.
6. `title`, then `placeholder`. Both are computed, and `a11y/label` still flags them.

CSS isn't evaluated, so text hidden or generated by CSS is invisible to this computation; the M4 runtime check closes that gap. Each name finding carries the computed name and the step that supplied it.

## 8. Fixes

- `fix` works in rounds: it checks, applies every proposed fix that doesn't conflict with an earlier one, reparses, and keeps the round only if the tree is unchanged and no rule has more errors. Otherwise it bisects the round to find the fixes that don't hold, keeps those as suggestions, and applies the rest. Rounds repeat, up to five, because one fix can reveal another: an end tag inserted at the end of the file, then the final newline. On the 960 Vanilla Breeze demo pages, it applies 2,898 fixes, keeps none as suggestions, and a second run changes nothing.
- Explicit tags go where the parser placed them. A start tag goes before the implied element's first content. An end tag goes before the token that closed the element, after any whitespace the element holds, so the whitespace stays inside it. An implied element's written end tag (`</body>` after an implied `<body>`) counts as present. Tags that meet at one offset form one edit, in the parser's order: end tags innermost first, then start tags outermost first, with an empty element's end right after its start. No end tag is proposed inside a `<textarea/>` or `<script/>` that swallowed the rest of the file; `syntax/self-closing-non-void` explains that.
- Only **tree-preserving** fixes apply automatically. htmlverify applies the edits in memory, reparses with the same settings, and compares trees: node types, namespaces, names, attributes with exact values, text, comments, child order, document mode. Two things may differ. Boolean attributes compare by presence. Whitespace-only text outside `pre`, `textarea`, `listing`, `plaintext`, `xmp`, `script`, and `style` may hold other whitespace, but must stay present, except that one such node may appear or disappear at the end of `body`, or of a fragment whose context element isn't phrasing content; under `white-space: normal` none of this renders differently. Nothing else may differ. If the trees differ or a new error appears, the fix is dropped and reported as a suggestion.
- Fixable: quoting, lowercase names, void-element form, boolean form, doctype form, explicit start and end tags (inserted where the parser placed them), escaping, whitespace between blocks. A boolean's form is visible only to value selectors such as `[disabled=""]` and to `getAttribute` string reads; Vanilla Breeze uses presence selectors and `hasAttribute`.
- `htmlverify fix page.html` prints a unified diff; `--write` applies it atomically (temp file, then rename). Running it twice changes nothing the second time.
- Everything else, such as replacing elements, changing roles or heading levels, adding labels or alt text, or removing wrappers or classes, is a suggestion in the message, never an edit.
- For assembled output, fixes target the plan or the component, never the generated HTML (§9.8).

## 9. Assembler

### 9.1 Roles

- **Component authors** are experts, optionally assisted by AI. They write and test components, and a human approves each version.
- **The LLM** (or a person) reads the catalog, writes a plan, assembles it, and repairs the plan from findings.
- **The assembler** owns the markup: escaping, IDs, heading ranks, attribute forms, formatting.

### 9.2 Registry layout

```text
registry/
  elements.json              project-specific custom elements (§7.4); Vanilla Breeze comes from the snapshot
  components/
    form/text-field/
      component.json         contract (§9.4)
      template.html          template (§9.3)
      fixtures/basic.json    data for one rendering
      fixtures/basic.html    expected output
      README.md              when to use it, and when not
      style.css, script.js   optional page dependencies, listed in the assembly report; not checked
```

A component's ID is its path under `components/`. A component without parameters is a snippet: fixed, reviewed markup. Compiled templates are cached by digest in `.htmlverify/cache/`; these are the preprocessed bricks.

### 9.3 Template language

Templates are HTML, parsed by parse5 in the component's `context`. The directives are few on purpose:

| Syntax | Meaning |
| --- | --- |
| `{{label}}`, `{{item.href}}` | Insert a parameter. In text it becomes a text node, or parsed nodes for `inline` and `prose`. As a whole attribute value it binds the attribute: an absent optional parameter omits it, and a boolean gives `="true"` or omits it. Inside a longer value it works for text attributes and `class` tokens only. |
| `<template vb-if="hint">`, `vb-if="!hint"` | Children render when a boolean is true or an optional parameter is present. |
| `<template vb-each="items" vb-as="item">` | Children repeat for each list item. |
| `<template vb-slot="fields"></template>` | Child components from the plan go here. |
| `id="@input"`, `for="@input"`, `aria-describedby="@hint @error"` | Local ID symbols, turned into deterministic IDs (§9.6). `@` alone is the instance's own ID, and `href="#@"` links to it. |
| `<h2 vb-rank>`, `vb-rank="+2"` | A heading whose level comes from where the component sits (§9.6). |

`<template>` carries the directives because the parser accepts it everywhere, including in `table`, `tbody`, `select`, and `head`, and keeps its contents inert. `<tbody><template vb-each="rows" vb-as="row"><tr>…</tr></template></tbody>` parses as written (verified in the spike). A custom placeholder element in the same spot would be foster-parented out of the table.

Compile errors:

- Paths are `name` or `name.field`; there are no expressions, filters, or helpers.
- No interpolation in `script`, `style`, comments, tag or attribute names, or in `on*`, `style`, and `srcdoc` attributes.
- Delimiters are found in the raw source, so `&#123;&#123;` stays literal text.
- Every parameter used is declared, and every declared parameter is used.
- Every attribute is valid for its element (spec data plus the vocabulary); every bound attribute's parameter type fits its sink (§9.5); every `enum` value is valid for the attribute it binds.
- Non-page components contain no literal `id` or `h1`–`h6`. They use `@` symbols and `vb-rank`, which keeps them reusable anywhere.
- The template parses without errors in its context. Its elements are HTML's or the vocabulary's, and its attributes exist on their elements.
- A directive `<template>` carries exactly one of `vb-if`, `vb-each` (with `vb-as`), or `vb-slot`, and nothing else. `vb-if` takes a boolean or an optional parameter without a default; `vb-each` takes a list, and its `vb-as` name hides no parameter or outer item. A slot appears once, empty, and not inside `vb-each`.
- `id="@name"` defines a symbol once, outside `vb-each`, and every `@` reference names a defined symbol. Non-page components refer to IDs only through symbols and `ref` parameters. `vb-rank` is empty or `+1` to `+5`.
- A page component is one whose `context` is `document`; its template is a whole document.

Comments aren't written to the output. Whitespace-only text is dropped where it can't render (§9.9), looking through directives; elsewhere it's kept, and the serializer re-indents it. The file's own leading and trailing whitespace is dropped.

Example, `form/text-field/template.html` in the house style:

```html
<form-field>
  <label for="@input">{{label}}</label>
  <input id="@input" type="{{type}}" name="{{name}}" autocomplete="{{autocomplete}}" required="{{required}}" aria-describedby="@hint" />
  <template vb-if="hint">
    <output id="@hint" for="@input">{{hint}}</output>
  </template>
</form-field>
```

Without a `hint`, the `output` isn't rendered and `@hint` is pruned from `aria-describedby` (§9.6), so the reference can't dangle.

### 9.4 Contract

```json
{
  "id": "form/text-field",
  "version": "1.0.0",
  "summary": "Labeled single-line input with an optional hint.",
  "use": "Single-line text, email, phone, URL, search, or password input. For choices use form/choice-group.",
  "context": "form",
  "params": {
    "label": { "type": "text", "minLength": 1 },
    "name": { "type": "text", "pattern": "^[a-z][a-z0-9_-]*$" },
    "type": { "type": "enum", "values": ["text", "email", "tel", "url", "search", "password"], "default": "text" },
    "autocomplete": { "type": "enum", "values": ["name", "email", "tel", "organization", "street-address", "postal-code", "username", "current-password", "new-password", "off"], "required": false },
    "required": { "type": "boolean", "default": false },
    "hint": { "type": "inline", "required": false }
  },
  "slots": {},
  "budget": { "elements": 4 },
  "obligations": ["The label names the expected input."],
  "provenance": {
    "authors": ["…"],
    "aiAssisted": true,
    "review": { "by": "…", "date": "2026-10-20", "digest": "sha256-…" }
  }
}
```

- A parameter is required unless it has a `default` or `"required": false`.
- `context` is the parent element for parsing the template and checking fixtures: `body` by default, `tbody` for rows, `ul` for list items.
- Versions follow semver: removing or retyping a parameter or slot is a major change.
- Parameter, slot, and record-field names are letters and digits starting with a lowercase letter (`label`, `linkText`); parameters and slots share one namespace. A list's `items` is a scalar type other than `enum`, or a record of fields. Unknown keys are errors, and every problem is reported at once with its JSON Pointer.
- `budget.elements` caps the elements one instance renders from its template, repetitions included; markup from `inline` and `prose` values and the children in its slots don't count.
- The digest is SHA-256 over the canonical contract (minus `review`), the template, and the fixtures. When the current digest differs from the reviewed one, the component is **stale**. `strict` rejects stale and unreviewed components; the `draft` option allows them with a warning.

### 9.5 Parameter types and sinks

| Type | Value | Allowed sinks |
| --- | --- | --- |
| `text` | string; `minLength`, `maxLength`, `pattern` | text, RCDATA (`title`, `textarea`), plain-text attributes (`alt`, `title`, `aria-label`, `placeholder`, `name`, `value`, `content`, `label`, `data-*`) |
| `inline` | restricted phrasing HTML | text positions that accept phrasing content |
| `prose` | restricted flow HTML | the sole content of a flow container |
| `url` | string, parsed by WHATWG `URL` against the configured base | `href`, `src`, `action`, `formaction`, `cite`, `poster`, `data` |
| `boolean` | `true` or `false` | boolean attributes (rendered `name="true"` or omitted), `data-*` attributes nothing types (present or omitted, as in `li[data-completed]`), `vb-if` |
| `enum` | one of `values` | enumerated attributes (values checked against the spec data or the vocabulary), `class`, and `data-*` attributes nothing types, whose values are the author's |
| `integer` | number; `min`, `max` | numeric attributes (`width`, `height`, `colspan`, `rows`, …), and `min`, `max`, and `value` on a number or range input |
| `datetime` | HTML date/time microsyntax | `time[datetime]`, `ins[datetime]`, `del[datetime]` |
| `lang` | well-formed BCP 47 tag | `lang`, `hreflang` |
| `ref` | `{ "ref": "key/path" }`, another instance's ID; `accepts` lists the components it may name | ID-reference attributes (`commandfor`, `popovertarget`, `aria-controls`, …); in `href` it becomes `#id` |
| `list` | array; `items` is a type or a record of fields; `minItems`, `maxItems` | `vb-each` |

- **URL policy** (configurable): `https`, `http`, `mailto`, `tel`, relative, and fragment URLs. `javascript:` is rejected; `data:` is opt-in for images. Fragment URLs must resolve to an ID in the assembled page. Parsing proves syntax, not trust.
- **Never bindable**: `on*`, `style`, `srcdoc`, `srcset` and `sizes` (until a dedicated type exists), `script` and `style` contents, element and attribute names. There is no raw-HTML type.
- **`inline` allowlist**: `a[href hreflang]`, `abbr[title]`, `b`, `bdi`, `br`, `cite`, `code`, `data[value]`, `del`, `dfn`, `em`, `i`, `ins`, `kbd`, `mark`, `q[cite]`, `s`, `samp`, `small`, `span`, `strong`, `sub`, `sup`, `time[datetime]`, `u`, `var`, `wbr`, plus the global `lang`, `dir`, and `title`. No `id`, `class`, `style`, or event attributes.
- **`prose` allowlist**: the `inline` list plus `p`, `ul`, `ol[start reversed]`, `li`, `dl`, `dt`, `dd`, `blockquote[cite]`, `pre`, `hr`, `h2`–`h6`. Prose headings are relative: the highest-ranked one becomes context + 1, the others keep their offsets, and skipped levels are errors.
- **Text attributes**: `alt`, `title`, `aria-label`, `aria-description`, `aria-roledescription`, `aria-valuetext`, `placeholder`, `name`, `value`, `content`, `label`, `abbr`, `data-*`, and custom-element attributes the vocabulary types as strings or leaves untyped. Only these and `class` take text around a binding (`title="Fish & {{dish}}"`, `class="card {{variant}}"`); in `class` the binding is an `enum` of single tokens. ARIA states aren't boolean attributes, so `aria-expanded` binds an `enum` of `"true"` and `"false"`. Every `enum` value must be valid for the attribute it binds, by the spec data, the ARIA data, or the vocabulary. `integer` binds attributes whose value type is an integer or a floating-point number, the limits and value of an input whose static type is number or range (the attribute index lists them as varying), and custom-element attributes typed as numbers.
- **Values**: strings exclude control characters other than tab and line feed, carriage returns (write `\n`), lone surrogates, and noncharacters. A `url` has no surrounding spaces and passes the same URL syntax check as `content/attribute-value`, so assembly can't produce one that the checker rejects; its scheme is checked after parsing, so `jav&#x09;ascript:` and `JaVaScRiPt:` are caught too.
- Restricted HTML is **validated, not sanitized**. An element outside the allowlist, a parse repair, or any `strict` error fails assembly, with the location inside the value. Nothing is silently dropped. The style rules are the exception: they judge how a value is written (quotes, case, `<br />`, boolean values), which the serializer rewrites in the house style anyway, and the output check applies them to what it writes.

### 9.6 Composition rules

**Slots.** What fits a slot comes from its position in the template, via the content model: a slot inside `<ul>` takes components whose roots are `li`; a slot inside `<p>` takes phrasing roots. A contract can narrow a slot further with `accepts` (component IDs), `min`, and `max`. For an early, specific error, the assembler pre-checks each child's roots while it validates the plan, from the slot's ancestors in its template and its instance's own place: lists, tables, and other parents with fixed children take only those, phrasing parents (looking through transparent ones such as `a`) take phrasing roots, and `form`, `a`, and `button` never nest, at any depth. The full check of the output (§9.8) has the final word.

**Keys.** Every component instance in a plan has a `key` matching `[a-z][a-z0-9-]*`, unique among all children of its parent instance, across slots.

**IDs.** In the instance with key path `contact/email`, `@input` becomes `contact-email-input` and `@` becomes `contact-email`. These IDs are readable in CSS and URLs, stable across runs, and unaffected by inserting siblings. A collision anywhere in the output is `assembly/id-collision`; changing a key fixes it.

**Dangling references.** A symbol whose element doesn't render (inside a false `vb-if`) is removed from space-separated reference lists (`aria-describedby`, `aria-labelledby`, `aria-controls`, `headers`), and an emptied attribute is omitted. In a single-ID attribute (`label[for]`, `commandfor`, `popovertarget`, `list`, `form`) it's an error.

**Heading ranks.** Instantiation runs in document order and tracks a current rank per instance, starting at the rank the instance received; a page starts at 0. A literal heading (page components only) sets the current rank to its level. An `vb-rank` heading renders at the received rank + 1 (or + n) and sets the current rank to that. A slot's children receive the current rank at the slot's position. A rank above 6 is `assembly/heading-depth`. Heading levels are correct by construction, however deep the nesting.

**HTML nodes.** A plan node `{ "key": "…", "html": "…" }` inserts hand-written HTML where no component fits. It's parsed in its insertion context, must pass `strict` apart from the style rules (§9.5), and can't contain `script`, `style`, or event attributes. Each one is reported as a registry gap (§13). A project can forbid them with `"htmlNodes": false`.

### 9.7 Plan

```json
{
  "page": {
    "use": "page/basic",
    "data": { "lang": "en", "title": "Contact us · Acme", "description": "How to reach Acme support.", "heading": "Contact us" },
    "slots": {
      "header": [
        { "use": "nav/primary", "key": "nav", "data": { "label": "Main", "items": [
          { "text": "Home", "href": "/" },
          { "text": "Contact", "href": "/contact", "current": true }
        ] } }
      ],
      "main": [
        { "use": "content/prose", "key": "intro", "data": { "html": "<p>We reply within <strong>one business day</strong>.</p>" } },
        { "use": "form/form", "key": "contact", "data": { "action": "/contact", "method": "post" }, "slots": {
          "fields": [
            { "use": "form/text-field", "key": "name", "data": { "label": "Name", "name": "name", "autocomplete": "name", "required": true } },
            { "use": "form/text-field", "key": "email", "data": { "label": "Email", "name": "email", "type": "email", "autocomplete": "email", "required": true } },
            { "use": "form/textarea-field", "key": "message", "data": { "label": "Message", "name": "message", "required": true } }
          ],
          "actions": [
            { "use": "action/submit", "key": "send", "data": { "label": "Send message" } }
          ]
        } }
      ]
    }
  }
}
```

- `use` can pin a version (`@1.0.0`) or a major (`@1`); without a pin, the registry's current version is used. Reports record the exact version and digest of every component.
- A fragment plan has `"fragment": { "context": "main", "rank": 1, "children": [ … ] }` instead of `page`. `rank` is the level of the heading the fragment sits under, 0 to 5 and 1 by default, so its first ranked heading is an `h2`.
- Unknown properties are errors at every level, so typos fail loudly.

### 9.8 Assembly algorithm

1. Validate the plan against its schema; errors carry JSON Pointers.
2. Resolve components and check their review status against the profile, once per component.
3. Validate each instance's `data` against its parameters and its `slots` against the contract; pre-check slot fit.
4. Instantiate top-down into an in-memory tree. Every node records its origin: instance key path, component and version, template line and column, data JSON Pointer. Compute heading ranks, allocate IDs, resolve `ref`s, prune dangling reference tokens. Errors from steps 1 to 4 end assembly before the output is checked: they leave known gaps, such as a link whose `ref` didn't resolve, that the check would only repeat.
5. Serialize (§9.9).
6. Reparse the output and compare it with the in-memory tree, ignoring only whitespace the serializer may add or re-indent (§9.9) and trailing whitespace at the end of `body` or of a fragment, where the final line breaks go. Boolean attributes compare by presence; everything else is exact, attribute order included. Where the parser restructures the output, as when a block closes the paragraph it was put in, the tree-changing syntax findings of step 7 explain the difference and are traced like any other finding. Any other difference is `assembly/round-trip`, an assembler bug.
7. Check the output, as a document or as a fragment in the plan's context, under the configured profile.
8. Map each finding to its origin and classify it:
   - **plan**: wrong data or component choice → fix the plan;
   - **component**: a defect inside one component → the component needs repair and re-review, and no plan change fixes it;
   - **composition**: components that don't fit together → pick different components or slots.

   The element written around a finding's offset gives its origin. A finding is **plan** when that element came from data or an HTML node, when the attribute it names was bound from data, or when a text rule (link text, names, placeholders, empty elements) fires on text from data. It's **composition** when a structural rule (content model, context, landmarks, headings, sections) or a tree-changing parse error crosses from one instance into another, or when the parser moved another instance's element out of the one the finding is on; the origin is then the element that doesn't fit. Anything else is **component**.
9. Write the HTML only when the status is `pass`. Otherwise write nothing and return the report; `--emit-failed` writes `name.failed.html` for inspection.

```json
"origin": { "kind": "component", "component": "form/text-field@1.0.0", "template": "template.html:3:3", "instance": "contact/email", "plan": "/page/slots/main/1/slots/fields/1" }
```

Assembly rules:

| Rule | Error |
| --- | --- |
| `assembly/plan` | the plan isn't valid JSON, in which case the message names a bracket that doesn't pair up, or it violates its schema |
| `assembly/component` | unknown component or version; unreviewed or stale under `strict` |
| `assembly/data` | parameter missing, unknown, of the wrong type, or out of its constraints |
| `assembly/slot` | unknown slot, wrong count, or a child that doesn't fit |
| `assembly/key` | key missing, malformed, or duplicated |
| `assembly/ref` | `ref` to a missing instance, or to one without an `@` ID |
| `assembly/id-collision` | two elements end up with the same ID |
| `assembly/heading-depth` | a heading would need rank 7 or more |
| `assembly/restricted-html` | an `inline`, `prose`, or HTML-node value breaks its allowlist or `strict` |
| `assembly/budget` | an instance exceeds its component's element budget |
| `assembly/round-trip` | the reparsed output differs from the built tree |

### 9.9 Serializer

- Output satisfies the `strict` style rules by construction: lowercase, double quotes, `name="true"` booleans, the configured void form (`<br />`), explicit tags, `<!doctype html>`, LF line endings, UTF-8 without BOM, final newline.
- Layout: an element whose children are all block items, apart from whitespace that can't render, is laid out as a block: each child on its own line, indented 2 spaces, with `head` and `body` kept at the level of `html`. A block item is a comment or an element that isn't inline-level. Inline-level elements are HTML phrasing content (except `script`, `template`, `link`, and `meta`, which draw nothing), custom elements the vocabulary calls phrasing or doesn't know, unknown elements, and the `svg` and `math` roots; inside foreign content nothing is. Mixed content is written as built, except that whitespace that can't render is dropped, a line break goes beside each block-level child and inside the edges of a block-level container that breaks anywhere, never next to text, and whitespace-only text with a line break is re-indented to its depth. So whitespace appears only where it can't render or already was, and trees that differ only in such whitespace serialize alike.
- `pre`, `textarea`, `listing`, `title`, the raw-text elements (`script`, `style`, …), SVG text elements, and MathML token elements are written exactly; content starting with a newline in `pre`, `textarea`, or `listing` gets the extra newline the parser strips. Foreign elements without children close themselves (`<path />`). A fragment ending in text gets no final newline, which would join that text.
- Escaping: `&`, `<`, `>` in text; `&`, `"`, `<`, `>` in attribute values. U+00A0 is written `&nbsp;` so it stays visible in source.
- Attributes keep template order.

### 9.10 Component lifecycle

| Command | Does |
| --- | --- |
| `component new <id> --author <name>` | scaffolds a contract, a template, a fixture, and a README |
| `component show <id>` | prints the contract and an example: the basic fixture as a plan instance, and what it renders |
| `component check <id> [--update] [--nu]` | compiles the template; renders each fixture and checks it in context (`strict` with no errors, plus Nu inside a page shell with `--nu`); compares it with the expected output, which `--update` writes for review; checks the budget; reports **branch coverage**: each `vb-if` both ways, each `vb-each` with 0 (if allowed), 1, and 2+ items, each optional parameter given and left out, both booleans, and each value of an enum that reaches text or a `class` token, with list items' fields counted across all items. An enum that only fills attribute values needs no fixture per value: the compiler already checked each value against its attribute, and nothing else changes. It passes only when approval would. |
| `component approve <id> --by <name>` | requires a clean check and full coverage; records reviewer, date, and digest in `provenance.review`, leaving the rest of `component.json` as written |
| `registry check` | checks every component and requires each to be approved at its current digest; this is the CI gate |

A fixture, `fixtures/<name>.json`, is `{ "data": { … }, "slots": { … }, "with": [ … ] }`, each one optional. It renders as a fragment plan: the component in its `context`, keyed by the fixture's name, so `@input` becomes `basic-input`, with plan children in its slots, then the siblings in `with`, such as the targets of its refs. A page component's fixture is a page plan. Plan findings point into the fixture file, and `fixtures/` holds nothing else, since all of it is in the digest.

**AI-assisted authoring**: the LLM drafts a component and its fixtures and iterates with `component check` until it's clean; a human reviews and approves it. `aiAssisted` records the assistance, and the approval is the trust boundary.

### 9.11 Starter registry (M2)

Enough to build the page set in §13, on Vanilla Breeze 0.3.1. It ships in `registry/`, and the CLI uses it when the config names no registry; once installed it's read-only, so a project's own components go in a registry of its own. Native elements come first wherever a VB element needs its script for its semantics: `nav-bar` and `bread-crumb` become landmarks only when their scripts run, so navigation is a native `nav`. VB has no callout element; `status-message` has the tones. The page shell links VB's stylesheet, script, and icons.

| Group | Components (markup) |
| --- | --- |
| page | `page/basic`: charset first, viewport, color scheme, title "Title \| Site" (the site name alone when there's no title, as on the home page), description, `lang`, VB stylesheet, module script, and icon path, a skip link with the CSS VB doesn't ship, a site header with the home link and a `nav` slot, `main` with the `h1`, and a footer slot. `page/article`: the same shell, with `main` holding an `article.blog` whose header has the `h1`, subtitle, and byline in an `hgroup.byline`, and an `after` slot below the article |
| navigation | `nav/primary` (`nav.horizontal` around a list), `nav/breadcrumb` (`nav.breadcrumb` around an `ol`), `nav/pagination` (`nav.pagination` links), `nav/toc` (`page-toc` in its manual form, linking sections by ref), `nav/steps` (`nav.steps` around an `ol`, with `data-completed` and `aria-current="step"`) |
| content | `content/section` (ranked heading, ID, `data-layout="stack"`), `content/prose` (`layout-text`), `content/figure`, `content/image`, `content/callout` (`status-message`), `content/card-list` (`layout-card` in a grid list), `content/faq` (`accordion-wc` with `details` and `summary`), `content/quote` (`figure.quote`, its author optional for a pull quote), `content/address` (`address.contact`), `content/result-list` (an `ol` of ranked, linked headings) |
| data | `data/table` (`data-table` around a `table` with a caption and scoped headers), `data/description-list` (`dl`) |
| forms | `form/form` (`form.stacked`, actions in `footer.actions`; without an `action` it submits to its own page), `form/text-field`, `form/textarea-field`, `form/select-field`, `form/number-field`, `form/file-field` (each in `form-field`, with hint and error `output`s), `form/choice-group` and `form/checkbox-group` (radios or checkboxes in a `fieldset` with a `legend`), `form/checkbox`, `form/fieldset` (a `legend` over stacked fields), `form/search` (a `search` landmark around an inline `get` form) |
| actions | `action/button` (`command` and `commandfor`, to a dialog), `action/submit`, `action/link-button` (`a.button`) |
| overlays | `disclosure/details`, `disclosure/tabs` (`tab-set` over `details`), `dialog/modal` (`dialog` named by its heading, closed by invoker buttons; runtime checks in M4) |
| site | `site/footer` (`footer.minimal` with contact details in `address.footer`, `site-legal`, and a `nav` for other links) |

The first condition C pilot (§13) shaped it: `page/article`, `content/address`, `content/result-list`, `nav/steps`, and five form components cover what its pages had to write as HTML nodes or leave out, and a form's `action`, a quote's author, and a footer's legal links became optional, since the content doesn't always have them. Two things stay out because a contract can't promise them yet: a preselected option or radio, since nothing says only one item may be selected, and a starting value for a text field, whose validity depends on its type.

Every component's fixtures also pass Nu. Its one warning, "Section lacks heading", is on the body `section` of `dialog/modal`, which VB pads and which `aria-labelledby` names after the dialog's title. Nu doesn't count `aria-labelledby`; `semantic/section-heading` does, and Nu's alternative, a `div`, is what `policy/no-div` forbids.

## 10. Interfaces

### 10.1 CLI

```sh
htmlverify check page.html [more.html …] [--profile strict|standard] [--config file] [--nu] [--format text|json]
htmlverify fix page.html [more.html …] [--write] [--context tag] [--format text|json]   # diff to stdout, summary to stderr
htmlverify check - --stdin-name page.html          # read from stdin
htmlverify check row.html --context tbody          # a context makes it a fragment
htmlverify fix page.html [--write]
htmlverify explain a11y/label
htmlverify rules [--profile strict] [--format json]
htmlverify catalog [--query form] [--format text|json]
htmlverify component new <id> --author <name>
htmlverify component show|check <id> [--update] [--nu]
htmlverify component approve <id> --by <name>
htmlverify registry check
htmlverify vocab update vanilla-breeze --from <checkout> [--out file]  # rebuild the vocabulary snapshot (§3.4)
htmlverify assemble plan.json [--out page.html] [--emit-failed] [--draft] [--format text|json]   # without --out, the page goes to stdout
htmlverify init [--claude] [--profile strict|standard] [--force]   # config; with --claude, also the skill and hook
htmlverify hook claude                             # Claude Code hook adapter (§10.4)
htmlverify mcp                                     # MCP server on stdio (§10.3)
```

Results go to stdout, logs to stderr. `check` never modifies files. Globs are expanded by htmlverify in sorted order, and a pattern that matches nothing is an input error.

`catalog` is what the LLM reads before writing a plan, one line per component. `?` marks an optional parameter, `=` an enum's values, parentheses a type other than text or a list's fields, and `[min..max]` a count; a component that isn't approved says so.

```text
form/form@1        Form. data: action(url), method?=get|post. slots: fields[1..], actions[1..](action/submit).
form/text-field@1  Labeled single-line input. data: label, name, type?=text|email|tel|url|search|password, autocomplete?=name|email|tel|organization|off, required?(boolean), hint?(inline).
```

### 10.2 Configuration

`htmlverify.config.json` is read from the working directory or its nearest ancestor; home-directory and global configs are never read.

```json
{
  "extends": "strict",
  "vocabularies": ["vanilla-breeze@0.3.1"],
  "registry": "registry",
  "options": { "voidElements": "xhtml", "booleanValue": "true", "adHocPrefix": "x-", "linkTextLanguage": "en" },
  "rules": { "policy/inline-svg": "off", "bloat/class-count": ["warning", { "max": 8 }] },
  "nu": { "jar": "node_modules/vnu-jar/build/dist/vnu.jar" },
  "maxWarnings": null
}
```

Unknown keys, unknown rules, and invalid severities are errors. Every report includes the resolved config's hash, and scores are comparable only between equal hashes. `registry` is relative to the config file; M1 reads its `elements.json` (§7.4), and M2 its components. `"htmlNodes": false` forbids HTML nodes in plans (§9.6).

**Profiles.** `standard` runs the syntax, content, a11y, and semantic rules, which are fair to any HTML. `strict` adds the style and policy rules with the house defaults. Custom profiles extend either one.

### 10.3 MCP server (M3)

`htmlverify mcp [--draft] [--emit-failed] [--structured] [--config file]` speaks JSON-RPC over stdio, one message per line. It's written directly, in about 350 lines: `initialize`, `ping`, `tools/list`, and `tools/call`, with protocol versions 2024-11-05 to 2025-11-25. If protocol churn makes upkeep costly, swap in the official SDK. The config and registry are read once, at startup. Tools accept HTML or a plan inline or as a path, so they work without a shared filesystem; paths are relative to the server's working directory and can't leave it.

| Tool | Input → output |
| --- | --- |
| `check_html` | `{ html \| path, context?, profile? }` → report; without a context, input that doesn't start as a document is checked inside `body`, as the hook does |
| `fix_html` | `{ html \| path, context? }` → fixed HTML and the findings left; nothing is written |
| `list_components` | `{ query? }` → catalog |
| `get_component` | `{ id }` → contract, example plan, rendered example |
| `assemble` | `{ plan \| path, out? }` → report, with the page written to `out` when it passes, or else returned |
| `explain_rule` | `{ rule }` → explanation |

Each result is the text format. With `--structured`, from protocol version 2025-06-18, it also carries the JSON as `structuredContent`. That's off by default because Claude Code hands a model the structured content instead of the text: in the first pilot the catalog reached the model as 24 KB of JSON instead of 4 KB of text, and the text is also what says what to do next. Programs that want the JSON can use the library or `--format json`. A bad call, such as an unknown argument, a path outside the working directory, or an unknown component or rule, is a tool error the model can correct, not a protocol error. `--draft` and `--emit-failed` mean what they mean for `assemble`. The server sets them, not the model, so a model can't choose to assemble unreviewed components. The server's instructions summarize §11.

### 10.4 Claude Code integration (M1)

- **Skill**: `.claude/skills/htmlverify/SKILL.md` holds the workflow in §11, how to read findings, and the rules of engagement: fix the cause, not the rule; never disable rules, add waivers, or invent alt text, labels, or review answers.
- **Hook**: a `PostToolUse` hook runs after every write and checks the `.html` file the tool changed (`tool_input.file_path`, absolute). On failure it exits 2 with the text report and the matching `fix` command on stderr, which Claude Code shows to the model, so verification doesn't depend on the model remembering to run it. A passing or unreadable file exits 0, and a malformed event exits 1, which doesn't block. It reads the config nearest the file. A file that doesn't start with a doctype or `<html>` is a fragment, checked as `body` content. `init --claude` writes the skill and merges this entry into `.claude/settings.json`, beside any hooks already there:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "npx htmlverify hook claude", "timeout": 60 } ] } ] } }
```

- The existing skills (`xhtml-author`, `forms`, `patterns`, `custom-elements`) keep explaining the house style; htmlverify enforces it. When a skill's prose and the config disagree, the config wins and the skill gets fixed. They disagree today, and the skills change: the `forms` skill writes bare `required`, while `xhtml-author` prescribes `checked=""`, lists `checked="true"` as wrong, and writes `<br/>`. The config's `="true"` and `<br />` win.

### 10.5 Library

```ts
check(input: CheckInput, options?: CheckOptions): Promise<Report>;
fix(input: CheckInput, options?: FixOptions): Promise<FixResult>;
assemble(plan: unknown, options: AssembleOptions): Promise<AssemblyResult>;  // plan: parsed JSON or its text; options.registry: a Registry or its directory
catalog(registry: string | Registry, query?: string): ComponentSummary[];  // openRegistry(dir, config) loads one to reuse
explain(rule: string): RuleDoc;
```

Findings are results, not exceptions; only invalid arguments throw. Everything works in memory without writing files.

## 11. LLM workflow

1. Read `htmlverify catalog`.
2. Write a plan with the fewest components that express the content and intent, and supply content as typed data.
3. Run `htmlverify assemble`. Fix **plan** findings in the plan; pick other components for **composition** findings; report **component** findings to the user, since the brick itself is defective.
4. Where nothing fits, use a minimal HTML node and mention the gap.
5. When editing existing HTML instead: `check`, `fix --write` for mechanical issues, edit the rest, `check` again.
6. Stop after 3 repair rounds, or when the same finding survives two rounds, and report what remains.
7. Hand back the result with its status and open review items.

## 12. Testing

### 12.1 Fixtures

`test/fixtures/<family>/<rule>/<case>.html` with `<case>.json` holding the expected canonical findings. Every rule has at least one failing, one passing, and one boundary case. `UPDATE_GOLDEN=1` rewrites expectations, which are then reviewed in the diff.

### 12.2 Regression matrix

| Case | Expected |
| --- | --- |
| `class=card`, `class='card'`, `class="card"` | `style/attr-quotes` twice, then clean; all three trees are identical |
| `disabled`, `disabled=""`, `disabled="disabled"`, `disabled="true"`, `disabled="false"` | `style/boolean-attr` three times (fixed to `="true"`); clean in `strict` apart from an info note, and an error in `standard`; `content/attribute-value` (the control *is* disabled) |
| `<p>a<p>b`, `<ul><li>a<li>b</ul>` | only `style/explicit-end-tag`; both are valid HTML |
| `<p>a<div>b</div>c</p>` | one `syntax/stray-end-tag` explaining the implicit close; no separate style finding |
| `<h1>a<h2>b</h2></h1>`, `<a>x<a>y</a></a>` | `syntax/unclosed-element` and `syntax/stray-end-tag` |
| `<b><i>x</b>y</i>` | `syntax/misnested` |
| `<table><tr><td>1</td></tr><div>x</div></table>` | `style/explicit-start-tag` (`tbody`) and `syntax/reordered` |
| `<form><form>`, `<table><td>1</td></table>` | `syntax/misplaced-start-tag` (dropped; wrapped in an implied `tr`) |
| `<br>`, `<br/>`, `<br />`, `</br>`, `<div/>`, `<textarea/>` | `style/void-element` twice (the default is `<br />`), clean, `syntax/stray-end-tag`, `syntax/self-closing-non-void` twice (`textarea` swallows the rest of the file) |
| `<icon-element name="star"/>` declared `void: true` | `syntax/self-closing-non-void` |
| `<accordion-wc indicator="plus">`, `<accordion-wc single="false">` | `component/attribute`: not `plus-minus`, `none`, or `custom`; `="false"` switches `single` on |
| `<accordion-wc><p>…</p></accordion-wc>` | `component/content`: expected `details` |
| `<page-tour data-active="true">` | `component/output-attribute` |
| `<layout-stack>` wrapper vs. `<section data-layout="stack">` | the first counts as generic in `bloat/generic-ratio`; the second adds no element |
| a vocabulary entry with `void: true` | `vocab update` refuses to build the snapshot |
| `<svg viewbox="…"><path/></svg>` | `style/lowercase` (`viewBox`); `/>` is fine in foreign content |
| JSX leftovers: `className`, `htmlFor`, `onClick` | `content/unknown-attribute` with hints; `policy/inline-handler` |
| `<span><div>`, `<button><a href>` | `content/child`, `content/descendant` |
| `tr` fragment with context `tbody` vs. `div` | clean vs. `syntax/misplaced-start-tag` |
| tag-like text in `script`, `style`, comments | nothing |
| text button; icon button with `aria-label`; icon button with neither | clean, clean, `a11y/name` |
| explicit label, wrapping label, placeholder only, title only | clean, clean, error, warning |
| `alt=""`, no `alt`, `alt="image"` | review, `a11y/img-alt`, review |
| CRLF, an emoji before a finding, a BOM | correct line and column; fixes keep CRLF and BOM |
| `{{name}}`, "Lorem ipsum", `href="#"` | `semantic/placeholder-content` twice, `semantic/link-href` |
| Java missing with `--nu` | `conformance/nu` untested; status from local rules |

### 12.3 Corpora and properties

- **Known-good**: hand-checked pages with zero errors under `standard`.
- **Mutation**: single defects injected into known-good pages (drop an `alt`, unquote a value, nest a `div` in a `span`, duplicate an ID, add a positive `tabindex`, …). Each mutant must trigger the intended rule. Target recall for deterministic rules: 100%. The mutations are in `test/corpus.ts`, at least one per rule except the review-only, opt-in, page-wide, and Nu rules.
- **Nu differential**: every Nu error on a corpus page matches a local finding or is listed in `test/nu-gaps.json` with a reason. That list is the content-model coverage gap. Each entry is a gap (not checked yet: the table model, media queries, SVG and MathML content, XML-incompatible comments) or a disagreement (accepted on purpose: `slot` on `svg`, an `h1` inside a section, and a Nu false positive on `source` without `sizes`), with an example that must still produce the message unmatched. The corpus is the document fixtures, the known-good pages, and the mutants; the test runs where a `vnu.jar` is installed, and CI installs one.
- **Assembler properties**: plans generated from the starter registry with random in-contract data always pass `strict`, round-trip, and serialize byte-identically twice.
- **Injection corpus** for `text`, `url`, `inline`, `prose`: `</title><script>`, `" onfocus="`, `javascript:`, `jav&#x09;ascript:`, pre-escaped `&amp;`, NUL, bidi controls, NBSP, CRLF. Values never leave their sink, and invalid values fail with a located error.
- **Determinism**: canonical JSON is identical across runs and on Linux, macOS, and Windows in CI.
- **Fixes**: idempotent, and they never introduce errors.

## 13. Evaluation: prove or disprove

**Briefs.** 20 briefs, each with fixed content (real text, so writing quality isn't a variable) and a checklist of semantic expectations. The `patterns` skill's page types: home, about, product list, product detail, contact, FAQ, press release, legal. Added: article, pricing, sign-up, settings form, data report, event, 404, search results, docs page, team, newsletter landing, checkout address form.

**Conditions**, with the same model and house skills throughout:

| | Condition |
| --- | --- |
| A | free-form HTML |
| B | free-form HTML with the htmlverify check loop (hook, at most 3 rounds) |
| C | assembler and catalog with the check loop |

Each brief runs 3 times per condition.

**Drivers.** Each run is driven by a person or by an agent, chosen per run and recorded in its log. A person works the briefs in Claude Code sessions. An agent harness runs them unattended with the same prompts, skills, and tools. Rubric scoring is switchable the same way, between blind human raters and an agent judge. Before its scores count, the agent judge is calibrated against human scores on a shared sample.

**Measures**: status on the first attempt and after the loop; errors per page by family; repair rounds; tokens and wall time; structural variance across the 3 runs (edit distance between element skeletons); a blind human rubric (semantics, accessibility, leanness, scored 1–5) on a sample; for C, the HTML-node count (registry gaps) and finding origins (plan, component, composition).

**Decision**:

- **Supported** if C passes on at least 90% of runs with a median of at most 1 repair round, varies less than A and B, and rates at least as well as B.
- **Checker-only value** if B clearly beats A but C doesn't beat B: the verification loop is the win, and the registry isn't worth its cost yet.
- **Not supported** if C fails mostly on gaps or composition errors that a larger catalog wouldn't fix.

Results, raw outputs, and the failure analysis go in `eval/results/`.

**Harness (M1, M3).** `eval/run.ts` runs the three conditions; `eval/README.md` describes it.

- **Agent driver**: headless Claude Code (`claude -p`) in a fresh directory per run, with its own session, project settings only, and no MCP servers but, in C, htmlverify's. Each run keeps its transcript.
- **Human driver**: the same directories, with instructions.
- **House skills**: `eval/skills/`, a snapshot of Vanilla Breeze's at commit `1817856`. Each run's copies drop the skills' `allowed-tools`, since headless Claude Code refuses a skill that grants tools; in the M1 pilot that refusal kept the skills from loading in A and B.
- **Condition B** adds the htmlverify skill and the hook. The hook logs each round and stops blocking after 3.
- **Condition C** adds the assembler skill (`assets/claude/assemble/SKILL.md`) and the MCP server, and denies the model's own writes to `.html` files, so the page has to be assembled. The server logs each assembly; after the third failing one, its result says to stop. A run with no passing assembly is scored on its last failing output, `page.failed.html`. `--draft` lets C assemble unreviewed components, for pilots before the registry is approved; `registry.json` records each component's version, digest, and review status for the run.
- **Measurements**:
  - The first attempt is B's first hook check, C's first assembly, or A's final file.
  - Repair rounds are failing hook checks, or in C failing assemblies.
  - For C, also the HTML nodes in the last assembly and the origins of every assembly's errors.
  - The checklist is selectors over the parsed page.
  - Structural variance is the mean pairwise edit distance between element skeletons, normalized by the longer one.
- **Rubric**: scoring by human raters or a calibrated agent judge isn't in the harness yet.
- **First results**: `eval/results/2026-10-17-pilot/`, 5 briefs × 2 runs. With the loop, `strict` passes on all of them at the end, against none without it. Both conditions conform to HTML. The loop roughly halves structural variance and costs about 1.7 times as much.

## 14. Milestones

| Milestone | Deliverables | Exit criteria |
| --- | --- | --- |
| **M0 Foundations** | repo setup; decoding and limits; parsing and token reconciliation; `syntax` and M0 `style` rules; report model; text and JSON output; `check`; fixture harness | the syntax and style rows of §12.2 pass with exact locations; canonical JSON is byte-identical across two runs |
| **M1 Checker** | spec data and extract scripts; content-model engine; ID and reference index; accessible names; `content`, `component`, `a11y`, `semantic`, `policy`, `bloat` rules; profiles and config; the Vanilla Breeze vocabulary snapshot and `vocab update`; status and score; `explain`, `rules`, `fix`, `init`; Nu adapter; Claude skill and hook; evaluation harness with A and B | each rule has fail, pass, and boundary fixtures; 100% mutation recall on deterministic rules; zero errors on the known-good corpus under `standard`; Nu gaps listed; first A-vs-B results |
| **M2 Assembler** | template compiler; contracts; parameter types and sinks; slots, keys, IDs, ranks, refs, HTML nodes; serializer; round-trip; origins; `assemble`, `catalog`, `component *`, `registry check`; starter registry | starter components approved with full branch coverage; assembler properties and injection corpus pass; the same plan and registry give byte-identical HTML |
| **M3 Evaluation** | MCP server; condition C; full run and write-up | `eval/results/` committed with the §13 decision |
| **M4 Runtime and adoption**, only if M3 justifies it | Playwright and axe-core scenarios (keyboard, focus, contrast, dialog and disclosure states); waivers with owner, reason, and expiry; baselines for existing sites; SARIF | defined after M3 |

Performance target for M1, without Nu: a 100 KiB page in under 300 ms warm; 100 pages in under 10 s.

## 15. Decisions and changes from the 1.0 proposal

| Decision | Why |
| --- | --- |
| The hypothesis and its evaluation are part of the spec (§13) | The README's goal is to prove or disprove the idea; 1.0 defined no measurement. |
| Scope cut to what tests the hypothesis | Browser runtime, manual-evidence records, waivers, baselines, the migration profile, fingerprints, SARIF, the editor protocol, the HTTP service, and the standards lockfile move to M4 or are dropped. They serve compliance programs, not this experiment. |
| Token reconciliation instead of parser error lists (§4.3) | The spike showed parse5 silently repairs most tree-construction errors. 1.0 asked for "tree-construction evidence" without saying how to get it. |
| Local rules first, Nu optional (§6.9) | Nu takes about 1.4 s per call, stops at the first fatal error, can't check fragments, and doesn't know the house style. |
| One direct runtime dependency (§3.2) | Node 22.18+ runs TypeScript directly, and built-ins cover the CLI, tests, hashing, globbing, and URLs. |
| `family/name` rule IDs | An LLM reads every finding; `style/attr-quotes` explains itself, while `HV-SRC-001` has to be looked up. |
| UTF-16 line, column, and offset (§4.4) | parse5 and LSP both use them; 1.0's UTF-8 byte offsets needed a conversion layer with no consumer. |
| Two profiles, `standard` and `strict` | Fragment is an input kind, not a profile; release, migration, and experimental belong to M4. |
| `strict` is XHTML-flavored HTML | `<br />`, no `div` (enforced), one `h1`. 1.0 forbade the void slash and treated `div` as fine. Now that `/>` on non-void elements is an error, the slash costs nothing. |
| Boolean attributes are written `="true"` (§6.2) | It reads better than `=""` or the attribute name. HTML permits only those two, so the departure is reported at info rather than hidden, and `="false"`, which still means on, is always an error. |
| Vanilla Breeze is the custom-element vocabulary (§7.4) | Its `api.json` registry already carries attribute types, enums, content hints, and output attributes. Its `custom-elements.json` lacks content models and 36 elements. |
| Custom elements are never void | In `text/html` the parser ignores `/>` on a custom element, so a void declaration describes markup that can't exist. It's rejected when the vocabulary is built. |
| Templates are HTML with `{{…}}` and `<template vb-*>` (§9.3) | Experts write HTML, not IR JSON, and `<template>` parses correctly in every context. 1.0 specified only the IR. |
| Template directives use the `vb-` prefix (§9.3) | It matches Vanilla Breeze's own naming (`vb-` elements, `data-vb-*` attributes, `--vb-*` properties), so templates read as the house dialect. Nothing in Vanilla Breeze uses `vb-if`, `vb-each`, `vb-as`, `vb-slot`, or `vb-rank`. |
| Slot fit derived from the content model (§9.6) | Authors don't declare what fits, so the declaration can't be wrong. |
| Slot fit pre-checked with the rest of the plan (§9.6) | Every plan error comes back in one pass, and the ancestors that matter, such as a `form` around a `form`, are known from the templates alone. |
| The parser's restructuring is reported where it happens (§9.8) | A composition HTML syntax can't represent is a plan problem, not an assembler bug, and its syntax findings already say what moved. |
| Readable deterministic IDs and reference pruning (§9.6) | `contact-email-input` works in CSS and URLs, unlike `hv-` plus 20 hex digits. Collisions are errors, and dangling `aria-describedby` tokens can't happen. |
| Heading ranks computed from nesting (§9.6) | Removes the most common structural error class by construction. |
| `inline` and `prose` restricted-HTML parameters (§9.5) | Content with links and emphasis, without a raw-HTML hole; validated, never sanitized. |
| HTML nodes allowed and counted as gaps (§9.6) | The experiment needs an outlet where the catalog falls short, and a measure of how often that happens. |
| Approval bound to a digest; AI assistance recorded (§9.4) | "Reviewed" means this exact version. |
| Only tree-preserving fixes apply automatically, proven by reparse (§8) | One verifiable criterion replaces 1.0's four safety classes. |
| Custom elements without a role count as generic (§6.8) | Renaming `div` to `x-wrapper` can't game the bloat metrics. |
| Review items and coverage instead of a per-finding outcome enum | Keeps the truthful-outcome principle with less machinery. |

## 16. Open questions

1. **Publishing the registry.** Can Vanilla Breeze ship its compiled `api.json` registry in the npm package? The `build:api` step already builds it for the docs site. Until then, `vocab update` needs a checkout.
2. **Manifest gaps.** Should VB retype its opt-out booleans (`carousel-wc[indicators]`, `geo-map[marker]`) as `enum ["true", "false"]` with a `default`? And should its hand-written `.claude/schemas/elements.json` (44 elements, including a void `toggle-thumb`) be retired, or its extra entries folded into `api.json`?
3. **Approval.** You alone, or a list of reviewers?

## References

- WHATWG HTML Living Standard: <https://html.spec.whatwg.org/multipage/> (syntax and optional tags §13.1.2.4, parsing §13.2, fragment parsing, content models, element indices)
- WCAG 2.2: <https://www.w3.org/TR/WCAG22/>; removal of 4.1.1: <https://www.w3.org/WAI/WCAG22/Understanding/parsing.html>
- WAI-ARIA 1.2: <https://www.w3.org/TR/wai-aria-1.2/>; editor's draft (1.3), the data source: <https://w3c.github.io/aria/>
- ARIA in HTML: <https://www.w3.org/TR/html-aria/>
- Accessible Name and Description Computation 1.2: <https://www.w3.org/TR/accname-1.2/>
- HTML-AAM: <https://www.w3.org/TR/html-aam-1.0/>
- ACT Rules Format 1.1: <https://www.w3.org/TR/act-rules-format-1.1/>
- Vanilla Breeze: <https://profpowell.github.io/vanilla-breeze/>, source and `api.json` registry at <https://github.com/ProfPowell/vanilla-breeze>
- parse5: <https://parse5.js.org/>
- Nu Html Checker: <https://validator.github.io/validator/>
- axe-core: <https://github.com/dequelabs/axe-core>
- WHATWG URL: <https://url.spec.whatwg.org/>
- Model Context Protocol: <https://modelcontextprotocol.io/>
- Claude Code hooks: <https://code.claude.com/docs/en/hooks>
