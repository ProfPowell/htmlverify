import { isBooleanAttribute } from '../spec/html.ts';
import { isHtml } from '../parse/tree.ts';
import type { RawFinding, RuleContext } from './types.ts';
import { locatedElements, readAttribute } from './util.ts';

/**
 * content/attribute-value, boolean attributes only (the rest lands in M1).
 * Presence means on, so any value is on. HTML allows only "" or the
 * attribute's name; the house form "true" is reported at info, and "false",
 * which still means on, is always an error.
 */
export function checkBooleanValues(ctx: RuleContext): RawFinding[] {
  const out: RawFinding[] = [];
  const form = ctx.options.booleanValue;
  for (const element of locatedElements(ctx)) {
    if (!isHtml(element)) continue;
    const locs = element.sourceCodeLocation?.attrs ?? {};
    for (const attr of element.attrs) {
      if (!isBooleanAttribute(element.tagName, attr.name)) continue;
      const value = attr.value;
      if (value === '' || value.toLowerCase() === attr.name) continue;
      const loc = locs[attr.name];
      if (!loc) continue;
      const span = { offset: loc.startOffset, endOffset: readAttribute(ctx.text, loc.startOffset).endOffset };
      const house = form === 'true' ? `${attr.name}="true"` : form === 'name' ? `${attr.name}="${attr.name}"` : `${attr.name}=""`;
      if (value === 'true') {
        out.push(form === 'true'
          ? {
              rule: 'content/attribute-value',
              ...span,
              severity: 'info',
              message: `${attr.name}="true" follows the house style; no change needed. (HTML itself allows only ${attr.name}="" or ${attr.name}="${attr.name}"; browsers treat any value as on.)`,
              evidence: { attribute: attr.name, value },
            }
          : {
              rule: 'content/attribute-value',
              ...span,
              message: `${attr.name}="true" isn’t valid HTML: a boolean attribute’s value must be empty or "${attr.name}". Write ${house}.`,
              evidence: { attribute: attr.name, value },
            });
        continue;
      }
      out.push({
        rule: 'content/attribute-value',
        ...span,
        message: value.toLowerCase() === 'false'
          ? `${attr.name}="false" still turns ${attr.name} on: a boolean attribute is on whenever it’s present. Remove the attribute to turn it off.`
          : `"${value}" isn’t a value for ${attr.name}: the attribute is on whenever it’s present. Write ${house}, or remove it to turn it off.`,
        evidence: { attribute: attr.name, value },
      });
    }
  }
  return out;
}
