// htmlverify.config.json (spec §10.2): validated, then merged over a built-in
// profile. Validation is strict: unknown keys, rules, and severities are errors.

import { isProfileName, PROFILES, type Profile, type ProfileName } from './profiles.ts';
import { RULE_BY_ID } from './rules/registry.ts';
import type { Options, RuleOptionValue, Severity } from './rules/types.ts';
import type { VocabElement } from './vocab/types.ts';
import { bundledVocabularies } from './vocab/vocabulary.ts';

export const CONFIG_FILE = 'htmlverify.config.json';

export interface Config {
  extends?: ProfileName;
  /** Vocabulary snapshots, as name@version (spec §7.4). */
  vocabularies?: string[];
  /** The registry directory as written, relative to the config file; its elements.json is read in M1d, components in M2. */
  registry?: string;
  /** The registry's elements.json, parsed; the loader fills it in. */
  elements?: Record<string, VocabElement>;
  /** The Nu Html Checker for --nu: the jar, relative to the config file, and optionally java. */
  nu?: { jar: string; java?: string };
  options?: Partial<Options>;
  rules?: Record<string, Severity | 'off'>;
  ruleOptions?: Record<string, Record<string, RuleOptionValue>>;
  maxWarnings?: number | null;
}

export class ConfigError extends Error {}

const SEVERITIES = new Set(['error', 'warning', 'info', 'off']);
const OPTION_VALUES: Record<Exclude<keyof Options, 'adHocPrefix'>, readonly (string | null)[]> = {
  voidElements: ['xhtml', 'tight', 'html'],
  booleanValue: ['true', 'empty', 'name', null],
  linkTextLanguage: ['en'],
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
    switch (key) {
      case 'extends':
        if (typeof value !== 'string' || !isProfileName(value)) fail(`"extends" must be "strict" or "standard"`);
        config.extends = value as ProfileName;
        break;
      case 'options': {
        if (!isObject(value)) return fail('"options" must be an object');
        const options: Partial<Options> = {};
        for (const [name, v] of Object.entries(value)) {
          if (name === 'adHocPrefix') {
            if (v !== null && !(typeof v === 'string' && /^[a-z][a-z0-9]*-$/.test(v))) fail('"options.adHocPrefix" must be a prefix such as "x-", or null');
            options.adHocPrefix = v as string | null;
            continue;
          }
          const allowed = OPTION_VALUES[name as keyof typeof OPTION_VALUES];
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
      case 'vocabularies': {
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return fail('"vocabularies" must be an array of snapshot names such as "vanilla-breeze@0.3.1"');
        const available = bundledVocabularies();
        for (const id of value as string[]) {
          if (!available.includes(id)) fail(`no vocabulary snapshot "${id}"; available: ${available.map((a) => `"${a}"`).join(', ') || 'none'}`);
        }
        const names = (value as string[]).map((id) => id.split('@')[0]);
        const twice = names.find((n, i) => names.indexOf(n) !== i);
        if (twice) fail(`"vocabularies" lists ${twice} twice; pick one version`);
        config.vocabularies = value as string[];
        break;
      }
      case 'nu': {
        if (!isObject(value) || typeof value['jar'] !== 'string' || (value['java'] !== undefined && typeof value['java'] !== 'string')) {
          return fail('"nu" must be { "jar": "path/to/vnu.jar" }, with an optional "java" executable');
        }
        for (const k of Object.keys(value)) if (k !== 'jar' && k !== 'java') fail(`unknown key "nu.${k}"`);
        config.nu = { jar: value['jar'] as string, ...(typeof value['java'] === 'string' ? { java: value['java'] } : {}) };
        break;
      }
      case 'registry':
        if (typeof value !== 'string' || value.trim() === '') fail('"registry" must be a directory path');
        config.registry = value as string;
        break;
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
    vocabularies: config.vocabularies ?? base.vocabularies,
    elements: config.elements ?? base.elements,
  };
}
