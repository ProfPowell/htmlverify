// What each rule checks and how to fix it, for `htmlverify explain`. Every
// example is run by test/docs.test.ts: `fails` must report the rule and
// `passes` must not.

export interface RuleDoc {
  why: string;
  fix: string;
  fails: string;
  passes: string;
  /** Context element for the examples; null checks them as documents. Defaults to div. */
  context?: string | null;
}

const DOC = (body: string, head = '') =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n${head}<title>Example</title>\n</head>\n<body>\n${body}\n</body>\n</html>`;

export const RULE_DOCS: Readonly<Record<string, RuleDoc>> = {
  'syntax/parse-error': {
    why: 'The tokenizer recovered from malformed markup. Browsers recover the same way, but the result is often not what was meant.',
    fix: 'Follow the message for the specific error code.',
    fails: '<p id="intro"title="Welcome">Hello</p>',
    passes: '<p id="intro" title="Welcome">Hello</p>',
  },
  'syntax/duplicate-attribute': {
    why: 'The parser keeps the first value and drops the rest, so later values silently do nothing.',
    fix: 'Merge the values into one attribute.',
    fails: '<p class="note" class="wide">Hello</p>',
    passes: '<p class="note wide">Hello</p>',
  },
  'syntax/self-closing-non-void': {
    why: 'In HTML, "/>" on a non-void element is ignored: the element stays open and swallows what follows.',
    fix: 'Close the element with an end tag.',
    fails: '<div /><p>Swallowed by the div</p>',
    passes: '<div></div><p>A sibling</p>',
  },
  'syntax/unclosed-element': {
    why: 'The parser closed the element somewhere else than the source suggests, so the tree differs from what was written.',
    fix: 'Add the end tag where the element should end.',
    fails: '<h1>Title<h2>Subtitle</h2>',
    passes: '<h1>Title</h1><h2>Subtitle</h2>',
  },
  'syntax/stray-end-tag': {
    why: 'An end tag that matches no open element is ignored or creates an element, usually because an earlier element was closed implicitly.',
    fix: 'Delete the end tag, or fix the element that was closed early.',
    fails: '<p>Text</p></p>',
    passes: '<p>Text</p>',
  },
  'syntax/misplaced-start-tag': {
    why: 'The parser dropped the start tag, or wrapped it in an element it made up, so the tree differs from the source.',
    fix: 'Move the element where its parent allows it, or add the missing wrapper.',
    fails: '<table><td>1</td></table>',
    passes: '<table><tbody><tr><td>1</td></tr></tbody></table>',
  },
  'syntax/misnested': {
    why: 'Overlapping tags are repaired by cloning elements, which duplicates them in the tree.',
    fix: 'Close elements in the reverse order they were opened.',
    fails: '<b><i>bold italic</b> italic</i>',
    passes: '<b><i>bold italic</i></b><i> italic</i>',
  },
  'syntax/reordered': {
    why: 'Content in the wrong place inside a table is moved out of it, before the table.',
    fix: 'Put the content in a cell, or move it outside the table.',
    fails: '<table><tbody><tr><td>1</td></tr></tbody>Note</table>',
    passes: '<p>Note</p><table><tbody><tr><td>1</td></tr></tbody></table>',
  },
  'syntax/doctype': {
    why: 'Without <!doctype html>, browsers render in quirks mode.',
    fix: 'Start the document with <!doctype html>.',
    fails: DOC('<p>Hello</p>').replace('<!doctype html>\n', ''),
    passes: DOC('<p>Hello</p>'),
    context: null,
  },
  'syntax/encoding': {
    why: 'A document must declare UTF-8 in its first 1024 bytes, or browsers may guess the encoding.',
    fix: 'Add <meta charset="utf-8" /> as the first element in <head>.',
    fails: DOC('<p>Hello</p>').replace('<meta charset="utf-8" />\n', ''),
    passes: DOC('<p>Hello</p>'),
    context: null,
  },
  'style/attr-quotes': {
    why: 'The house style double-quotes every value, so values never break on spaces or special characters.',
    fix: 'Apply the fix, or quote the value with double quotes.',
    fails: '<p class=note>Hello</p>',
    passes: '<p class="note">Hello</p>',
  },
  'style/boolean-attr': {
    why: 'The house style writes boolean attributes as name="true", which reads better than an empty value.',
    fix: 'Apply the fix. To turn the attribute off, remove it.',
    fails: '<input type="checkbox" checked />',
    passes: '<input type="checkbox" checked="true" />',
  },
  'style/lowercase': {
    why: 'Lowercase names are the canonical form, and foreign names like viewBox are case-sensitive in the DOM.',
    fix: 'Apply the fix.',
    fails: '<P CLASS="note">Hello</P>',
    passes: '<p class="note">Hello</p>',
  },
  'style/void-element': {
    why: 'The house style writes void elements in one form, <br /> by default.',
    fix: 'Apply the fix.',
    fails: '<p>One<br>Two</p>',
    passes: '<p>One<br />Two</p>',
  },
  'style/explicit-start-tag': {
    why: 'The house style writes every start tag, so the source shows the whole tree.',
    fix: 'Apply the fix, or write the start tag.',
    fails: '<!doctype html>\n<meta charset="utf-8" />\n<title>Example</title>\n<p>Hello</p>',
    passes: DOC('<p>Hello</p>'),
    context: null,
  },
  'style/explicit-end-tag': {
    why: 'The house style writes every end tag, so the source shows where each element ends.',
    fix: 'Apply the fix, or write the end tag.',
    fails: '<ul><li>One<li>Two</ul>',
    passes: '<ul><li>One</li><li>Two</li></ul>',
  },
  'style/doctype': {
    why: 'The house style writes the doctype in exactly one form.',
    fix: 'Apply the fix.',
    fails: DOC('<p>Hello</p>').replace('<!doctype html>', '<!DOCTYPE HTML>'),
    passes: DOC('<p>Hello</p>'),
    context: null,
  },
  'content/attribute-value': {
    why: 'Browsers ignore or misread invalid values, and fall back to defaults.',
    fix: 'Use a value from the message: a keyword, number, URL, date, or language tag in the required form.',
    fails: '<input type="emial" name="email" />',
    passes: '<input type="email" name="email" />',
  },
  'content/unknown-element': {
    why: 'Browsers treat unknown elements as meaningless inline elements; a misspelled element loses its semantics.',
    fix: 'Correct the name, or give a custom element a name with a hyphen.',
    fails: '<sectoin><p>Hello</p></sectoin>',
    passes: '<section><p>Hello</p></section>',
  },
  'content/obsolete': {
    why: 'Obsolete features are no longer part of HTML; most have no effect, or only presentational ones.',
    fix: 'Follow the replacement in the message, usually CSS or a semantic element.',
    fails: '<center>Hello</center>',
    passes: '<p class="center">Hello</p>',
  },
  'content/unknown-attribute': {
    why: 'Browsers ignore attributes the element doesn’t define, so a misspelled or misplaced attribute silently does nothing.',
    fix: 'Correct the name, move the attribute to an element it applies to, or use data-* for custom data.',
    fails: '<label className="field" htmlFor="name">Name</label>',
    passes: '<label class="field" for="name">Name</label>',
  },
  'content/missing-attribute': {
    why: 'Some elements do nothing, or nothing correct, without a required attribute.',
    fix: 'Add the attribute the message names.',
    fails: '<img alt="Logo" />',
    passes: '<img src="logo.png" alt="Logo" />',
  },
  'content/child': {
    why: 'A child the parent can’t contain is outside HTML’s content model; browsers may render it, but the structure has no defined meaning.',
    fix: 'Move the child to a parent that allows it, or use an element the parent accepts.',
    fails: '<span><div>Block</div></span>',
    passes: '<div><span>Inline</span></div>',
  },
  'content/order': {
    why: 'Some elements need their children in a set order or number: a summary first in details, one title in head.',
    fix: 'Reorder the children, or add or remove the counted element.',
    fails: '<details><p>Answer</p><summary>Question</summary></details>',
    passes: '<details><summary>Question</summary><p>Answer</p></details>',
  },
  'content/descendant': {
    why: 'Nesting interactive content, forms, or labels breaks how browsers and assistive technology handle the outer element.',
    fix: 'Move the descendant out, or replace one of the two elements.',
    fails: '<a href="/"><button type="button">Go</button></a>',
    passes: '<a href="/">Go</a>',
  },
  'content/context': {
    why: 'Some elements only mean something in a particular parent: an li outside a list has no list to belong to.',
    fix: 'Put the element inside the parent the message names, or use another element.',
    fails: '<li>Item</li>',
    passes: '<ul><li>Item</li></ul>',
  },
  'content/duplicate-id': {
    why: 'Labels, ARIA references, and fragment links resolve to the first element with an ID; later ones are unreachable.',
    fix: 'Give each element its own ID.',
    fails: '<h2 id="intro">Intro</h2><p id="intro">Text</p>',
    passes: '<h2 id="intro">Intro</h2><p id="intro-text">Text</p>',
  },
  'content/invalid-id': {
    why: 'An empty ID, or one with whitespace, can’t be referenced by for, aria-*, or a fragment link.',
    fix: 'Use a non-empty ID without whitespace.',
    fails: '<p id="two words">Text</p>',
    passes: '<p id="two-words">Text</p>',
  },
  'content/idref': {
    why: 'A reference to a missing ID, or to the wrong kind of element, silently does nothing: the label labels nothing, the list suggests nothing.',
    fix: 'Point the reference at an existing element of the right kind.',
    fails: '<p id="name">Name</p><label for="name">Name</label>',
    passes: '<label for="name">Name</label><input id="name" />',
  },
  'content/document': {
    why: 'A document has one visible main content area and one character encoding.',
    fix: 'Keep one visible <main> and one <meta charset="utf-8" />.',
    fails: DOC('<main>One</main>\n<main>Two</main>'),
    passes: DOC('<main>One</main>'),
    context: null,
  },
};
