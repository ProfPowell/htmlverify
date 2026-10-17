import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Mutation corpus (spec §12.3): one defect injected into a known-good page.
 * A mutation is one or more [find, replace] edits on the page, each applied to
 * the first occurrence.
 */

export const BASE = readFileSync(join(import.meta.dirname, 'fixtures', 'known-good', 'house-page.html'), 'utf8');
export const INSERT = '<p>We reply within';
const at = (html: string): [string, string] => [INSERT, `${html}${INSERT}`];

export const MUTATIONS: [rule: string, ...edits: [string, string][]][] = [
  ['syntax/parse-error', ['<p>We reply within', '<p>We reply &bogus; within']],
  ['syntax/duplicate-attribute', ['<table>', '<table class="a" class="b">']],
  ['syntax/self-closing-non-void', at('<div class="x" />')],
  ['syntax/unclosed-element', ['<summary>Office hours</summary>', '<summary>Office hours']],
  ['syntax/stray-end-tag', ['</form>', '</form></span>']],
  ['syntax/misplaced-start-tag', ['<caption>Hours</caption>', '<caption>Hours</caption><td>x</td>']],
  ['syntax/misnested', ['<strong>one business day</strong>', '<strong><em>one business day</strong></em>']],
  ['syntax/misnested', ['<strong>one business day</strong>', '<strong><em>one business</strong> day</em>']],
  ['syntax/reordered', ['<tbody>', '<tbody><p>Lost</p>']],
  ['syntax/doctype', ['<!doctype html>\n', '']],
  ['syntax/encoding', ['<meta charset="utf-8" />', '']],
  ['style/attr-quotes', ['action="/contact"', 'action=/contact']],
  ['style/boolean-attr', ['required="true"', 'required']],
  ['style/lowercase', ['<summary>Office hours</summary>', '<SUMMARY>Office hours</SUMMARY>']],
  ['style/void-element', ['<br />', '<br>']],
  ['style/explicit-start-tag', ['<tbody>', ''], ['</tbody>', '']],
  ['style/explicit-end-tag', ['Home</a></li>', 'Home</a>']],
  ['style/doctype', ['<!doctype html>', '<!DOCTYPE html>']],
  ['style/escape', ['Usually sooner.', 'Usually sooner &amp; faster > slower.']],
  ['style/whitespace', ['<h1>Contact us</h1>', '<h1>Contact us</h1>   ']],
  ['content/unknown-element', at('<foo>x</foo>')],
  ['content/obsolete', ['<small>&copy; 2026 Acme</small>', '<font>&copy; 2026 Acme</font>']],
  ['content/unknown-attribute', ['name="email"', 'name="email" colour="red"']],
  ['content/attribute-value', ['type="email"', 'type="emial"']],
  ['content/attribute-value', ['required="true"', 'required="false"']],
  ['content/missing-attribute', at('<img alt="Team" />')],
  ['content/child', at('<span><div>Block</div></span>')],
  ['content/order', ['<summary>Office hours</summary>', ''], ['</table>', '</table><summary>Office hours</summary>']],
  ['content/descendant', ['<button type="submit">Send message</button>', '<button type="submit">Send <a href="/x">message</a></button>']],
  ['content/context', at('<li>Stray</li>')],
  ['content/duplicate-id', ['id="topic"', 'id="email"']],
  ['content/invalid-id', ['id="row"', 'id="my row"']],
  ['content/idref', ['aria-describedby="email-hint"', 'aria-describedby="email-hnt"']],
  ['content/document', ['</main>', '</main><main><p>Second</p></main>']],
  ['component/unknown-element', ['<icon-wc name="divider" aria-hidden="true"></icon-wc>', '<icon-cw name="divider" aria-hidden="true"></icon-cw>']],
  ['component/attribute', ['<icon-wc name="divider"', '<icon-wc sise="lg" name="divider"']],
  ['component/content', at('<accordion-wc><p>Not a panel</p></accordion-wc>')],
  ['component/output-attribute', at('<drop-down open="true"><button type="button" data-trigger="true">Menu</button><menu><li><a href="/a">A</a></li></menu></drop-down>')],
  ['a11y/lang', ['<html lang="en">', '<html>']],
  ['a11y/title', ['<title>Contact us · Acme</title>', '<title></title>']],
  ['a11y/img-alt', at('<img src="/team.jpg" />')],
  ['a11y/svg', at('<svg viewBox="0 0 1 1"><rect width="1" height="1" /></svg>')],
  ['a11y/name', ['<button type="submit">Send message</button>', '<button type="submit"></button>']],
  ['a11y/label', ['<label for="email">Email</label>', '']],
  ['a11y/aria-role', ['<nav aria-label="Main navigation">', '<nav aria-label="Main navigation" role="navigaton">']],
  ['a11y/aria-attr', ['aria-current="page"', 'aria-curent="page"']],
  ['a11y/aria-redundant', ['<nav aria-label="Main navigation">', '<nav aria-label="Main navigation" role="navigation">']],
  ['a11y/aria-hidden-focus', ['<button type="submit">', '<button type="submit" aria-hidden="true">']],
  ['a11y/tabindex', ['<button type="submit">', '<button type="submit" tabindex="2">']],
  ['a11y/headings', at('<h3>Skipped a level</h3>')],
  ['a11y/landmarks', ['<p><small>', '<nav><a href="/x">More</a></nav><p><small>']],
  ['a11y/landmarks', ['<main', '<header><p>Second banner</p></header><main']],
  ['a11y/link-text', ['Skip to content', 'click here']],
  ['a11y/form-group', ['<button type="submit">', '<label><input type="radio" name="when" value="am" /> Morning</label><label><input type="radio" name="when" value="pm" /> Evening</label><button type="submit">']],
  ['a11y/table', ['<th scope="col">Day</th><th scope="col">Open</th>', '<td>Day</td><td>Open</td>'], ['<thead>', ''], ['</thead>', '']],
  ['a11y/media', at('<video src="/tour.mp4" controls="true"></video>')],
  ['semantic/generic-control', at('<span role="button" tabindex="0">Go</span>')],
  ['semantic/link-href', ['href="#main"', 'href="#"']],
  ['semantic/native-alternative', at('<span role="progressbar" aria-valuenow="5" aria-label="Upload">5%</span>')],
  ['semantic/section-heading', at('<section><p>No heading</p></section>')],
  ['semantic/br-spacing', ['<br />Usually sooner.', '<br /><br />Usually sooner.']],
  ['semantic/empty-element', at('<p></p>')],
  ['semantic/fragment-link', ['href="#main"', 'href="#mian"']],
  ['semantic/placeholder-content', ['Usually sooner.', 'Lorem ipsum dolor sit amet.']],
  ['policy/no-div', at('<div><p>Wrapped</p></div>')],
  ['policy/single-h1', at('<h1>Second title</h1>')],
  ['policy/button-type', ['<button type="submit">', '<button>']],
  ['policy/inline-handler', ['<button type="submit">', '<button type="submit" onclick="go()">']],
  ['policy/javascript-url', ['href="/"', 'href="javascript:void(0)"']],
  ['policy/inline-style', [INSERT, '<p style="color: red">We reply within']],
  ['policy/inline-svg', at('<svg viewBox="0 0 1 1" aria-hidden="true"><rect width="1" height="1" /></svg>')],
  ['policy/prefer-strong-em', ['<strong>one business day</strong>', '<b>one business day</b>']],
  ['policy/head', ['<meta name="viewport" content="width=device-width, initial-scale=1" />', '']],
  ['policy/class', ['<table>', '<table class="">']],
  ['bloat/class-count', ['<table>', '<table class="a b c d e f g">']],
  ['bloat/depth', at(`${'<section aria-label="x">'.repeat(13)}deep${'</section>'.repeat(13)}`)],
  ['bloat/wrapper-chain', at('<p><span><span><span><span>Deep</span></span></span></span></p>')],
  ['bloat/size', at('<p>' + '<em>a</em>'.repeat(1500) + '</p>')],
];

/** Each mutation applied to the base page, or an error naming an edit that no longer applies. */
export function mutants(): { rule: string; edits: [string, string][]; html: string }[] {
  return MUTATIONS.map(([rule, ...edits]) => {
    let html = BASE;
    for (const [find, replace] of edits) {
      if (!html.includes(find)) throw new Error(`${rule}: "${find}" isn’t in the page`);
      html = html.replace(find, replace);
    }
    return { rule, edits, html };
  });
}
