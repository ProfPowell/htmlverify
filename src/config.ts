// htmlverify.config.json (spec §10.2): validated, then merged over a built-in
// profile. Validation is strict: unknown keys, rules, and severities are errors.

import { isProfileName, PROFILES, type Profile, type ProfileName } from './profiles.ts';
import { RULE_BY_ID } from './rules/registry.ts';
import type { Options, Severity } from './rules/types.ts';

export const CONFIG_FILE = 'htmlverify.config.json';

export interface Config {
  extends?: ProfileName;
  options?: Partial<Options>;
  rules?: Record<string, Severity | 'off'>;
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
        for (const [id, v] of Object.entries(value)) {
          if (!RULE_BY_ID.has(id)) fail(`unknown rule "${id}"`);
          if (Array.isArray(v)) fail(`"${id}" takes no options; give a severity`);
          if (typeof v !== 'string' || !SEVERITIES.has(v)) fail(`"${id}" must be "error", "warning", "info", or "off"`);
          rules[id] = v as Severity | 'off';
        }
        config.rules = rules;
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
  };
}
