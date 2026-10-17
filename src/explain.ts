import { PROFILES, type Profile, type ProfileName } from './profiles.ts';
import { RULE_DOCS, type RuleDoc } from './rules/docs.ts';
import { RULE_BY_ID, RULES } from './rules/registry.ts';
import type { RuleMeta, Severity } from './rules/types.ts';
import { closest } from './text.ts';

export interface RuleInfo extends RuleMeta, Omit<RuleDoc, 'context'> {
  /** Default severity in each built-in profile. */
  severities: Record<ProfileName, Severity | 'off'>;
}

/** Everything `htmlverify explain` prints about a rule; throws for an unknown ID. */
export function explain(rule: string): RuleInfo {
  const meta = RULE_BY_ID.get(rule);
  const doc = RULE_DOCS[rule];
  if (!meta || !doc) {
    const near = closest(rule, RULES.map((r) => r.id));
    throw new RangeError(`unknown rule "${rule}"${near ? `; did you mean "${near}"?` : ''}`);
  }
  const { context: _context, ...text } = doc;
  return {
    ...meta,
    ...text,
    severities: { strict: PROFILES.strict.severities[rule] ?? 'off', standard: PROFILES.standard.severities[rule] ?? 'off' },
  };
}

export function formatExplain(info: RuleInfo): string {
  const severity = info.severities.strict === info.severities.standard
    ? `${info.severities.strict} in strict and standard`
    : `${info.severities.strict} in strict, ${info.severities.standard} in standard`;
  const indent = (s: string) => s.split('\n').map((line) => `  ${line}`).join('\n');
  const options = Object.entries(info.options ?? {}).map(([name, o]) => `  ${name}, default ${JSON.stringify(o.default)}: ${o.summary}`);
  return [
    `${info.id} · ${info.authority} · ${severity}`,
    `${info.summary}.`,
    '',
    `Why: ${info.why}`,
    `Fix: ${info.fix}`,
    '',
    'Fails:',
    indent(info.fails),
    'Passes:',
    indent(info.passes),
    '',
    ...(options.length > 0 ? ['Options, set as ["warning", { … }] in the config:', ...options, ''] : []),
    `Reference: ${info.ref}`,
    '',
  ].join('\n');
}

export interface RuleRow {
  id: string;
  authority: RuleMeta['authority'];
  severity: Severity | 'off';
  summary: string;
}

/** The implemented rules with their severity in a profile. */
export function listRules(profile: Profile): RuleRow[] {
  return RULES.map((r) => ({ id: r.id, authority: r.authority, severity: profile.severities[r.id] ?? 'off', summary: r.summary }));
}

export function formatRules(rows: RuleRow[], profile: Profile): string {
  const idWidth = Math.max(...rows.map((r) => r.id.length));
  const lines = rows.map((r) => `${r.id.padEnd(idWidth)}  ${r.authority.padEnd(10)}  ${r.severity.padEnd(7)}  ${r.summary}`);
  const on = rows.filter((r) => r.severity !== 'off').length;
  return `${lines.join('\n')}\n${rows.length} rules · ${on} on in ${profile.name}${profile.untested.length ? ` · not implemented yet: ${profile.untested.map((u) => u.check).join(', ')}` : ''}\n`;
}
