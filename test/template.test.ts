import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContract, type Contract } from '../src/assemble/contract.ts';
import { compileTemplate, TemplateError, type TNode } from '../src/assemble/template.ts';
import { Vocabulary } from '../src/vocab/vocabulary.ts';

const vocabulary = new Vocabulary(['vanilla-breeze@0.3.1'], null, 'x-');

const contract = (params: Record<string, unknown>, extra: Record<string, unknown> = {}): Contract => parseContract({
  id: 'test/component', version: '1.0.0', summary: 'Test.', use: 'Tests.', params,
  provenance: { authors: ['Test'], aiAssisted: false }, ...extra,
}, 'component.json');

const compile = (source: string, c: Contract) => compileTemplate(source, c, vocabulary);

const problems = (source: string, c: Contract): string[] => {
  try {
    compile(source, c);
    return [];
  } catch (error) {
    assert.ok(error instanceof TemplateError, String(error));
    return error.problems.map((p) => `${p.line}:${p.column} ${p.message}`);
  }
};

/** A compact rendering of the compiled tree, to compare shapes. */
function shape(nodes: readonly TNode[]): string {
  return nodes.map((n) => {
    switch (n.kind) {
      case 'element': return `<${n.name}${n.rank ? ` rank+${n.rank}` : ''}${n.attrs.map((a) => ` ${a.name}:${a.kind}`).join('')}>${shape(n.children)}</${n.name}>`;
      case 'text': return JSON.stringify(n.value);
      case 'value': return `{${n.path.root}${n.path.field ? `.${n.path.field}` : ''}:${n.type}}`;
      case 'if': return `[if ${n.negate ? '!' : ''}${n.path.root}${n.path.field ? `.${n.path.field}` : ''}: ${shape(n.children)}]`;
      case 'each': return `[each ${n.path.root} as ${n.as}: ${shape(n.children)}]`;
      case 'slot': return `[slot ${n.name}]`;
      case 'doctype': return `<!doctype ${n.name}>`;
    }
  }).join(' ');
}

const TEXT_FIELD = contract({
  label: { type: 'text', minLength: 1 },
  name: { type: 'text', pattern: '^[a-z][a-z0-9_-]*$' },
  type: { type: 'enum', values: ['text', 'email', 'tel', 'url', 'search', 'password'], default: 'text' },
  autocomplete: { type: 'enum', values: ['name', 'email', 'tel', 'off'], required: false },
  required: { type: 'boolean', default: false },
  hint: { type: 'inline', required: false },
}, { context: 'form' });

test('the spec’s form/text-field template compiles', () => {
  const t = compile(`<form-field>
  <label for="@input">{{label}}</label>
  <input id="@input" type="{{type}}" name="{{name}}" autocomplete="{{autocomplete}}" required="{{required}}" aria-describedby="@hint" />
  <template vb-if="hint">
    <output id="@hint" for="@input">{{hint}}</output>
  </template>
</form-field>
`, TEXT_FIELD);
  assert.equal(t.context, 'form');
  assert.deepEqual([...t.symbols].sort(), ['hint', 'input']);
  assert.equal(shape(t.nodes),
    '<form-field>"\\n  " <label for:ids>{label:text}</label> "\\n  " <input id:ids type:value name:value autocomplete:value required:value aria-describedby:ids></input> "\\n  " [if hint: "\\n    " <output id:ids for:ids>{hint:inline}</output> "\\n  "] "\\n"</form-field>');
  const input = (t.nodes[0] as Extract<TNode, { kind: 'element' }>).children.find((n) => n.kind === 'element' && n.name === 'input') as Extract<TNode, { kind: 'element' }>;
  assert.deepEqual(input.attrs.find((a) => a.name === 'required'), { kind: 'value', name: 'required', path: { root: 'required', field: null }, type: 'boolean', boolean: true, loc: { line: 3, column: 86 } });
});

test('whitespace between block items is dropped, directives looked through; elsewhere it stays', () => {
  const nav = contract({ items: { type: 'list', items: { text: { type: 'text' }, href: { type: 'url' } } } }, { context: 'body' });
  const t = compile(`<ul>
  <template vb-each="items" vb-as="item">
    <li><a href="{{item.href}}">{{item.text}}</a></li>
  </template>
</ul>
`, nav);
  assert.equal(shape(t.nodes), '<ul>[each items as item: <li><a href:value>{item.text:text}</a></li>]</ul>');
  const p = compile('<p>\n  Read <a href="{{href}}">more</a>\n</p>\n', contract({ href: { type: 'url' } }));
  assert.equal(shape(p.nodes), '<p>"\\n  Read " <a href:value>"more"</a> "\\n"</p>');
});

test('rows repeat inside tbody: <template> parses there as written', () => {
  const t = compile('<table><caption>{{caption}}</caption><tbody><template vb-each="rows" vb-as="row"><tr><td>{{row.name}}</td><td>{{row.price}}</td></tr></template></tbody></table>',
    contract({ caption: { type: 'text' }, rows: { type: 'list', items: { name: { type: 'text' }, price: { type: 'text' } } } }));
  assert.equal(shape(t.nodes), '<table><caption>{caption:text}</caption> <tbody>[each rows as row: <tr><td>{row.name:text}</td> <td>{row.price:text}</td></tr>]</tbody></table>');
});

test('headings and IDs: ranked and symbolic in components, literal in pages', () => {
  const section = compile('<section aria-labelledby="@title"><h2 id="@title" vb-rank>{{title}}</h2><h3 vb-rank="+2">Sub</h3><a href="#@title">Top</a></section>', contract({ title: { type: 'text' } }));
  assert.equal(shape(section.nodes), '<section aria-labelledby:ids><h2 rank+1 id:ids>{title:text}</h2> <h3 rank+2>"Sub"</h3> <a href:fragment>"Top"</a></section>');
  const page = compile('<!doctype html>\n<html lang="{{lang}}"><head><title>{{title}}</title></head><body><main id="main"><h1>{{title}}</h1><template vb-slot="main"></template></main></body></html>\n',
    contract({ lang: { type: 'lang' }, title: { type: 'text' } }, { context: 'document', slots: { main: {} } }));
  assert.equal(shape(page.nodes), '<!doctype html> <html lang:value><head><title>{title:text}</title></head> <body><main id:static><h1>{title:text}</h1> [slot main]</main></body></html>');
});

test('literal braces stay text, character references decode around bindings', () => {
  const t = compile('<p>&#123;&#123;not a binding}} &amp; {{label}} &lt;3</p>', contract({ label: { type: 'text' } }));
  assert.equal(shape(t.nodes), '<p>"{{not a binding}} & " {label:text} " <3"</p>');
  const a = compile('<p title="Fish &amp; {{dish}}">x</p>', contract({ dish: { type: 'text' } }));
  assert.deepEqual((a.nodes[0] as Extract<TNode, { kind: 'element' }>).attrs[0], { kind: 'mixed', name: 'title', parts: ['Fish & ', { root: 'dish', field: null }], loc: { line: 1, column: 4 } });
});

test('parameters: declared, used, and resolved', () => {
  assert.deepEqual(problems('<p>{{lable}} {{a + b}} {{item.text}} {{label.text}}</p>', contract({ label: { type: 'text' }, spare: { type: 'text' } })), [
    '1:1 "spare" is declared but never used; use it, or remove it from component.json',
    '1:4 {{lable}}: "lable" isn’t declared in component.json; did you mean "label"?',
    '1:14 {{a + b}} isn’t a binding: write a parameter name, or item.field inside vb-each; there are no expressions.',
    '1:24 {{item.text}}: "item" isn’t declared in component.json.',
    '1:38 {{label.text}}: parameters have no fields; fields belong to list items inside vb-each.',
  ]);
});

test('directives: one per template, well-formed, on the right kinds of parameters', () => {
  const c = contract({ items: { type: 'list', items: 'text' }, kind: { type: 'enum', values: ['a', 'b'], default: 'a' }, label: { type: 'text' } }, { slots: { body: {} } });
  assert.deepEqual(problems(`<ul><template vb-each="items"><li>x</li></template></ul>
<template vb-if="kind">{{label}}</template>
<template vb-each="label" vb-as="x">y</template>
<template vb-sloot="body"></template>
<template vb-slot="body" class="x"></template>
<template vb-slot="bodi"></template>
<ul><template vb-each="items" vb-as="label"><li>{{label}}</li></template></ul>`, c), [
    '1:5 vb-each needs vb-as naming each item, such as vb-as="item".',
    '2:1 vb-if="kind": "kind" is always present; vb-if takes a boolean or an optional parameter without a default.',
    '3:1 vb-each="label": "label" is text, not a list.',
    '4:1 vb-sloot isn’t a directive; did you mean vb-slot?',
    '4:1 A directive <template> takes exactly one of vb-if, vb-each, or vb-slot.',
    '5:1 A directive <template> takes no other attributes (class).',
    '6:1 The slot "bodi" isn’t declared in component.json; did you mean "body"?',
    '7:5 vb-as="label" hides a parameter or an outer item of the same name; pick another name.',
  ]);
  assert.deepEqual(problems('<ul><template vb-each="items" vb-as="item"><template vb-slot="body"></template><li>{{item}}</li></template></ul><template vb-slot="body">x</template>',
    contract({ items: { type: 'list', items: 'text' } }, { slots: { body: {} } })), [
    '1:44 The slot "body" is inside vb-each, so its children would repeat; move it out.',
    '1:113 The slot "body" appears twice; a slot has one place.',
    '1:113 <template vb-slot="body"> must be empty; the plan supplies its children.',
  ]);
});

test('IDs and headings: components use @ symbols and vb-rank', () => {
  const c = contract({ items: { type: 'list', items: 'text' } });
  assert.deepEqual(problems(`<section id="intro"><h2>Title</h2><p vb-rank>x</p><h3 vb-rank="2">y</h3>
<label for="email">E</label><input id="@field" aria-describedby="@hint" /><input id="@field" />
<ul><template vb-each="items" vb-as="item"><li id="@row">{{item}}</li></template></ul></section>`, c), [
    '1:10 id="intro" is fixed, so a second instance would repeat it; write an @ symbol, such as id="@intro".',
    '1:21 A literal <h2> fixes its level; write <h2 vb-rank> so the level comes from where the component sits.',
    '1:35 vb-rank goes on a heading, h1 to h6.',
    '1:51 vb-rank="2" must be empty or +1 to +5.',
    '2:8 for="email" refers to fixed IDs; refer to @ symbols, or bind a ref parameter.',
    '2:48 @hint isn’t defined: give an element id="@hint".',
    '2:82 id="@field" is defined twice.',
    '3:48 id="@row" is inside vb-each, so it would repeat; give each item its own component, or drop the id.',
  ]);
});

test('sinks: each type binds only where it fits', () => {
  const c = contract({
    label: { type: 'text' }, href: { type: 'url' }, open: { type: 'boolean', default: false }, kind: { type: 'enum', values: ['text', 'emial'], default: 'text' },
    width: { type: 'integer' }, when: { type: 'datetime' }, lang: { type: 'lang' }, target: { type: 'ref' }, note: { type: 'inline' }, body: { type: 'prose' },
    items: { type: 'list', items: 'text' }, state: { type: 'enum', values: ['true', 'false'] },
  });
  assert.deepEqual(problems(`<a href="{{label}}" title="{{href}}" aria-expanded="{{open}}">{{note}}</a>
<input name="q" type="{{kind}}" title="{{width}}" />
<p data-when="{{when}}" lang="{{lang}}" aria-controls="{{target}}" aria-pressed="{{state}}">{{body}} {{items}}</p>
<span title="{{note}}" class="{{items}}">x</span><select name="s"><option>{{note}}</option></select>
<a href="/x/{{label}}" class="card {{label}}">y</a><button type="button" onclick="{{label}}" style="{{label}}">z</button>
<img src="{{href}}" srcset="{{href}}" alt="" /><p id="{{label}}">w</p>`, c), [
    '1:4 href="{{label}}": href isn’t a text attribute; text binds alt, title, aria-label, placeholder, name, value, content, label, and data-* attributes.',
    '1:21 title="{{href}}": title doesn’t take a URL.',
    '1:38 aria-expanded="{{open}}": aria-expanded isn’t a boolean attribute; for ARIA states, use an enum of "true" and "false".',
    '2:17 type="{{kind}}": "emial" isn’t a valid value for type on <input>.',
    '2:33 title="{{width}}": title isn’t a numeric attribute.',
    '3:4 data-when="{{when}}": a datetime binds <time datetime>, <ins datetime>, or <del datetime>.',
    '3:93 {{body}}: a prose parameter must be the only content of a flow container, such as <section> or <li>.',
    '3:102 {{items}}: text positions take text, inline, or prose parameters, not list.',
    '4:7 title="{{note}}": a inline parameter is markup and goes in text positions, not attributes.',
    '4:24 class="{{items}}": a list goes in vb-each.',
    '4:75 {{note}}: an inline parameter can’t go in <option>, which takes only text.',
    '5:4 href: only text attributes and class take text around a binding; bind the whole value.',
    '5:24 class: a binding inside a longer value must be enum, not text.',
    '5:74 onclick can’t take a binding.',
    '5:94 style can’t take a binding.',
    '6:21 srcset can’t take a binding.',
    '6:51 An id is an @ symbol, such as id="@input", not a binding.',
  ]);
});

test('markup problems: parse errors, unknown names, and bindings where none may go', () => {
  assert.deepEqual(problems(`<labl>x</labl><p colour="red">y</p>
<!-- {{label}} --><script>let x = "{{label}}";</script>
<p>{{label</p><p {{label}}="x">z</p>`, contract({ label: { type: 'text' } })), [
    '1:1 <labl> isn’t an HTML element or one of the configured vocabulary’s; did you mean <label>?',
    '1:1 "label" is declared but never used; use it, or remove it from component.json',
    '1:18 colour isn’t an attribute of <p>.',
    '2:1 No bindings in comments; comments aren’t written to the output.',
    '2:27 No bindings in <script>.',
    '3:4 "{{" isn’t closed with "}}"; write &#123;&#123; for literal braces.',
    '3:18 No bindings in attribute names.',
  ]);
  assert.deepEqual(problems('<template vb-slot="body" />\n<p>After</p>', contract({}, { slots: { body: {} } })), [
    '1:1 "/>" doesn’t close a non-void element, so it swallows what follows; write the end tag, such as <template vb-slot="…"></template>.',
    '1:1 <template vb-slot="body"> must be empty; the plan supplies its children.',
  ]);
});
