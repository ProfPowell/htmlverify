// htmlverify.config.json (spec §10.2): validated, then merged over a built-in
// profile. Validation is strict: unknown keys, rules, and severities are errors.

import { isProfileName, PROFILES, type Profile, type ProfileName } from './profiles.ts';
import { RULE_BY_ID } from './rules/registry.ts';
import type { Options, RuleOptionValue, Severity } from './rules/types.ts';

export const CONFIG_FILE = 'htmlverify.config.json';

export interface Config {
  extends?: ProfileName;
  options?: Partial<Options>;
  rules?: Record<string, Severity | 'off'>;
  ruleOptions?: Record<string, Record<string, RuleOptionValue>>;
  maxWarnings?: number | null;
}

export class ConfigError extends Error {}

const SEVERITIES = new Set(['error', 'warning', 'info', 'off']);
const OPTION_VALUES: Record<keyof Options, readonly (string | null)[]> = {
  voidElements: ['xhtml', 'tight', 'html'],
  booleanValue: ['true', 'empty', 'name', null],
  linkTextLanguage: ['en'],
};
/** Keys the spec defines that later milestones implement. */
const LATER: Record<string, string> = {
  vocabularies: 'M1d',
  registry: 'M2',
  nu: 'M1e',
  'options.adHocPrefix': 'M1d',
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates parsed JSON as a config; `source` names it in errors. */
export function parseConfig(raw: unknown, source: string): Config {
  const fail = (message: string): never => {
    throw new ConfigError(`${source}: ${message}`);
  };
  if (!isObject(raw)) return fail('the config must be a JSON object');
  const config: Config = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === '$schema') continue;
    if (LATER[key]) fail(`"${key}" isn’t supported yet (${LATER[key]})`);
    switch (key) {
      case 'extends':
        if (typeof value !== 'string' || !isProfileName(value)) fail(`"extends" must be "strict" or "standard"`);
        config.extends = value as ProfileName;
        break;
      case 'options': {
        if (!isObject(value)) return fail('"options" must be an object');
        const options: Partial<Options> = {};
        for (const [name, v] of Object.entries(value)) {
          if (LATER[`options.${name}`]) fail(`"options.${name}" isn’t supported yet (${LATER[`options.${name}`]})`);
          const allowed = OPTION_VALUES[name as keyof Options];
          if (!allowed) fail(`unknown option "${name}"`);
          if (!allowed!.includes(v as string | null)) fail(`"options.${name}" must be ${allowed!.map((a) => JSON.stringify(a)).join(', ')}`);
          (options as Record<string, unknown>)[name] = v;
        }
        config.options = options;
        break;
      }
      case 'rules': {
        if (!isObject(value)) return fail('"rules" must be an object');
        const rules: Record<string, Severity | 'off'> = {};
        const ruleOptions: Record<string, Record<string, RuleOptionValue>> = {};
        for (const [id, v] of Object.entries(value)) {
          const meta = RULE_BY_ID.get(id);
          if (!meta) return fail(`unknown rule "${id}"`);
          const [severity, options] = Array.isArray(v) ? v : [v, undefined];
          if (Array.isArray(v) && (v.length !== 2 || !isObject(options))) fail(`"${id}" must be a severity, or [severity, { options }]`);
          if (typeof severity !== 'string' || !SEVERITIES.has(severity)) fail(`"${id}" must be "error", "warning", "info", or "off"`);
          rules[id] = severity as Severity | 'off';
          if (options === undefined) continue;
          if (!meta.options) fail(`"${id}" takes no options; give a severity`);
          for (const [name, option] of Object.entries(options as Record<string, unknown>)) {
            const spec = meta.options![name];
            if (!spec) fail(`"${id}" has no option "${name}"; it has ${Object.keys(meta.options!).map((o) => `"${o}"`).join(', ')}`);
            const min = spec!.min ?? 0;
            const ok = spec!.type === 'number'
              ? typeof option === 'number' && Number.isFinite(option) && option >= min && (!spec!.integer || Number.isInteger(option))
              : Array.isArray(option) && option.every((x) => typeof x === 'string');
            const want = spec!.type === 'strings' ? 'an array of strings'
              : spec!.integer ? (min === 0 ? 'a non-negative integer' : `an integer of at least ${min}`) : 'a non-negative number';
            if (!ok) fail(`"${id}" option "${name}" must be ${want}`);
            (ruleOptions[id] ??= {})[name] = option as RuleOptionValue;
          }
        }
        config.rules = rules;
        config.ruleOptions = ruleOptions;
        break;
      }
      case 'maxWarnings':
        if (value !== null && !(Number.isInteger(value) && (value as number) >= 0)) fail('"maxWarnings" must be a non-negative integer or null');
        config.maxWarnings = value as number | null;
        break;
      default:
        fail(`unknown key "${key}"`);
    }
  }
  return config;
}

/** The built-in profile with the config's options, rule severities, and warning limit applied. */
export function resolveProfile(name: ProfileName | undefined, config: Config | null): Profile {
  const base = PROFILES[name ?? config?.extends ?? 'strict'];
  if (!config) return base;
  return {
    ...base,
    severities: { ...base.severities, ...config.rules },
    options: { ...base.options, ...config.options },
    maxWarnings: config.maxWarnings === undefined ? base.maxWarnings : config.maxWarnings,
    ruleOptions: { ...base.ruleOptions, ...config.ruleOptions },
  };
}
