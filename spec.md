# HTMLVerify

## Requirements specification for rigorous HTML verification and assembly

**Document version:** 1.0 — proposed implementation contract  
**Research date:** 17 October 2026  
**Primary use case:** helping LLMs and humans produce deliberate, concise, semantic, accessible HTML through verification and reuse of reviewed components.

This document specifies a tool to build; the commands, APIs, rule identifiers, schemas, and thresholds below are proposed HTMLVerify interfaces, not claims that an implementation already exists. `MUST`, `SHOULD`, and `MAY` describe requirements on HTMLVerify unless explicitly attributed to an external standard. A `SHOULD` permits a documented engineering exception; a `MUST` is a release acceptance requirement for its assigned stage.

**Navigation:** [Standards](#2-standards-authority-and-evidence-model) · [Profiles](#3-inputs-profiles-and-truthful-outcomes) · [Authoring rules](#4-strict-authoring-policy) · [Accessibility](#7-accessibility-verification) · [Assembly](#10-template-and-fragment-assembly) · [Architecture](#11-deterministic-engine-and-architecture) · [Diagnostics](#12-rule-contracts-and-diagnostics) · [Scoring](#14-scoring-and-acceptance-gates) · [Interfaces](#15-cli-configuration-and-api) · [Tests](#17-test-fixtures-and-verification-strategy) · [Acceptance](#18-acceptance-criteria) · [Roadmap](#19-staged-roadmap)

## 1. Product intent and boundaries

HTMLVerify SHALL combine two capabilities:

1. **Verification:** inspect authored source, the parsed tree, and, where requested, rendered behavior; produce reproducible findings with evidence and repair guidance.
2. **Assembly:** construct HTML from versioned, reviewed templates and fragments through typed contracts, then verify the complete result in its actual context.

The desired outcome is HTML whose structure expresses its meaning, whose source makes author intent explicit, whose interactions use appropriate native elements, and whose extra elements and attributes have a reason to exist. Passing a browser parser or a conformance checker alone is insufficient.

The tool MUST keep these independent questions visible:

- Does the source conform to the selected HTML standard and related specifications?
- Does it satisfy the project's stricter authoring policy?
- Does it express the intended meaning and relationships?
- What accessibility checks passed, failed, or still need evidence?
- Is its structural complexity justified?
- Was its assembly safe, reproducible, and valid at the insertion sites?

### 1.1 In scope

UTF-8 `text/html` documents; contextual HTML fragments; the HTML namespace with namespace-aware SVG/MathML integration; reviewed template libraries; final static output from frameworks; optional browser testing of declared routes and interaction states; editor, CLI, library, and CI integrations.

### 1.2 Explicit limits

- HTMLVerify is not an XML well-formedness checker for `text/html`. XHTML requires a separate adapter and profile.
- JSX, TSX, Vue, Svelte, server templates, and other source languages require adapters or compilation. They MUST NOT be silently parsed as final HTML.
- No score establishes WCAG conformance, legal compliance, semantic correctness, security, or usability. Manual assessment and application context remain necessary.
- Static analysis cannot prove arbitrary JavaScript behavior, all dynamically generated states, all CSS dependencies, or assistive-technology interoperability.
- Valid markup is not sanitization. Safe assembly is limited to its declared input types and sinks; arbitrary third-party HTML needs a separately specified sanitization boundary.
- Minimal markup means removing unnecessary structure while preserving meaning and behavior. It does not mean minimizing bytes or deleting useful labels, headings, captions, or grouping elements.

## 2. Standards authority and evidence model

Use the [WHATWG HTML Living Standard][html] for contemporary HTML, rather than treating a historical W3C HTML edition as the current vocabulary. Use W3C accessibility specifications alongside it. W3C and WHATWG have a [collaboration agreement for a single HTML and DOM development stream][html-collaboration].

### 2.1 Classify every rule on separate axes

| Axis | Required values or meaning |
| --- | --- |
| Authority | `standard`: normative author or conformance-checker requirement/recommendation; `guidance`: non-normative advice; `policy`: HTMLVerify/project restriction; `heuristic`: evidence suggesting a review |
| Requirement strength | Preserve the source's MUST, MUST NOT, SHOULD, SHOULD NOT, MAY, or equivalent language; independent of severity |
| Evidence mode | `source`, `tree`, `computed`, `interaction`, `manual`, or a declared combination |
| Result | `pass`, `fail`, `notApplicable`, `cantTell`, `untested` |
| Severity | `error`, `warning`, `review`, `info`; independent of authority |
| Confidence | `certain`, `probable`, `contextRequired`; never fabricated numerical certainty |
| Availability | Required stage and engine capabilities; missing support produces `untested`, never `pass` |

A semantic requirement can be normative even when detecting its violation requires human judgment. Conversely, a deterministic test can enforce a project preference rather than a standard. Rule metadata MUST preserve both distinctions. Result vocabulary is informed by the [ACT Rules Format][act]; adopting it does not imply that every HTMLVerify rule is a W3C-approved ACT rule.

### 2.2 Source registry and update policy

Each rule MUST cite a specific section, identify whether it is normative, and record the edition or retrieved revision used to implement it. The standard registry SHALL include:

| Source | Intended use |
| --- | --- |
| WHATWG HTML | Syntax, parsing, elements, attributes, content models, semantics, obsolete features |
| WCAG 2.2 | Accessibility success criteria and conformance requirements; default target A and AA |
| WAI-ARIA 1.2 and ARIA in HTML | Role/state/property constraints and their permitted use on HTML |
| Accessible Name and Description Computation | Versioned accessible-name algorithm and declared engine behavior |
| HTML-AAM | Mapping reference, with publication maturity recorded |
| WAI tutorials, WCAG Understanding/Techniques, APG | Explanations, examples, interaction patterns; not interchangeable with normative requirements |
| ACT Rules Format and published ACT rules | Test structure, applicability, assumptions, expectations, and outcome mappings |

At research time, [WCAG 2.2][wcag22] and [WAI-ARIA 1.2][aria12] are Recommendations. [ARIA in HTML, 11 August 2026][aria-html] is a Recommendation. [Accessible Name 1.2][accname12] and [HTML-AAM 1.0][html-aam] are Working Drafts; [Accessible Name 1.1][accname11] is a Recommendation. Implementations MUST label draft dependencies and pin the actual algorithm implemented by the chosen accessibility engine. They MUST NOT claim that a familiar version number implies Recommendation status.

`htmlverify.lock.json` MUST record tool/rule-pack versions, parser build, conformance-checker artifact digest, accessibility-engine version, specification revisions or snapshot hashes, browser builds, template digests, and effective profile hash. Do not fetch evolving standards during ordinary checks. An explicit update command produces a reviewed lockfile diff, changed-rule report, and fixture results. Retain upstream licensing and attribution for copied test data or schema material.

## 3. Inputs, profiles, and truthful outcomes

### 3.1 Input contracts

- **Document:** original bytes, logical path, MIME type, encoding, and optional build source map.
- **Fragment:** original bytes plus a context descriptor: namespace, context element and attributes, relevant ancestor chain, document mode, document URL/base, scripting flag, and available ID/landmark/form environment. A bare fragment without sufficient context receives limited syntax results and `cantTell` for context-dependent checks.
- **Assembly:** a versioned plan, locked registry, typed data, and an explicit final document or fragment context.
- **Rendered run:** approved local artifact or URL, exact browser build, viewport, locale, color scheme, resource fixtures, and an ordered scenario manifest.

Do not infer the input kind solely from file extension or the presence of `<html>`. Reject conflicting declarations. Report unsupported syntax explicitly.

### 3.2 Built-in profiles

| Profile | Required work | Intended use |
| --- | --- | --- |
| `strict-static` | Source policy, parsing, document conformance, content constraints, static accessibility, semantic review signals, complexity metrics | Default generated-HTML feedback loop |
| `release` | `strict-static` plus declared runtime scenarios and required manual evidence | Release evaluation for specified pages and states |
| `fragment` | Source policy and contextual fragment checks; complete-document status remains unevaluated until insertion | Component development |
| `migration` | Same raw findings, plus baseline/new-debt comparison and explicit accepted exceptions | Existing sites; never presented as strict conformance |
| `experimental` | Explicitly named candidate features and tests, separate score/profile identity | Exploring newer platform capabilities |

P1 ships `strict-static` for documents. Later stages add assembly, certified contextual fragment support, and the full `release` profile. Requesting an unavailable profile MUST fail explicitly; a partial implementation MUST NOT silently emulate it.

Each versioned profile MUST publish an exhaustive subcheck manifest. Rows name a rule/subcheck ID, required evidence, availability stage, and disposition: `required`, `advisory`, or `outOfScope`. Mixed rule families use stable subcheck identifiers such as `HV-A11Y-002/name-static` and `HV-A11Y-002/name-computed`; the parent ID remains the score-cap identity. P1 requires source-resolvable checks and creation of review obligations. Computed-name conclusions, runtime interactions, and manual resolutions are explicitly outside its automated gate. They remain untested/deferred, never recorded as passes. Missing evidence for an actually required static subcheck produces incomplete analysis.

For example, label-reference resolution is required in `strict-static`; computed exposure/name evaluation is required for applicable declared `release` states; meaningful-label review is advisory for the static gate and mandatory when applicable to release. The manifest is part of the profile hash. Implementers may not silently change dispositions to improve coverage or scores.

### 3.3 Report status

Every report MUST distinguish:

- `executionStatus`: `complete`, `partial`, or `failed`.
- `gateStatus`: `pass`, `passWithExceptions`, `fail`, or `incomplete`.
- Separate HTML-conformance, source-policy, accessibility, semantic-review, and assembly summaries.
- Tested scope, excluded scope, applicable rule counts, completed checks, untested checks, and unresolved reviews.

Gate precedence: known blocking violations produce `fail`; otherwise missing required evidence or phases produces `incomplete`; otherwise permitted active waivers produce `passWithExceptions`; otherwise `pass`. Operational failure also controls the exit code. A fragment can pass its fragment contract without passing a full document's conformance gate.

## 4. Strict authoring policy

HTML permits unquoted attribute values and certain omitted tags. HTMLVerify deliberately chooses a stricter authored form. Those preferences MUST be reported as policy findings rather than misrepresented as HTML errors. HTML has void elements whose end tags are forbidden; foreign-content syntax must be handled separately. [HTML syntax][html-syntax]

The default generated form is lowercase HTML tag/attribute names, double-quoted attribute values, explicit permitted end tags, no trailing solidus on HTML void elements, UTF-8, and `<!doctype html>`. Foreign names such as SVG `viewBox` retain their required spelling. Existing single-quoted values satisfy the quote requirement; double quotes are a serializer convention.

### 4.1 Source rules

All rules below are required for P1 unless stated otherwise. `S` = standard, `P` = policy, `G` = guidance, `H` = heuristic. Mixed rows MUST separate subchecks and their authority in actual rule metadata.

| Rule ID | Requirement and detection | Basis | Default |
| --- | --- | --- | --- |
| `HV-SRC-001` | Every authored attribute has `=` and a quoted value, including empty values. `<input disabled="">` passes; bare `disabled` and `class=card` fail this policy. | P | error |
| `HV-SRC-002` | Every authored non-void HTML element has explicit start/end tags, including otherwise optional tags. Every implied HTML element inside the checked source scope needs an authored start tag. Exclude synthetic fragment context and the document node. | P | error |
| `HV-SRC-003` | No end tags for HTML void elements; no self-closing syntax for ordinary non-void HTML elements. Native foreign self-closing syntax remains supported. | S | error |
| `HV-SRC-004` | No trailing `/` on HTML void start tags in this profile. | P | warning |
| `HV-SRC-005` | No duplicate attributes, stray end tags, malformed tokens, or parser-reported syntax errors. Preserve duplicates before the parser discards them. | S | error |
| `HV-SRC-006` | No authored nesting that relies on implicit closure, ignored tokens, foster parenting, or reconstruction of misnested formatting. Report the source cause and resulting tree. | P; underlying errors also S | error |
| `HV-SRC-007` | Lowercase names in the HTML namespace; do not mechanically lowercase SVG/MathML names or attribute values. | P | warning |
| `HV-SRC-008` | Full documents use the short doctype and explicit `html`, `head`, and `body`. No XML declaration in the generated HTML profile. | P | error |
| `HV-SRC-009` | Boolean attributes use the empty quoted form when present and are absent when false. Reject invalid HTML boolean values separately. Enumerated attributes are not treated as booleans. | P + S subchecks | error |
| `HV-SRC-010` | Reject decoding errors, NUL, unresolved compiler placeholders, and unsupported template-language input. Record original line endings and byte positions. | P; some syntax cases S | error |
| `HV-SRC-011` | Encode actual character references correctly and with terminating semicolons. Do not reject every literal ampersand with a regex; classify its tokenizer context. | P + S subchecks | error |
| `HV-SRC-012` | Require a UTF-8 declaration wholly within the first 1,024 bytes of complete generated documents, document language, and a nonempty title. Review title meaning separately. Keep special document contexts explicit. | P; related conformance checks separate | error |

Boolean presence means true; string values `"true"` and `"false"` are not valid boolean-attribute values. Enumerated attributes such as `contenteditable`, `draggable`, `hidden`, and `popover` require their own value definitions. [Common microsyntaxes][html-microsyntax]

For `HV-SRC-002`, a `<table><tr>…</tr></table>` source needs explicit `<tbody>` in the strict profile even where the HTML parser legitimately inserts it. That is a strict authoring choice, not proof that the original source violated HTML. Use source locations and tree-construction evidence, not a naive tag stack. Normal text-node merging and mandated newline normalization are not failures of source intent.

The source scanner MUST understand comments, raw text, escapable raw text, character references, namespaces, and scripting-dependent `noscript` handling. Strings that resemble tags inside scripts or styles MUST NOT be treated as markup. Parser error absence alone does not demonstrate that all optional tags were authored. [HTML parsing][html-parsing] The document metadata checks also consult the element-specific [metadata requirements][html-metadata].

Unresolved-placeholder detection requires a declared compiler/assembly adapter or reserved marker contract. Literal braces or template examples in ordinary content are not sufficient evidence of an unresolved placeholder.

## 5. Conformance and content-model verification

### 5.1 Use an independent checker

Integrate a local, pinned [Nu Html Checker][nu] as the initial full-document conformance backend. Preserve its raw findings and engine identity. Do not depend on a public hosted validator for routine checks or send user documents there by default. The current upstream release process uses a moving `latest` release; lock downloaded bytes by digest rather than relying on that label alone. [Nu upstream][nu-repo]

A parser establishes a tree; it does not establish all author conformance requirements. HTMLVerify's constraint index supplies contextual diagnostics and assembly checks, while Nu provides independent coverage. Unknown backend messages MUST remain visible as `HV-CON-000` with raw message, severity, location, and engine version. Text matching MUST NOT be used to silently discard unrecognized errors.

When checker and rule pack disagree about a newer feature, report a version conflict and mark affected conclusions `cantTell`. Do not silently whitelist the feature or label it universally invalid.

### 5.2 Content-model engine

Implement a versioned constraint model with:

- Namespace-aware element identity and context-dependent category membership.
- Ordered child grammars: sequences, choices, repetitions, minimum/maximum occurrence, and permitted text.
- Element-specific attribute predicates and conditional content rules.
- Transparent models resolved through the insertion ancestry.
- Ancestor and descendant prohibitions, including constraints that cross fragment boundaries.
- Required parent/context rules, unique-element constraints, document-level references, and form ownership.
- Attribute-value microsyntax validation and cross-attribute dependencies.
- Distinct document, ordinary template-content, shadow-tree, and foreign-content scopes.

HTML categories are overlapping and can depend on attributes. Transparent content inherits surrounding restrictions; it does not mean unrestricted children. Ordinary template contents have special conformance treatment before instantiation, so template-contract validation is an additional policy. [Content models and semantics][html-dom]

### 5.3 Required rule families

| Rule ID | Required checks | Default |
| --- | --- | --- |
| `HV-CON-001` | Complete local checker results: illegal elements/attributes, required attributes, bad values, invalid document structure | error for checker errors |
| `HV-CON-002` | Child grammar, order, count, category, and permitted-text constraints | error |
| `HV-CON-003` | Ancestor/descendant restrictions and transparent-model context | error |
| `HV-CON-004` | Duplicate IDs in the relevant scope; invalid IDs and unresolved required IDREF/IDREFS relationships, using attribute-specific rules | error |
| `HV-CON-005` | Table structure and cell/header references; do not require every legitimate table to use the same header technique | error or review by subcheck |
| `HV-CON-006` | Form ownership, valid label targets, forbidden form nesting, applicable input-attribute combinations | error |
| `HV-CON-007` | Obsolete/nonconforming features and obsolete-but-conforming features, classified separately | error / warning |
| `HV-CON-008` | Namespace/integration-point handling and required adapter coverage for SVG/MathML | error or untested |

The rule pack MUST include regression cases for paragraphs containing flow-only elements, list membership, description-list groupings, tables, nested links, button descendants, labels, picture/source ordering, details/summary, and context-sensitive select content. Do not implement a universal “no interactive descendant” rule: each element has its own restrictions. See [text-level semantics][html-text], [grouping content][html-grouping], [tables][html-tables], and [form elements][html-forms].

Do not freeze `select` to an old `option`/`optgroup`-only model. Current HTML includes customizable-select structures; accept only what the pinned standard and checker jointly support, with compatibility assessed separately. [The select element][html-select]

No fragment is globally “valid everywhere.” A table row fragment, for example, needs an appropriate table-section context. Use the [HTML fragment parsing algorithm][html-fragments]. A synthetic document wrapper is an adapter technique, not evidence that the real integration is valid. Wrapper findings MUST be attributable and excluded only by source ownership, never broad message filters. Always check the final assembled document.

## 6. Semantic quality audits

The audit asks what content and controls mean before suggesting elements. Class names such as `card`, `header`, or `button` are weak clues, never sufficient proof. Correct semantics can require information absent from markup; record a review instead of inventing intent.

| Rule ID | Test or review | Authority / default |
| --- | --- | --- |
| `HV-SEM-001` | A declared navigation action should use an anchor with a real destination; a declared command should use a button or another appropriate native control. Without declared intent, report candidates for review. | P based on element semantics / warning or review |
| `HV-SEM-002` | Audit heading hierarchy and descriptive headings. Flag skipped ranks for review; do not declare exactly one `h1` or no skipped ranks a universal HTML/WCAG requirement. | G/P / warning |
| `HV-SEM-003` | Audit `main`, `nav`, `header`, `footer`, `aside`, `article`, `section`, and `search` against their actual purpose and context. Avoid creating landmarks solely to replace wrappers. | S where misuse is established; otherwise H / review |
| `HV-SEM-004` | Suggest lists for declared collections, description lists for name/value or term/description groups, and tables for genuinely tabular relationships. Do not infer from indentation alone. | G/H / review |
| `HV-SEM-005` | Review meaningful use of `em`, `strong`, `cite`, `blockquote`, `q`, `time`, `address`, `figure`, and `figcaption`. Do not replace style wrappers blindly. | S/G with contextual evidence / review |
| `HV-SEM-006` | Detect repeated `<br>` or empty elements apparently used for spacing. Allow legitimate poetry, addresses, and deliberate empty states. | H / warning |
| `HV-SEM-007` | Detect explicit roles that duplicate implicit roles, preserving contextual mapping and documented compatibility exceptions. | S (SHOULD / NOT RECOMMENDED); stricter P optional / warning |
| `HV-SEM-008` | Produce a semantic outline and intent-to-element report; compare assembly intent contracts with actual output. | P / error for contract mismatch |

Semantic misuse is not always merely stylistic: HTML assigns meanings to elements and imposes author requirements. The tool MUST distinguish a proven misuse from a speculative recommendation. [HTML semantics][html-dom]

Redundant-role checking is supported by a normative checker recommendation in [ARIA in HTML][aria-html], rather than only a style preference. [WAI-ARIA's host-language guidance][aria-host] also recommends using equivalent native features where there is no compelling reason to repurpose others. Record the source strength and any compatibility justification; neither recommendation makes every custom widget automatically invalid.

For new complete pages, the project policy SHOULD ask for a clear primary heading and main-content region. It MUST support legitimate exceptions, embedded documents, and application states. Heading and landmark reviews must use contextual semantics rather than counting tag names alone. [WAI page structure guidance][wai-structure]

## 7. Accessibility verification

Target WCAG 2.2 A/AA by default. Keep a success-criterion coverage matrix showing automated evidence, assumptions, uncovered states, and manual work. A failed local check can support a criterion-level finding; a passed local check does not establish that the entire criterion or page conforms. WCAG conformance also includes scope and process considerations beyond a single HTML file. [WCAG conformance][wcag-conformance]

### 7.1 Static and computed checks

| Rule ID | Requirement | Evidence / default |
| --- | --- | --- |
| `HV-A11Y-001` | Document language is present and syntactically valid; review whether it matches content and whether language changes need markup. | source + manual / error or review |
| `HV-A11Y-002` | Controls, links, and other name-requiring roles have an accessible name in applicable exposed states. Report its source and references. Inert templates and unavailable states create deferred obligations or coverage gaps. | tree/computed / error when determinable |
| `HV-A11Y-003` | Controls have appropriate labels and instructions. Accept explicit and implicit native labels; apply native-label association tests only to labelable elements. Exclude hidden inputs, but retain custom-widget naming requirements. | tree + manual / error or review |
| `HV-A11Y-004` | Non-text content has appropriate alternatives. For `img`, generated-content policy requires explicit `alt`, including cases HTML may except; empty alt can be correct. Use element-appropriate mechanisms for SVG and other content. Review descriptive accuracy and decorative intent. | source + manual / error or review |
| `HV-A11Y-005` | Roles and ARIA properties are permitted for the actual HTML element/context; values, required properties, name prohibitions, and relationships are valid. | tree/computed / error |
| `HV-A11Y-006` | ID references for names/descriptions/controls/ownership resolve under their defined scoping rules. Do not assume every IDREF has identical semantics. | tree/computed / error |
| `HV-A11Y-007` | Detect forbidden `aria-hidden` use and focusable descendants hidden from accessibility APIs; account for inert/hidden ancestors and state. | tree/computed / error or cantTell |
| `HV-A11Y-008` | Positive `tabindex` violates the default navigation policy. Values `0` and `-1` remain available for justified interaction patterns. | P / warning |
| `HV-A11Y-009` | Table header relationships are available and appropriate to complexity; caption quality and layout-table misuse need review. | tree + manual / error or review |
| `HV-A11Y-010` | Landmark names, heading names, link purpose, visible-label/name consistency, and duplicate control names are reviewed in context. | computed + manual / error only with sufficient evidence |
| `HV-A11Y-011` | Form grouping, instructions, error identification, required-state communication, and status messages are checked across relevant states. | tree/interaction/manual / error or review |
| `HV-A11Y-012` | Media alternatives and relevant audio/video requirements generate explicit automated and manual tasks. | source/manual / error or review |

An accessible name is not synonymous with an `aria-label` attribute. Native text, associated labels, and other permitted mechanisms can supply it. Compute names with a pinned algorithm; never demand redundant ARIA on a correctly named native element. Hidden referenced content and role-specific naming rules require algorithmic treatment. [Accessible Name 1.1][accname11], [Accessible Name 1.2 draft][accname12], [ARIA in HTML][aria-html]

Never fabricate alt text, mark an image decorative automatically, substitute a placeholder for a label, or assume that nonempty text is meaningful. Alternative text and labels need purpose-sensitive evaluation. [WAI images tutorial][wai-images], [WAI labels tutorial][wai-labels]

### 7.2 Runtime and manual evidence

P3 SHALL run a pinned accessibility engine such as [axe-core][axe] within a browser and preserve its passes, violations, incomplete results, and inapplicability results. Map engine rules to HTMLVerify IDs without claiming complete WCAG coverage. Engine-reported impact levels remain separate from the project's severity.

Declared scenarios MUST exercise, where applicable:

- Keyboard reachability, activation, focus order, visible focus, focus restoration, and escape routes.
- Dialog open/close behavior, focus containment where modal, disclosure and popover states, tabs, menus, and composite widgets.
- Validation errors, expanded controls, async loading, status announcements, and disabled states.
- Computed contrast, zoom/reflow, content obscured by overlays, motion preferences, and target sizing where relevant.
- Responsive layouts, navigation mechanisms, language variants, and shadow-root content supported by the runner.

Use pinned viewports, fixtures, and explicit readiness assertions; never make “sleep for a second” the sole definition of a settled state. Missing resources, engine timeouts, inaccessible cross-origin frames, or uninspectable closed shadow roots produce coverage gaps. Browser DOM serialization is not the original authored source and cannot satisfy quote or omitted-tag checks.

Manual evidence SHALL include reviewer, date, tested content/scenario hashes, browser/assistive-technology versions where relevant, outcome, and notes. Changes to relevant content invalidate the evidence. `release` requires all declared mandatory review tasks to be resolved; `strict-static` reports them as outstanding without pretending to complete a release assessment.

The [ARIA Authoring Practices Guide][apg] informs widget patterns and keyboard expectations; it is guidance, not a replacement for normative ARIA and WCAG. Prefer built-in behavior where it matches intent. A native element still needs correct naming, context, styling, and testing.

WCAG 2.2 removed success criterion 4.1.1 Parsing. HTML syntax and duplicate-ID defects remain important, and some can break other accessibility requirements, but HTMLVerify MUST NOT automatically report every markup error as a WCAG 2.2 parsing failure. [W3C explanation of the removal][wcag-parsing]

### 7.3 Initial criterion-to-evidence map

These are starting mappings for rule authors, not a complete WCAG coverage claim. Each atomic subcheck must specify whether failure establishes a criterion violation or only contributes evidence; a passing subcheck never completes the entire row automatically. Linked Understanding documents explain the criteria but are informative.

| Criterion | HTMLVerify evidence | Remaining assessment |
| --- | --- | --- |
| [3.1.1 Language of Page][wcag-language] | `HV-A11Y-001`: language declaration and syntax | Actual predominant language |
| [1.1.1 Non-text Content][wcag-nontext] | `HV-A11Y-004`: element-appropriate alternative mechanisms | Purpose, accuracy, exceptions, complex explanations |
| [1.3.1 Info and Relationships][wcag-relations] | `HV-A11Y-003/009`, structural audits | Whether presented relationships are conveyed |
| [4.1.2 Name, Role, Value][wcag-name-role] | `HV-A11Y-002/005/006`, runtime state tests | Dynamic behavior and accessibility exposure |
| [2.5.3 Label in Name][wcag-label-name] | `HV-A11Y-010`: visible label versus computed name | Reliable label extraction and applicability |
| [2.1.1 Keyboard][wcag-keyboard] | Declared activation and navigation scenarios | All relevant functionality and exceptions |
| [2.4.11 Focus Not Obscured (Minimum)][wcag-focus-obscured] | Rendered focus/overlay scenarios | Untested states and author-created obstructions |
| [2.5.8 Target Size (Minimum)][wcag-target-size] | Rendered target geometry and spacing | Applicable exceptions and responsive states |

## 8. Anti-bloat and maintainability policy

HTML advises using `div` when no more suitable element applies. That does not make `div` intrinsically wrong. Classes are a legitimate mechanism; no standard establishes a maximum class count. HTMLVerify's numerical limits below are configurable project policy. [The div element][html-div], [The class attribute][html-class]

### 8.1 Defined metrics

Compute metrics separately for each complete document, component instance, inert template body, and inspectable shadow tree. For the main document, let `E` be authored HTML-namespace elements descended from `body`, excluding `script`, `style`, `template`, and ordinary template contents. Include hidden authored markup so hiding content cannot avoid complexity accounting. Foreign trees have separate node budgets. Let `N = |E|`.

| Metric | Exact calculation | Initial warning threshold |
| --- | --- | --- |
| `genericRatio` | Number of `div` and `span` elements in `E`, divided by `N`; null when `N = 0` | `> 0.35` when `N >= 20` |
| `maxGenericChain` | Longest direct parent-child chain of `div`/`span`, with exactly one element child at each nonterminal node and no non-whitespace text beside that child | `> 3` |
| `maxClassesPerElement` | Maximum number of distinct ASCII-whitespace-separated class tokens on an element in `E` | `> 6` |
| `p95ClassesPerElement` | Sorted counts including zero; element at index `ceil(0.95 × N) - 1`; null for no elements | `> 4` when `N >= 20` |
| `maxDepth` | Maximum element depth within `E`; direct children of body have depth 1 | `> 12` |
| `elementBudget` | `N` and per-component element counts | `> 1500` document / declared component budget |
| `wrapperCandidates` | Generic single-element-child nodes with no non-whitespace direct text; list candidates and known dependencies | review, no universal limit |
| `markupBytes` | Original/output UTF-8 byte length, reported separately from node metrics | project-specific |

All thresholds are initial engineering defaults for calibration, not research-backed universal boundaries. A chart, editor, dense data view, utility-CSS project, or third-party widget can need a different budget. Small fragments must not be judged by unstable ratios.

For components and standalone fragments, include all owned output roots and their descendants, with roots at depth 1; publish both exclusive counts (excluding nested component instances) and inclusive counts (including them). Budgets apply to inclusive counts unless explicitly declared otherwise. For template bodies and shadow trees, use their fragment roots at depth 1. Apply the same exclusions and sample limits in every scope. HTML descendants within foreign-content integration points join the HTML metrics when they are otherwise in scope, but depth follows actual element ancestry; foreign nodes also count toward the separate total-node budget. Never jump across a foreign parent when detecting a direct generic chain. Report the scope/ownership policy alongside each metric.

### 8.2 Rules and safeguards

- `HV-BLOAT-001`: report generic-element ratio and the most concentrated subtrees.
- `HV-BLOAT-002`: report deep generic wrapper chains with source locations.
- `HV-BLOAT-003`: report class-count excess and duplicate/empty class tokens; token duplication is a separate deterministic finding.
- `HV-BLOAT-004`: report depth/node-budget excess and changes against a comparable baseline.
- `HV-BLOAT-005`: propose wrapper/class review only with evidence about CSS selectors, script queries, layout, event delegation, IDs, microdata, accessibility, and component boundaries.
- `HV-BLOAT-006`: compare assembled output with declared template budgets and flag unexplained expansion.

Do not convert all `div`s to `section`s, create invented semantics to improve ratios, collapse meaningful groups, or move class strings into `style`/`data-*` to game a score. Track these substitutions in before/after review. Structural equivalence in a DOM snapshot is insufficient to prove behavior is unchanged.

CSS/JavaScript analysis can find dependencies, but missing references are not proof that a class or wrapper is unused when dynamic code, external styles, or runtime composition exists. Deletion remains a reviewed refactor unless the whole supported dependency boundary is proven and tested. A utility-CSS profile MAY use larger class budgets; it must have its own profile identity and retain semantic/a11y gates.

## 9. Modern HTML and compatibility

Reject obsolete nonconforming markup and separately warn about obsolete-but-conforming usage using a pinned list, rather than a hand-maintained blacklist with no provenance. [Obsolete features][html-obsolete]

`HV-MOD-001` SHALL detect candidates for native features from declared intent: disclosure → `details`/`summary`; dialog → `dialog`; command/navigation → button/anchor; constrained input → appropriate input type; search region → `search` or a supported equivalent; output/progress/measurement → the suitable native element when its semantics fit.

`HV-MOD-002` SHALL track three independent states for each proposed feature: specified by the selected standards snapshot, implemented by target browsers, and adequately supported in the project's accessibility testing. “Modern” does not mean “present in one browser” or “automatically accessible.” Prefer progressive enhancement when a baseline experience can remain useful.

For example, `dialog` is subject to specific author and focus behavior requirements, while `popover` is an enumerated facility and does not by itself implement a complete custom menu's interaction model. Inspect each feature's actual requirements. [Interactive elements][html-interactive], [Popover][html-popover]

Requirements:

- Compatibility targets MUST be explicit and versioned; checks MUST NOT rely on a changing ambient “latest browser.”
- A newer feature MUST NOT be rejected merely because an obsolete validator does not know it; report a tooling-version conflict.
- Custom elements require declarations for supported usage, properties, slots, states, and accessibility behavior. A hyphenated name is not evidence of a valid or accessible implementation.
- Ordinary `<template>`, declarative shadow DOM, and instantiated shadow trees require distinct handling. Unsupported construction or inaccessible internals must appear in coverage.
- Do not require legacy shims, redundant MIME attributes, or ARIA duplicating native semantics without a documented target need.

The initial strict profile SHOULD prohibit inline event-handler attributes and executable URL schemes as project policy (`HV-MOD-003`), while allowing scripts through explicitly reviewed application boundaries. This is not a claim of complete security analysis.

## 10. Template and fragment assembly

### 10.1 Assembly model

Prefer **select → bind → compose → verify** over unconstrained synthesis. The LLM selects reviewed components and supplies typed content/intent; the deterministic assembler controls HTML construction. Generating a new template is a separate reviewable operation.

Registry entries MUST contain immutable ID/version, content digest, author/reviewer provenance, compatible rule-pack versions, input schema, context preconditions, output shape, slot contracts, ID policy, dependency list, accessibility obligations, supported states, complexity budgets, and fixtures. “Reviewed” is scoped to versions and use cases, not a permanent accessibility certificate.

The assembler MUST:

1. Resolve the entire dependency graph from the lockfile; reject missing versions, hash mismatches, cycles, and duplicate instance keys.
2. Validate plan and input schemas before rendering; reject unknown properties by default.
3. Construct a typed internal tree through a restricted intermediate representation (IR).
4. Validate insertion preconditions, sibling order, ancestor restrictions, cardinalities, and slot outputs.
5. Allocate deterministic scoped IDs and rewrite only declared references.
6. Serialize using the strict authoring policy.
7. Reparse and verify final output; compare the intended tree with the actual parsed structure using namespace and attribute semantics.
8. Emit HTML, a source/provenance map, lockfile references, report, and output digest atomically.

Complete-document assembly defaults to `strict-static`; standalone fragments use the `fragment` profile and retain their document-level obligations. Normal output publication requires `executionStatus=complete` and `gateStatus=pass` or an explicitly permitted `passWithExceptions`. Unresolved parameters, low-score gate failures, missing required phases, and operational errors all block publication. Diagnostic builds MAY preserve failed/incomplete output in an explicitly marked quarantine location for inspection.

### 10.2 Slot types and escaping

| Type | Required behavior |
| --- | --- |
| `text` | Insert a text node; serialize with context-appropriate escaping. Strings are never interpreted as markup. |
| `attributeText` | Bind to a fixed reviewed plain-text attribute name; quote and escape its value. It cannot target URL, ID/IDREF, boolean, enumerated, event-handler, style, srcdoc, or script-data sinks. |
| `url` | Parse and resolve with the declared base; apply an attribute-specific scheme/origin policy; then attribute-escape. Escaping alone does not make a URL acceptable. |
| `boolean` | Require a JSON boolean; true emits the declared empty-valued boolean attribute, false omits it. |
| `enum` | Select a declared value; useful for enumerated HTML attributes and fixed tag/heading variants. |
| `id` / `idref` / `idrefs` | Use typed symbols resolved through the instance namespace and document reference graph. |
| `component` / `componentList` | Accept locked component references and typed data, subject to the destination slot's grammar. |
| `reviewedFragment` | Accept only a registry artifact with verified digest, compatible context contract, and provenance. Revalidate after insertion. |

Use a [WHATWG URL][url] parser, followed by project policy; URL parsing is not a trust decision. Navigation, image, and form-action URLs may need different policies. Reject unsupported multi-URL sinks such as `srcset` unless a dedicated typed adapter is implemented. The initial safe registry does not offer `rawHTML`, arbitrary tag names, arbitrary attribute names, executable expressions, or dynamic script/style bodies. A reviewed script resource is a dependency, not a string interpolation slot.

The template compiler MUST enforce a versioned namespace/element/attribute-to-slot-type matrix. A template author cannot choose `attributeText` for `href`, `src`, or `action` to bypass URL policy, or use a generic string to bypass symbolic-ID handling. Unknown sinks fail registration. Static literals at sensitive sinks undergo the same validation as bound parameters. A `text` node is supported only in explicitly permitted normal-text/RCDATA contexts; script/style and other special data contexts require dedicated serializers and are unsupported for arbitrary data in v1.

### 10.3 Minimal IR and component contract

The core IR SHALL support only `element`, `text`, `slot`, `component`, `if`, and `each` nodes. `element` has a fixed namespace/tag and fixed attribute names; values are literals or typed parameter references. `if` tests a boolean parameter. `each` traverses an input array in order and requires a stable key. There is no JavaScript evaluation. Extension nodes require separately reviewed plugins and capability declarations.

Complete-document assembly has a document envelope outside this node union: it emits the fixed `<!doctype html>` and exactly one HTML-namespace `html` root with explicit `head` and `body`. Fragments have no envelope. Doctypes cannot be injected through a text slot. The serializer MUST use token-context-specific escaping; preserve whitespace-sensitive text and avoid inserting indentation into mixed content. Attribute order is stable by declared template order, with generated attributes added in a fixed documented order.

For new registry entries, define an element tree or compile a template into this IR. Do not invent a regex replacement language for placeholders inside arbitrary HTML. Importing an existing HTML template requires parsing and validation before registration.

Example contract body (JSON; registry digest/reviewer metadata is stored alongside it; names and schema are proposed):

```json
{
  "schemaVersion": "1.0",
  "id": "native.action",
  "version": "1.0.0",
  "intent": "command",
  "context": {
    "namespace": "http://www.w3.org/1999/xhtml",
    "requiredCategory": "phrasing",
    "constraints": ["button-permitted-at-insertion-site"]
  },
  "parameters": {
    "label": { "type": "text", "minLength": 1 },
    "disabled": { "type": "boolean", "default": false }
  },
  "tree": {
    "kind": "element",
    "tag": "button",
    "attributes": {
      "type": { "literal": "button" },
      "disabled": { "parameter": "disabled" }
    },
    "children": [{ "kind": "text", "parameter": "label" }]
  },
  "budgets": { "elements": 1, "classesPerElement": 0 },
  "reviewObligations": ["label-describes-command", "command-behavior-tested"]
}
```

The namespace defaults only where declared by the contract. `requiredCategory` alone is insufficient: the insertion constraint consults the full parent/ancestor rules. A nonempty label passes structural checks but still needs a meaningful-label review.

### 10.4 Assembly plan and deterministic identity

```json
{
  "schemaVersion": "1.0",
  "document": {
    "template": "page.basic@1.0.0",
    "key": "save-page",
    "data": { "title": "Save changes", "lang": "en", "heading": "Save changes" },
    "slots": {
      "main": [
        {
          "component": "native.action@1.0.0",
          "key": "save-command",
          "data": { "label": "Save changes", "disabled": false }
        }
      ]
    }
  }
}
```

`page.basic@1.0.0` is a required P2 starter template: explicit document shell, metadata, title, language, one primary heading, and a `main` content slot. Its definition and fixtures are registry artifacts. P2 also requires native action, navigation list, labeled field, disclosure, and table templates with static variants and declared runtime obligations. P3 adds a dialog template and the required interaction/state evidence for all interactive templates.

For generated IDs, use `hv-` followed by the first 20 hex characters of SHA-256 over the canonical array `[assemblyRootKey, instanceKeyPath, localSymbol]`. The logical instance path uses keys, not array indices. Detect collisions across the complete output and fail rather than silently accepting them. Explicit exported IDs use a separate declared export map. IDREF rewriting MUST include only supported typed references; never perform string-wide substitutions through CSS, JavaScript, or arbitrary text.

A source map links output ranges to template nodes, plan instance keys, data JSON pointers, and imported fragment spans. It must identify one source template reused at many insertion sites and preserve call-site context in each diagnostic.

### 10.5 Fragment obligations

Record unresolved obligations such as “requires a surrounding list,” “requires a matching label target,” or “heading rank supplied by parent.” Assembly must discharge them or fail. Validate duplicate IDs, accessible-name references, heading relationships, form ownership, and content constraints across component boundaries.

Ordinary inert template content is not evaluated as if it were already in the live document. Validate its syntax and contract separately; evaluate actual instances in their final contexts. Do not inflate live-document metrics by counting template definitions as instantiated output. [Template element][html-template]

## 11. Deterministic engine and architecture

### 11.1 Pipeline

```text
Original bytes / typed assembly plan
    -> input classification + immutable configuration lock
    -> lossless token/CST view + WHATWG-compatible parser
    -> parsed tree + source/tree correspondence
    -> conformance adapter + constraint/reference indexes
    -> source, semantic, accessibility, and complexity rules
    -> optional browser scenarios + manual evidence
    -> deduplicated findings + coverage + gates + score
    -> text / JSON / SARIF / editor diagnostics
    -> proposed edits -> reparse -> reverify -> atomic write
```

Keep authored tokens and the repaired parsed tree. The first reveals omitted quotes/tags and duplicates; the second reveals browser interpretation. A DOM-only tool loses evidence. An XML parser or regex-based tag scanner cannot substitute for the HTML parsing model.

### 11.2 Modules

| Module | Responsibility |
| --- | --- |
| `input` | Classification, UTF-8 decoding, limits, original byte storage |
| `source` | Lossless tokens, raw lexemes, quote style, duplicates, original offsets |
| `parser` | WHATWG tree construction, source locations, fragment contexts, parser errors |
| `standards` | Versioned vocabulary, constraints, source registry, feature maturity |
| `conformance` | Local Nu process/service adapter; raw and normalized diagnostics |
| `analysis` | Reference, context, semantic, accessibility, and dependency indexes |
| `rules` | Pure evaluators with declared inputs and capability requirements |
| `assembly` | Registry, IR, contracts, scoped IDs, serialization, provenance |
| `runtime` | Browser fixtures, state transitions, engine adapters, screenshots/evidence |
| `reporting` | Deduplication, findings, fingerprints, policy gates, scoring, formats |
| `fixes` | Guarded edit planning, overlap detection, equivalence checks, rollback |
| `interfaces` | CLI, library API, editor protocol adapter, optional local service |

A practical initial implementation is a TypeScript library and CLI, with a pinned HTML parser such as [parse5][parse5], a local Nu backend, and an optional isolated browser runner. These are replaceable adapters, not grounds for weakening semantics. Confirm parser support through fixtures; an API accepting HTML is not evidence of complete source fidelity or current-feature support.

### 11.3 Determinism contract

For identical input bytes, effective configuration, lockfile, and evidence fixtures, static canonical JSON MUST be byte-identical across runs and supported operating systems. Sort findings by logical path, start byte, rule ID, and discriminator. Sort schema-defined sets; preserve semantically ordered arrays. Normalize logical paths to relative POSIX form. Exclude wall-clock timestamps, process IDs, random IDs, absolute machine paths, and duration measurements from canonical content; these may appear in a separate execution envelope. Publish a canonical encoding algorithm with golden byte fixtures: sorted object keys, stable number/string escaping, UTF-8 without BOM, and no insignificant whitespace. Use that same encoding for configuration and identity hashes; reject non-finite numbers rather than emitting implementation-specific values.

Cache keys MUST include input, context, config, rule-pack, dependency, and engine digests. A template change invalidates dependent assemblies; a context change invalidates fragment results. Run rules without ambient network, locale, current time, random values, or undeclared filesystem access. Any time-sensitive waiver decision uses an explicit `evaluationDate`.

Runtime results are reproducible within a declared environment, not promised bit-identical across browsers or platforms. Record readiness, retries, failures, resources, fonts, and environmental differences. Retrying a flaky failure does not erase it; classify it as unstable evidence.

### 11.4 Operational constraints

Static mode MUST NOT execute scripts or fetch resources. Runtime mode requires explicit invocation and uses an isolated browser profile with approved network origins, no ambient credentials, and bounded resource use. Registry imports are data, never executable instructions. Plugins have declared capabilities and are pinned; do not run arbitrary repository hooks implicitly.

Enforce configurable limits for file size, element count, tree depth, total assembly expansion, process memory, checker time, and browser time. Defaults: 5 MiB per source file, 100,000 parsed elements, depth 512, 20 MiB per assembly, 30 seconds per conformance input, and 60 seconds per browser scenario. Exceeding limits produces an explicit incomplete/error result without a success score; implementations must avoid crashing on malicious depth.

## 12. Rule contracts and diagnostics

### 12.1 Rule metadata

Every rule definition MUST include stable ID, version, title, category, authority, source references and maturity, applicability, required capabilities, algorithm/expectation, assumptions, severity, confidence rules, examples, failure evidence, dependencies, fix policy, score dimension, and fixtures. Review heuristics MUST expose their triggering evidence and uncertainty. Rule IDs are never reassigned to unrelated meanings.

Metadata additionally includes `requirementStrength` and versioned subcheck definitions, including each subcheck's disposition in supported profiles. Broad rule-family descriptions in this document do not replace these executable applicability/expectation contracts.

Rules return typed findings, not free-form pass/fail prose. Standards mapping must distinguish “test failure establishes this requirement violation” from “test supplies partial supporting evidence.” This follows the distinction between test expectations and accessibility conformance interpretation in [ACT][act].

### 12.2 Finding example

For `component.html` containing the ASCII source `<div class=card></div>`:

```json
{
  "schemaVersion": "1.0",
  "ruleId": "HV-SRC-001",
  "ruleVersion": "1.0.0",
  "authority": "policy",
  "severity": "error",
  "outcome": "fail",
  "confidence": "certain",
  "message": "Quote the value of the class attribute.",
  "location": {
    "path": "component.html",
    "startByte": 11,
    "endByte": 15,
    "startLine": 1,
    "startColumn": 12,
    "endLine": 1,
    "endColumn": 16
  },
  "evidence": {
    "attribute": "class",
    "rawValue": "card",
    "parsedValue": "card"
  },
  "explanation": "HTML permits this unquoted value; the strict authoring profile requires quotes.",
  "suggestion": "Write class=\"card\".",
  "fix": {
    "safety": "conditional",
    "edits": [{ "startByte": 11, "endByte": 15, "replacement": "\"card\"" }],
    "preconditions": ["source-digest-matches", "tree-equivalence", "no-new-findings"]
  },
  "references": [
    { "title": "HTML attribute syntax", "url": "https://html.spec.whatwg.org/multipage/syntax.html#attributes-2" }
  ]
}
```

Production findings additionally carry a stable fingerprint, context/state ID, raw engine attribution when applicable, related locations, assembly provenance, and waiver/baseline disposition. Offsets are zero-based UTF-8 byte offsets with an exclusive end; line/column values are one-based Unicode scalar positions in original source. CRLF counts as one line break. Adapters for UTF-16 editor protocols MUST convert explicitly. Do not mix parser offsets and byte offsets without a mapping.

Fingerprint version 1 hashes rule ID, normalized logical path, template/instance identity if present, a canonical source-token neighborhood, and an occurrence discriminator. Include an algorithm version. Whitespace-only shifts SHOULD preserve identity; ambiguous matches MUST request re-baselining rather than silently suppressing a different defect.

### 12.3 Deduplication and suppression

Group a parser error, checker error, and local rule describing the same defect under a primary finding with related evidence. Retain raw engine output. Count a defect once per score dimension using a declared deduplication key; independent consequences may remain separate findings.

Waivers MUST name the rule/fingerprint or tightly bounded instance scope, reason, owner, expiration, and profile. No wildcard “ignore all” in strict/release profiles. Expired and unmatched waivers are visible findings. Waivers do not change raw conformance status or raw quality score; they can affect a policy gate only where the profile permits it. Strict source/conformance errors, unresolved assembly contracts, and missing required phases are non-waivable in `strict-static` and `release`.

Baselines track existing debt; they do not assert that it passed. Newly introduced errors always fail the migration gate. Reports MUST show total debt, new debt, accepted exceptions, and fixed items separately.

## 13. Autofixes and assisted refactoring

### 13.1 Safety classes

- `safe`: proven within the tool's stated dependency boundary, suitable for explicitly requested automatic application.
- `conditional`: requires named preconditions and post-fix equivalence checks; offered as a diff by default.
- `review`: changes meaning, structure, interaction, or uncertain dependencies; never silently applied.
- `none`: no reliable repair proposal.

Potential conditional fixes include quoting a lexically valid unquoted value, lowercasing an HTML tag name, and removing a void-element trailing slash where it is not part of an attribute value. Preserve character-reference meaning and reparse. Do not blindly wrap an unquoted value when a trailing slash is part of that value. Changing `disabled="disabled"` to `disabled=""` preserves boolean state but changes the attribute string observable by CSS/JavaScript; default that normalization to review unless the relevant dependency boundary is proven.

Adding omitted closing tags is conditional only when the exact insertion preserves the intended parsed tree and token context; otherwise it is review-only. Removing duplicate attributes requires a decision about author intent. Class deduplication may alter exact-string selectors or script reads and therefore is not universally safe.

The following are always review-only in v1: replacing `div` with semantic elements, changing links/buttons, unwrapping nodes, removing classes, changing heading ranks, renaming IDs, adding ARIA, deleting ARIA with uncertain behavior, changing focus management, inventing label/alt text, or choosing decorative-image treatment.

### 13.2 Edit transaction

`fix` defaults to a preview. `--apply` explicitly writes eligible fixes. Each edit includes original source digest, preconditions, affected ranges, dependencies, and expected effects. Reject overlapping/conflicting edits unless a single planner resolves them deterministically. Never edit a generated artifact when a valid source map indicates that the template/data is the actual repair target without making the choice explicit.

Apply in memory, reparse, run required checks, verify no new blocking findings, and test the relevant equivalence boundary. Then write atomically. On failure preserve original files and emit the rejected patch. A second fix pass MUST produce no changes. Preserve comments, whitespace-sensitive text, entities, raw-text payloads, and source provenance. HTML tree equality alone does not prove identical CSS, script, accessibility, or application behavior.

### 13.3 Tree-equivalence contract

For assembly round trips and conditional syntax fixes, compare node kind, namespace URI, local name, attribute namespace/name and exact parsed string value, ordered children, and exact text/comment data. Compare doctypes and document mode for documents. Attribute ordering and adjacent text-node boundaries may be canonicalized; arbitrary whitespace trimming, implied-node removal, role substitution, and boolean-string normalization may not. Template content and supported shadow roots are compared as explicit separate scopes. Source-backed node correspondence must still reveal reparenting and implied elements.

For a fix, compare the before/after trees parsed with identical settings. For assembly, compare the intended IR tree with parsed output after only documented IR normalization. The serializer must compensate for parser handling of leading newlines in `pre`/`textarea` and carriage returns in text rather than dropping meaningful data. Round-trip fixtures must cover these cases. Separate dependency/behavior checks are still required where a proposed change can affect observations outside this tree comparison.

## 14. Scoring and acceptance gates

### 14.1 Scores support diagnosis, not certification

Return a vector and a composite **automated quality score**. Also return coverage and gate status. A score of 100 means no scored findings in the completed selected profile; it does not mean “perfect HTML” or “100% accessible.”

| Dimension | Weight | Rules |
| --- | ---: | --- |
| Authored-source clarity | 20 | `HV-SRC-*` |
| HTML conformance | 25 | `HV-CON-*` |
| Semantic/modern practice | 20 | `HV-SEM-*`, `HV-MOD-*` |
| Automated accessibility | 25 | `HV-A11Y-*` and mapped runtime checks |
| Structural economy | 10 | `HV-BLOAT-*` |

For each dimension `d`:

```text
penalty(error) = 10
penalty(warning) = 3
penalty(review) = 0
penalty(info) = 0

P[d] = sum over enabled scored rules r in d:
       sum of the three largest penalties among r's deduplicated findings
D[d] = max(0, 100 - P[d])
overall = round_half_up(sum(weight[d] * D[d]) / 100)
```

With fewer than three findings for a rule, use those present. Counts and gates still include every occurrence, even after the score cap. For a single `HV-SRC-001` error and no other findings, source score is 90 and the composite is 98, but the strict gate fails. This illustrates why scores cannot override errors.

N/A rules add no penalty only after applicability was evaluated. If a required automated phase or rule cannot be evaluated, affected dimensions and overall are `null`; report provisional observed deductions separately. Unresolved manual reviews do not reduce the automated score but remain explicit and can block `release`.

Do not reward extra elements, attributes, ARIA, templates, or passing test counts. Appending clean nodes must not dilute a finding's penalty. Ratios can still be gamed, so report absolute metrics and baseline changes alongside them. Waivers and baselines do not erase raw penalties. A changed rule set, severity policy, standard revision, or budget creates a different profile hash; scores are comparable only under matching profiles and scopes.

### 14.2 Default gates

- `strict-static`: all required static phases complete; no error findings; minimum composite 90 and every dimension at least 80. Outstanding manual reviews remain visible.
- `release`: strict gate plus required browser scenarios complete, no blocking runtime errors, and all mandatory manual evidence accepted for the current content/state hashes.
- `fragment`: fragment contract met; no errors in supported required checks; document-level claims remain untested until assembly.
- `migration`: fail new errors and configured regressions; retain existing debt and explicitly label the result as migration status.

Warnings may become blocking through a documented profile; mandatory rules cannot be disabled while retaining a built-in strict/release profile name. A custom profile MUST have a distinct identity.

## 15. CLI, configuration, and API

### 15.1 CLI contract

```sh
htmlverify check page.html --profile strict-static
htmlverify check "dist/**/*.html" --format json --output report.json
htmlverify check - --stdin-filename generated.html --format json
htmlverify check row.html --profile fragment --context context.json
htmlverify assemble page.plan.json --registry components --output-dir build
htmlverify audit build/index.html --profile release --scenarios states.json
htmlverify fix page.html --preview
htmlverify fix page.html --apply --safety safe
htmlverify explain HV-CON-003 --format json
htmlverify rules --profile strict-static --format json
htmlverify templates list --registry components
htmlverify templates verify --registry components
htmlverify baseline create --report report.json --output baseline.json
htmlverify standards update --review
```

`check` never modifies source. Globs are resolved by HTMLVerify in sorted order; no matches is an input error unless explicitly allowed. `-` reads stdin. JSON output goes exclusively to stdout or the requested output file; progress/logs go to stderr. `--format` accepts `text`, `json`, or `sarif`. `explain` returns authority, exact applicability, examples, fixes, and source links for LLM use.

Exit codes: `0` gate passes, including explicitly reported accepted exceptions; `1` completed analysis fails a quality gate; `2` invalid input/configuration or requested unsupported feature; `3` required analysis incomplete or operational engine failure. A known quality failure plus a required engine failure returns `3` and retains both results. Multiple files use precedence `2`, then `3`, then `1`, then `0`.

### 15.2 Configuration example

```json
{
  "schemaVersion": "1.0",
  "profile": "strict-static",
  "lockfile": "htmlverify.lock.json",
  "evaluationDate": "2026-10-17",
  "input": { "encoding": "utf-8", "kind": "document" },
  "conformance": { "backend": "nu", "network": "off" },
  "budgets": {
    "genericRatio": 0.35,
    "minimumRatioSample": 20,
    "maxGenericChain": 3,
    "maxClassesPerElement": 6,
    "p95ClassesPerElement": 4,
    "maxDepth": 12,
    "elements": 1500
  },
  "gate": { "minimumScore": 90, "minimumDimensionScore": 80 },
  "waivers": [],
  "runtime": { "enabled": false },
  "report": { "format": "json", "canonical": true }
}
```

Configuration precedence: built-in profile → explicitly named config file → explicit CLI overrides. Do not read undeclared global configuration. Reject unknown keys, invalid severity names, impossible budgets, conflicting input kinds, and disabled mandatory rules. Always emit the resolved configuration and its hash. Publish versioned JSON Schemas for config, lockfile, plans, registry entries, contexts, scenarios, waivers, and reports.

### 15.3 Library API

```ts
type Input =
  | { kind: "document"; path: string; bytes: Uint8Array }
  | { kind: "fragment"; path: string; bytes: Uint8Array; context: FragmentContext };

interface HTMLVerify {
  verify(input: Input, options: VerifyOptions): Promise<VerificationReport>;
  assemble(plan: AssemblyPlan, options: AssemblyOptions): Promise<AssemblyResult>;
  audit(target: AuditTarget, scenarios: ScenarioManifest,
        options: AuditOptions): Promise<VerificationReport>;
  planFixes(report: VerificationReport, options: FixOptions): Promise<FixPlan>;
  applyFixes(plan: FixPlan, options: ApplyOptions): Promise<FixResult>;
  explain(ruleId: string): RuleExplanation;
  listRules(profile: string): RuleDefinition[];
}
```

The named types MUST be published and align with the JSON Schemas. Analysis returns reports rather than throwing for ordinary validation findings. Invalid API arguments throw typed usage errors; operational engine failures are represented in report execution status when a run has begun. Support cancellation, bounded concurrency, streaming progress separate from final results, and in-memory operation without filesystem writes.

An optional P4 local service exposes `POST /v1/verify`, `/assemble`, `/audit`, and `/fix-plan`, plus `GET /v1/rules/{id}`. It uses the same schemas and does not write caller files. Bind locally by default; deployments add authentication, request limits, and resource policy. A submitted HTML failure is an analysis result, not HTTP 500. Unsupported input is 400/422; operational service failure is 5xx.

### 15.4 Report envelope

Required top-level fields: `schemaVersion`, `tool`, `inputDigests`, `profile`, `lockDigest`, `executionStatus`, `gateStatus`, `scope`, `coverage`, `findings`, `reviews`, `metrics`, `scores`, `conformance`, `assembly`, `artifacts`, and `effectiveConfig`. Optional execution metadata is separate from canonical content.

SARIF output SHALL conform to [SARIF 2.1.0][sarif], map stable rule IDs and source regions, attach related locations and fix previews, and retain authority/coverage details in properties. JSON remains the lossless native format.

## 16. LLM workflow and repair protocol

1. Read the project profile, rule capabilities, and approved template catalog.
2. State content/interaction intent in an assembly plan; select the smallest appropriate reviewed components.
3. Bind typed content. Generate a new fragment only where the catalog cannot express the requirement.
4. Assemble and run `strict-static` checks.
5. Address errors by source/contract location; request `explain(ruleId)` for unfamiliar rules.
6. Review semantic/bloat candidates with their evidence; do not replace elements just to raise a score.
7. Apply eligible mechanical edits or propose a reviewed structural change, then rerun.
8. Run declared runtime scenarios and obtain required human evidence for release.
9. Return artifacts with the profile, lock digest, gate, score vector, coverage, and unresolved reviews.

The loop MUST have an explicit budget, defaulting to three repair iterations. Repeated identical fingerprints or oscillating patches stop automatic repair and produce a concise unresolved report. The LLM must not disable rules, add blanket waivers, fabricate review evidence, or change semantics solely to obtain a pass. An optional LLM critic emits advisory proposals with model/prompt provenance; it cannot authoritatively override deterministic evidence or make static runs nondeterministic.

## 17. Test fixtures and verification strategy

### 17.1 Fixture format

Each rule MUST have passing, failing, boundary, and non-applicable fixtures, plus `cantTell`/`untested` cases where relevant. Include original bytes, context, profile/lock reference, expected rule IDs/ranges, parsed-tree evidence, score/gate, and expected fix or explicit no-fix decision. Runtime fixtures additionally include resources, scenarios, environment, and expected accessibility evidence.

Golden tests compare canonical reports. Rule unit tests isolate the evaluator; integration fixtures check the full pipeline. Import selected parser/platform cases from [web-platform-tests][wpt] and the parser/checker projects with pinned revisions and license attribution; an imported fixture must state what HTMLVerify behavior it validates.

### 17.2 Minimum regression matrix

| Fixture | Expected distinction |
| --- | --- |
| `class=card` versus `class="card"` | Policy failure versus pass; HTML may conform in both |
| Bare `disabled`, `disabled=""`, `disabled="false"` | Quote/boolean policy versus invalid boolean value; false string does not disable the attribute |
| Omitted `li`, `p`, `html`, `head`, or `body` tags | Strict source failure even if allowed by HTML |
| `<br>`, `<br />`, `</br>`, `<div />` | Void policy, forbidden/invalid syntax, and non-void slash behavior differ |
| `<svg><path /></svg>`; `viewBox` | Namespace rules preserved |
| Explicit table rows without `tbody` | Implicit node detected as strict policy, not automatically HTML error |
| Block content inside a paragraph | Browser repair and content violation remain visible |
| Misnested formatting and table foster parenting | Original and repaired structures both available |
| Duplicate attributes with conflicting values | No lost evidence; no guessed autofix |
| Tag-like strings inside script/style/comment | No false tag or omitted-close report |
| Leading newline in `pre`/`textarea`; carriage returns in typed text | Serializer round trip preserves intended text |
| Transparent anchor inside paragraph, nested anchor, button descendant | Context and element-specific restrictions |
| Traditional and newer conforming select structures | Snapshot-aware result; no stale blanket grammar |
| `tr` fragment under `tbody` versus under `div` | Context affects parsing/validity |
| Two fragments exporting the same ID | Assembly-level collision detected |
| Native button with text and no `aria-label` | Accessible name accepted |
| Implicit label, explicit label, placeholder-only control | Correct association versus insufficient labeling |
| Decorative image with empty alt, missing alt, misleading alt | Syntax/policy versus manual quality distinction |
| Heading rank skip, multiple `h1`s | Guidance/policy classification, no invented universal WCAG failure |
| `tabindex="-1"`, positive tabindex, hidden/inert state | Navigation policy separated from focus/visibility behavior |
| Prohibited ARIA name/role on native element | Current ARIA-in-HTML table applied |
| Inert template definition versus instantiated fragment | Different obligations and scopes |
| Open/closed shadow root and slotted content | Declared coverage; no hidden false pass |
| Existing literal entity, URL with ampersand, malicious text slot | Escaping preserves text/URL meaning; no markup injection |
| Duplicate instance keys, registry cycle, hash mismatch, bad slot | Assembly fails before output release |
| Dialog open/closed and form error state | State coverage required; static pass does not imply interaction pass |
| Tool crash, timeout, missing engine, missing resources | Incomplete/failed execution, null score, nonzero exit |
| UTF-8 multibyte, emoji, CRLF, BOM | Correct byte and editor-coordinate mapping |
| Expired/unmatched waiver; baseline fingerprint collision | Visible disposition; no silent suppression |
| Wrong MIME kind or JSX source | Explicit unsupported input, no misleading HTML report |

### 17.3 Properties and adversarial tests

- Assemble → serialize → parse preserves the intended supported tree.
- Fix application is idempotent and cannot introduce new blocking findings.
- Canonical reports are stable under repeated runs and worker scheduling changes.
- Adding unrelated clean markup does not dilute fixed-rule penalties.
- Invalid data cannot escape its typed text/attribute/URL/fragment boundary.
- Changing a dependency/context invalidates cached results and dependent review evidence.
- Source edits applied through provenance maps identify the right template and all affected instances.
- Arbitrary malformed inputs terminate within limits; no script execution, undeclared network, or out-of-root writes occur.
- Equivalent cases from independent parser/checker fixtures are compared; disagreements become regression tests, not suppressed noise.

## 18. Acceptance criteria

The following are release gates for the stage implementing each capability, not promises that all stages ship together.

| ID | Measurable acceptance criterion |
| --- | --- |
| `AC-01` | Every shipped rule has authority, applicability, sources, coverage requirements, severity, fix class, and positive/negative/boundary fixtures. All required fixtures pass. |
| `AC-02` | Source policy catches unquoted values, omitted optional tags, inserted wrappers, duplicate attributes, and non-void slash misuse without losing original locations. |
| `AC-03` | The local conformance adapter preserves all backend errors, reports its digest, and distinguishes unavailable coverage from success. |
| `AC-04` | P1 document fixtures cover sequence, category, transparency, ancestor restrictions, text rules, attribute conditions, and namespaces. P2 additionally covers public fragment-context contracts and insertion obligations. |
| `AC-05` | Named native controls and correct implicit labels pass; missing names and prohibited ARIA fail when determinable; alt quality and heading appropriateness remain explicit reviews. |
| `AC-06` | No WCAG 2.2 report uses removed criterion 4.1.1 as an automatic markup-failure mapping; no automated report claims complete WCAG conformance. |
| `AC-07` | Complexity metrics match hand-calculated fixtures, including zero/small denominators and p95 boundaries; legitimate `div` and utility-CSS cases can be reviewed without forced semantic rewrites. |
| `AC-08` | The same assembly plan and lockfile produce byte-identical HTML and provenance; ID collisions, invalid slots, dependency cycles, and context failures block release. |
| `AC-09` | A hostile text/attribute/URL test corpus cannot escape the declared assembly sinks; unsupported sinks fail explicitly. |
| `AC-10` | All automatic fixes are idempotent, preserve declared equivalence, pass post-fix checks, and roll back atomically on failure. Review-only fixes are never auto-applied. |
| `AC-11` | P1 canonical static JSON matches across two runs on each supported OS; Unicode/CRLF byte-to-editor-coordinate conversion has unit fixtures. P4 verifies those conversions through actual editor adapters. |
| `AC-12` | JSON examples and schemas validate, CLI/API outcomes agree, exit-code precedence is tested, and SARIF validates against its schema. |
| `AC-13` | Missing mandatory checks yield partial/failed execution and no overall score; the gate is incomplete unless a known blocking violation makes it fail. Severe findings cannot be compensated by clean-markup padding or waivers. |
| `AC-14` | Runtime reports enumerate all declared scenarios and inaccessible regions; timeouts/flakiness are retained and cannot become silent passes. |
| `AC-15` | P2 starter templates include document shell, native action, labeled input, navigation list, disclosure, and table with static variants and runtime obligations. P3 adds dialog and completes required interaction/state fixtures. |
| `AC-16` | Baseline and waiver fixtures demonstrate expiry, narrow matching, raw-debt visibility, and failure on new errors. |

Performance targets are provisional engineering budgets: on a declared CI reference machine, warm static verification including the local checker SHOULD finish a 100 KiB/2,000-element page within 2 seconds at p95; a 100-page corpus within 30 seconds at bounded concurrency; peak resident memory below 512 MiB for the coordinator, with checker/browser processes budgeted separately. Publish cold-start and warm measurements, hardware, corpus, engine builds, and exclusions. Failure to meet a target requires a measured design decision, not a correctness shortcut.

## 19. Staged roadmap

| Stage | Deliverables | Exit condition |
| --- | --- | --- |
| **P0 — foundations** | Schemas, result/authority model, standards registry, source-location model, parser and Nu experiments, fixture harness | Demonstrate quotes/omissions/repairs/namespace/context distinctions with accurate source locations; record architectural decisions |
| **P1 — rigorous document checks** | `check`, `explain`, `rules`; strict source rules, local conformance, initial constraint indexes, static a11y, semantic reviews, bloat metrics, canonical JSON/text, scoring/gates | AC-01–07, AC-11, relevant AC-12–13; documented automated-coverage matrix; useful LLM loop on a curated corpus |
| **P2 — deterministic assembly** | Registry, restricted IR, typed slots, contextual fragments, scoped IDs, provenance, starter static templates, guarded fixes, baseline/waiver support | AC-08–10, AC-16, P2 portions of AC-04/15; final-document revalidation; reproducible assembly and context-sensitive fixtures |
| **P3 — rendered accessibility and release evidence** | Browser scenarios, pinned a11y engine, focus/state checks, shadow coverage, review evidence, dialog and other interactive templates, full `release` profile | AC-14–15; all release-profile capabilities implemented and documented, with no false completeness claims |
| **P4 — ecosystem and maintenance** | SARIF/editor integration, framework/source-map adapters, optional service, plugin API, compatibility datasets, standards-update workflow, benchmark/calibration corpus | Full AC-11/12, public compatibility/coverage matrix, reviewed rule updates, measured false-positive and performance reports |

P1 is the first useful deliverable, not a complete implementation of the assembly/release vision. Each stage SHALL advertise supported capabilities; future commands/profile names must return explicit unsupported-feature errors until implemented. Avoid making an LLM dependency part of the deterministic core.

After the first corpus evaluation, review bloat thresholds, semantic heuristic precision, diagnostic deduplication, and fixer acceptance rates. Publish counts of confirmed defects, false positives, unresolved cases, and unsupported cases by rule. Do not combine them into an unexplained “accuracy” percentage.

## 20. Research references and maintenance notes

The references below were consulted for this specification. Living standards and drafts can change; implementation must pin the revisions actually used. Linked guidance should be read in its full context rather than converted wholesale into hard failures. The architecture, profiles, rule IDs, numerical budgets, scoring model, and API contracts in this document are original HTMLVerify design decisions.

- [WHATWG HTML Living Standard][html] — primary HTML authority.
- [W3C/WHATWG collaboration agreement][html-collaboration] — context for the shared HTML/DOM standards process.
- [HTML syntax][html-syntax], [parsing][html-parsing], and [fragment parsing][html-fragments] — authored syntax versus parsed interpretation.
- [HTML content models and semantics][html-dom], [grouping content][html-grouping], [text-level semantics][html-text], [tables][html-tables], and [forms][html-forms] — context and element requirements.
- [HTML div][html-div], [class][html-class], [template][html-template], [select][html-select], [interactive elements][html-interactive], [popover][html-popover], and [obsolete features][html-obsolete] — targeted policy and modern-feature references.
- [WCAG 2.2][wcag22], [conformance requirements][wcag-conformance], and [Parsing removal explanation][wcag-parsing] — accessibility target and limits.
- [WAI-ARIA 1.2][aria12], [ARIA in HTML][aria-html], [Accessible Name 1.1][accname11], [Accessible Name 1.2 draft][accname12], and [HTML-AAM draft][html-aam] — semantics, names, and mappings with explicit maturity.
- [ACT Rules Format][act], [APG][apg], and WAI tutorials for [page structure][wai-structure], [images][wai-images], and [labels][wai-labels] — test design and interpretive guidance.
- [Nu documentation][nu] and [upstream repository][nu-repo], [parse5][parse5], and [axe-core][axe] — implementation candidates, not substitutes for standards.
- [WHATWG URL][url], [SARIF 2.1.0][sarif], and [web-platform-tests][wpt] — URL parsing, interchange, and external test material.

[html]: https://html.spec.whatwg.org/multipage/
[html-collaboration]: https://www.w3.org/2019/04/WHATWG-W3C-MOU.html
[html-syntax]: https://html.spec.whatwg.org/multipage/syntax.html
[html-metadata]: https://html.spec.whatwg.org/multipage/semantics.html
[html-microsyntax]: https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#boolean-attributes
[html-parsing]: https://html.spec.whatwg.org/multipage/parsing.html
[html-fragments]: https://html.spec.whatwg.org/multipage/parsing.html#parsing-html-fragments
[html-dom]: https://html.spec.whatwg.org/multipage/dom.html#content-models
[html-text]: https://html.spec.whatwg.org/multipage/text-level-semantics.html
[html-grouping]: https://html.spec.whatwg.org/multipage/grouping-content.html
[html-tables]: https://html.spec.whatwg.org/multipage/tables.html
[html-forms]: https://html.spec.whatwg.org/multipage/form-elements.html
[html-select]: https://html.spec.whatwg.org/multipage/form-elements.html#the-select-element
[html-div]: https://html.spec.whatwg.org/multipage/grouping-content.html#the-div-element
[html-class]: https://html.spec.whatwg.org/multipage/dom.html#classes
[html-interactive]: https://html.spec.whatwg.org/multipage/interactive-elements.html
[html-popover]: https://html.spec.whatwg.org/multipage/popover.html
[html-template]: https://html.spec.whatwg.org/multipage/scripting.html#the-template-element
[html-obsolete]: https://html.spec.whatwg.org/multipage/obsolete.html
[wcag22]: https://www.w3.org/TR/WCAG22/
[wcag-conformance]: https://www.w3.org/TR/WCAG22/#conformance
[wcag-parsing]: https://www.w3.org/WAI/WCAG22/Understanding/parsing.html
[wcag-language]: https://www.w3.org/WAI/WCAG22/Understanding/language-of-page.html
[wcag-nontext]: https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html
[wcag-relations]: https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html
[wcag-name-role]: https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html
[wcag-label-name]: https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html
[wcag-keyboard]: https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html
[wcag-focus-obscured]: https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html
[wcag-target-size]: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
[aria12]: https://www.w3.org/TR/wai-aria-1.2/
[aria-host]: https://www.w3.org/TR/wai-aria-1.2/#host_general_conflict
[aria-html]: https://www.w3.org/TR/2026/REC-html-aria-20260811/
[accname11]: https://www.w3.org/TR/accname-1.1/
[accname12]: https://www.w3.org/TR/accname-1.2/
[html-aam]: https://www.w3.org/TR/html-aam-1.0/
[act]: https://www.w3.org/TR/act-rules-format-1.1/
[apg]: https://www.w3.org/WAI/ARIA/apg/
[wai-structure]: https://www.w3.org/WAI/tutorials/page-structure/
[wai-images]: https://www.w3.org/WAI/tutorials/images/
[wai-labels]: https://www.w3.org/WAI/tutorials/forms/labels/
[nu]: https://validator.github.io/validator/
[nu-repo]: https://github.com/validator/validator
[parse5]: https://parse5.js.org/
[axe]: https://github.com/dequelabs/axe-core
[url]: https://url.spec.whatwg.org/
[sarif]: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
[wpt]: https://web-platform-tests.org/
