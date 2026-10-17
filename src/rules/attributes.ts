import { isElement, isHtml, type Element } from '../parse/tree.ts';
import {
  attributeRow, HTML, inputTypesFor, isBooleanRow, isEventHandler, obsoleteAttribute, type AttributeRow,
} from '../spec/data.ts';
import { NS } from '../spec/html.ts';
import { attr, has, inputType, kindOf, tokens } from '../spec/model.ts';
import { isJavaScriptMimeType, usesWidthDescriptors, valueProblem } from '../spec/values.ts';
import { closest, tags, words } from '../text.ts';
import type { RawFinding, RuleContext } from './types.ts';
import { locatedElements, readAttribute, startTagSpan } from './util.ts';

/** Source-cased names from JSX and similar templates, and what HTML calls them. */
const JSX: Record<string, string> = {
  classname: 'class',
  htmlfor: 'for',
  httpequiv: 'http-equiv',
  acceptcharset: 'accept-charset',
  defaultvalue: 'value',
  defaultchecked: 'checked',
};

// RDFa Lite 1.1, which Open Graph <meta property> tags use; the Nu checker accepts it too.
const RDFA_LITE = new Set(['vocab', 'typeof', 'property', 'resource', 'prefix']);

const HYPERLINK_ONLY = ['target', 'download', 'ping', 'rel', 'hreflang', 'type', 'referrerpolicy'];
const SOURCE_IN_MEDIA = ['src'];
const SOURCE_IN_PICTURE = ['srcset', 'sizes', 'width', 'height'];

const quote = (value: string) => `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;

/**
 * content/unknown-attribute, content/obsolete (attributes),
 * content/attribute-value, and content/missing-attribute on HTML elements.
 * Custom elements are left to the vocabulary; foreign content isn't modeled.
 */
export function checkAttributes(ctx: RuleContext): RawFinding[] {
  const out: RawFinding[] = [];
  for (const element of locatedElements(ctx)) {
    if (kindOf(element) !== 'html') continue;
    const locs = element.sourceCodeLocation?.attrs ?? {};
    for (const a of element.attrs) {
      if (a.namespace) continue;
      const loc = locs[a.name];
      if (!loc) continue;
      const raw = readAttribute(ctx.text, loc.startOffset);
      const span = { offset: loc.startOffset, endOffset: raw.endOffset };
      const finding = attributeFinding(element, a.name, a.value, raw.name);
      if (finding) out.push({ ...span, ...finding, evidence: { attribute: a.name, ...(finding.evidence ?? {}) } });
    }
    for (const message of missing(element)) {
      out.push({ rule: 'content/missing-attribute', ...startTagSpan(element), message, evidence: { element: element.tagName } });
    }
  }
  return out;
}

type AttributeFinding = Pick<RawFinding, 'rule' | 'message' | 'severity' | 'evidence' | 'defect'>;

/**
 * HTML's "obsolete but conforming" features: vestigial markup that has no
 * effect, which conformance checkers must warn about rather than reject.
 */
function obsoleteButConforming(element: Element, name: string, value: string): string | null {
  const tag = element.tagName;
  const v = value.toLowerCase();
  const type = attr(element, 'type')?.toLowerCase();
  const vestigial = (what: string) => `${what} is obsolete and does nothing; remove it.`;
  if (tag === 'img' && name === 'border' && value === '0') return vestigial('border="0" on <img>');
  if (tag === 'script' && name === 'charset' && v === 'utf-8') return vestigial('charset="utf-8" on <script>');
  if (tag === 'script' && name === 'language' && v === 'javascript' && (type === undefined || type === 'text/javascript')) return vestigial(`language="${value}" on <script>`);
  if (tag === 'script' && name === 'type' && isJavaScriptMimeType(v)) return vestigial(`type="${value}" on <script>`);
  if (tag === 'style' && name === 'type' && v === 'text/css') return vestigial('type="text/css" on <style>');
  if (tag === 'a' && name === 'name' && value !== '') return `name on <a> is obsolete; use id="${value}" on the element it marks instead.`;
  if (tag === 'input' && (name === 'maxlength' || name === 'size') && inputType(element) === 'number') return vestigial(`${name} on <input type="number">`);
  return null;
}

function attributeFinding(element: Element, name: string, value: string, sourceName: string): AttributeFinding | null {
  const tag = element.tagName;
  const warning = obsoleteButConforming(element, name, value);
  if (warning) return { rule: 'content/obsolete', severity: 'warning', message: warning };
  const advice = obsoleteAttribute(tag, name);
  if (advice !== null) return { rule: 'content/obsolete', message: `${name} on <${tag}> is obsolete. ${advice}` };

  if (name.startsWith('data-')) {
    return name.length > 5 && !name.includes(':') ? null : { rule: 'content/unknown-attribute', message: `${name} isn’t a valid data attribute: write data- followed by a name without colons, such as data-id.` };
  }
  if (name.startsWith('aria-') || name === 'role' || RDFA_LITE.has(name) || isEventHandler(tag, name)) return null;
  if (name === 'xmlns') {
    return value === NS.html ? null : { rule: 'content/attribute-value', message: `xmlns on an HTML element must be exactly "${NS.html}", or omitted.` };
  }
  if (name === 'xml:lang') {
    const lang = attr(element, 'lang');
    if (lang === null) return { rule: 'content/missing-attribute', message: 'xml:lang needs a lang attribute with the same value; or remove xml:lang, which does nothing in HTML.' };
    return lang.toLowerCase() === value.toLowerCase() ? null : { rule: 'content/attribute-value', message: `xml:lang="${value}" must match lang="${lang}".` };
  }

  const row = attributeRow(tag, name);
  if (!row) return unknown(element, name, sourceName);
  const inapplicable = applies(element, name);
  if (inapplicable) return { rule: 'content/unknown-attribute', message: inapplicable };
  if (isBooleanRow(row)) return null; // checkBooleanValues
  return valueFinding(element, name, value, row);
}

function unknown(element: Element, name: string, sourceName: string): AttributeFinding {
  const tag = element.tagName;
  const lower = sourceName.toLowerCase();
  let hint = '';
  if (JSX[lower]) hint = ` In HTML, ${sourceName} is written ${JSX[lower]}.`;
  else if (/^[:@#*[(]|^v-|^x-|^ng-|^dangerouslysetinnerhtml$/i.test(sourceName)) hint = ' It looks like template syntax; check the rendered HTML instead.';
  else if (ALL_NAMES.includes(name)) {
    const on = [...new Set(HTML.attributes.filter((r) => r.name === name).flatMap((r) => r.elements))].filter((e) => e !== '*');
    hint = on.length <= 6 ? ` It applies to ${tags(on, 'and')}.` : ' It applies only to other elements.';
  } else {
    const near = closest(name, allowedNames(element));
    const elsewhere = near ? null : closest(name, ALL_NAMES);
    if (near) hint = ` Did you mean ${near}?`;
    else if (elsewhere) hint = ` Did you mean ${elsewhere}? It doesn’t apply to <${tag}> either.`;
    else hint = ` For custom data, use data-${name}.`;
  }
  return { rule: 'content/unknown-attribute', message: `${sourceName} isn’t an attribute of <${tag}>.${hint}` };
}

const GLOBAL_NAMES = HTML.attributes.filter((r) => r.elements.includes('*')).map((r) => r.name);
const ALL_NAMES = [...new Set(HTML.attributes.map((r) => r.name))];

function allowedNames(element: Element): string[] {
  const own = HTML.attributes.filter((r) => r.elements.includes(element.tagName)).map((r) => r.name);
  return [...new Set([...GLOBAL_NAMES, ...own, ...(HTML.elements[element.tagName]?.attributes ?? [])])];
}

/** Why an attribute the element accepts doesn't apply here, or null. */
function applies(element: Element, name: string): string | null {
  const tag = element.tagName;
  if (tag === 'input') {
    const type = inputType(element);
    const types = name === 'value' ? HTML.inputTypes.map((t) => t.keyword).filter((t) => t !== 'file' && t !== 'image') : inputTypesFor(name);
    if (types && !types.includes(type)) {
      const list = types.length <= 8 ? `; it applies to ${words(types.map((t) => `type="${t}"`))}` : '';
      return `${name} doesn’t apply to <input type="${type}">${list}.`;
    }
  }
  if ((tag === 'a' || tag === 'area') && HYPERLINK_ONLY.includes(name) && !has(element, 'href')) {
    return `${name} doesn’t apply to <${tag}> without href.`;
  }
  if (tag === 'source') {
    const parent = element.parentNode && isElement(element.parentNode) && isHtml(element.parentNode) ? element.parentNode.tagName : null;
    if (SOURCE_IN_MEDIA.includes(name) && parent === 'picture') return `${name} doesn’t apply to <source> in <picture>; use srcset.`;
    if (SOURCE_IN_PICTURE.includes(name) && (parent === 'audio' || parent === 'video')) return `${name} doesn’t apply to <source> in <${parent}>.`;
  }
  if (tag === 'meta' && name === 'content' && !['name', 'http-equiv', 'itemprop', 'property'].some((n) => has(element, n))) {
    return 'content doesn’t apply to <meta> without name, http-equiv, or itemprop.';
  }
  if (tag === 'link' && name === 'itemprop' && has(element, 'rel')) return 'itemprop and rel can’t both be on <link>; use one.';
  return null;
}

function valueFinding(element: Element, name: string, value: string, row: AttributeRow): AttributeFinding | null {
  const tag = element.tagName;
  // Prose requirements beyond the value type.
  if (name === 'name' && ['button', 'fieldset', 'input', 'output', 'select', 'textarea', 'form'].includes(tag)) {
    if (value === '') return { rule: 'content/attribute-value', message: `name on <${tag}> must not be empty.` };
    if (value.toLowerCase() === 'isindex' && tag !== 'form') return { rule: 'content/attribute-value', message: 'name="isindex" isn’t allowed.' };
  }
  if (tag === 'map' && name === 'name') {
    if (value === '' || /[\t\n\f\r ]/.test(value)) return { rule: 'content/attribute-value', message: 'A <map> name must be non-empty and contain no whitespace.' };
    const id = attr(element, 'id');
    if (id !== null && id !== value) return { rule: 'content/attribute-value', message: `<map name="${value}"> must match its id ("${id}").` };
  }
  if ((tag === 'input' || tag === 'textarea') && name === 'placeholder' && /[\n\r]/.test(value)) {
    return { rule: 'content/attribute-value', message: 'placeholder must not contain line breaks.' };
  }
  const problem = valueProblem(element, name, value, row);
  if (!problem) return null;
  return {
    rule: 'content/attribute-value',
    message: `${name}=${quote(value)} ${problem.text}${/[.?!]$/.test(problem.text) ? '' : '.'}`,
    ...(problem.severity ? { severity: problem.severity } : {}),
    ...(name === 'lang' ? { defect: 'lang-value' } : {}),
    evidence: { value },
  };
}

/** Required attributes that are absent. */
function missing(element: Element): string[] {
  const out: string[] = [];
  const tag = element.tagName;
  const need = (name: string, why = '') => {
    if (!has(element, name)) out.push(`<${tag}> needs ${name}${why}.`);
  };
  const parent = element.parentNode && isElement(element.parentNode) && isHtml(element.parentNode) ? element.parentNode.tagName : null;
  switch (tag) {
    case 'img':
      if (!has(element, 'src') && !has(element, 'srcset')) out.push('<img> needs src (or srcset).');
      if (usesWidthDescriptors(attr(element, 'srcset') ?? '')) need('sizes', ', because its srcset uses width descriptors');
      break;
    case 'source':
      if (parent === 'picture') {
        need('srcset', ' in <picture>');
        // Unless the <img> after it sizes itself: loading="lazy" with sizes="auto…".
        const siblings = element.parentNode!.childNodes;
        const img = siblings.slice(siblings.indexOf(element) + 1).find((c): c is Element => isElement(c) && c.tagName === 'img');
        const autoSized = img && attr(img, 'loading')?.toLowerCase() === 'lazy' && /^auto(?:,|$)/i.test((attr(img, 'sizes') ?? '').trim());
        if (usesWidthDescriptors(attr(element, 'srcset') ?? '') && !autoSized) need('sizes', ', because its srcset uses width descriptors');
      } else if (parent === 'audio' || parent === 'video') need('src', ` in <${parent}>`);
      break;
    case 'link': {
      if (!has(element, 'href') && !has(element, 'imagesrcset')) out.push('<link> needs href (or imagesrcset).');
      if (!has(element, 'rel') && !has(element, 'itemprop')) out.push('<link> needs rel (or itemprop).');
      const rel = tokens(attr(element, 'rel')?.toLowerCase() ?? null);
      if (rel.includes('preload')) need('as', ' with rel="preload"');
      if (rel.includes('stylesheet') && rel.includes('alternate') && !attr(element, 'title')) out.push('<link rel="alternate stylesheet"> needs a non-empty title.');
      break;
    }
    case 'meta': {
      const kinds = ['name', 'http-equiv', 'charset', 'itemprop'].filter((n) => has(element, n));
      if (kinds.length === 0 && has(element, 'property')) {
        need('content');
        break;
      }
      if (kinds.length === 0) out.push('<meta> needs one of name, http-equiv, charset, or itemprop.');
      else if (kinds.length > 1) out.push(`<meta> can have only one of name, http-equiv, charset, and itemprop; it has ${words(kinds, 'and')}.`);
      if (kinds.some((k) => k !== 'charset')) need('content');
      break;
    }
    case 'a':
    case 'area':
      if (has(element, 'itemprop')) need('href', ' when it has itemprop');
      if (tag === 'area') {
        const shape = (attr(element, 'shape') ?? 'rect').toLowerCase();
        if (shape !== 'default') need('coords', ` for shape="${shape}"`);
      }
      break;
    case 'base':
      if (!has(element, 'href') && !has(element, 'target')) out.push('<base> needs href, target, or both.');
      break;
    case 'bdo':
      need('dir', ' ("ltr" or "rtl")');
      break;
    case 'data':
    case 'meter':
      need('value');
      break;
    case 'input':
      if (inputType(element) === 'image') need('src', ' for type="image"');
      break;
    case 'map':
      need('name');
      break;
    case 'object':
      need('data');
      break;
    case 'optgroup':
      if (!element.childNodes.some((c) => isElement(c) && isHtml(c) && c.tagName === 'legend')) need('label', ' (or a <legend> child)');
      break;
    case 'textarea':
      if (attr(element, 'wrap')?.toLowerCase() === 'hard') need('cols', ' with wrap="hard"');
      break;
    case 'track': {
      need('src');
      // A missing kind means subtitles; an invalid one means metadata.
      if ((attr(element, 'kind')?.toLowerCase() ?? 'subtitles') === 'subtitles') need('srclang', ' for subtitles');
      break;
    }
  }
  return out;
}

/**
 * content/attribute-value for boolean attributes. Presence means on, so any
 * value is on. HTML allows only "" or the attribute's name; the house form
 * "true" is reported at info, and "false", which still means on, is always an
 * error.
 */
export function checkBooleanValues(ctx: RuleContext): RawFinding[] {
  const out: RawFinding[] = [];
  const form = ctx.options.booleanValue;
  for (const element of locatedElements(ctx)) {
    if (kindOf(element) !== 'html') continue;
    const locs = element.sourceCodeLocation?.attrs ?? {};
    for (const a of element.attrs) {
      if (!isBooleanRow(attributeRow(element.tagName, a.name))) continue;
      const value = a.value;
      if (value === '' || value.toLowerCase() === a.name) continue;
      const loc = locs[a.name];
      if (!loc) continue;
      const span = { offset: loc.startOffset, endOffset: readAttribute(ctx.text, loc.startOffset).endOffset };
      const house = form === 'true' ? `${a.name}="true"` : form === 'name' ? `${a.name}="${a.name}"` : `${a.name}=""`;
      if (value === 'true') {
        out.push(form === 'true'
          ? {
              rule: 'content/attribute-value',
              ...span,
              severity: 'info',
              message: `${a.name}="true" follows the house style; no change needed. (HTML itself allows only ${a.name}="" or ${a.name}="${a.name}"; browsers treat any value as on.)`,
              evidence: { attribute: a.name, value },
            }
          : {
              rule: 'content/attribute-value',
              ...span,
              message: `${a.name}="true" isn’t valid HTML: a boolean attribute’s value must be empty or "${a.name}". Write ${house}.`,
              evidence: { attribute: a.name, value },
            });
        continue;
      }
      out.push({
        rule: 'content/attribute-value',
        ...span,
        message: value.toLowerCase() === 'false'
          ? `${a.name}="false" still turns ${a.name} on: a boolean attribute is on whenever it’s present. Remove the attribute to turn it off.`
          : `"${value}" isn’t a value for ${a.name}: the attribute is on whenever it’s present. Write ${house}, or remove it to turn it off.`,
        evidence: { attribute: a.name, value },
      });
    }
  }
  return out;
}
