import type { Options, Severity } from './rules/types.ts';

export type ProfileName = 'strict' | 'standard';

export interface Profile {
  name: ProfileName;
  severities: Readonly<Record<string, Severity | 'off'>>;
  options: Options;
  /** More warnings than this fail the file; null means warnings never fail. */
  maxWarnings: number | null;
  /** Checks the profile includes that this version doesn't implement yet. */
  untested: readonly { check: string; reason: string }[];
}

const SYNTAX = {
  'syntax/parse-error': 'error',
  'syntax/duplicate-attribute': 'error',
  'syntax/self-closing-non-void': 'error',
  'syntax/unclosed-element': 'error',
  'syntax/stray-end-tag': 'error',
  'syntax/misplaced-start-tag': 'error',
  'syntax/misnested': 'error',
  'syntax/reordered': 'error',
  'syntax/doctype': 'error',
  'syntax/encoding': 'error',
} as const;

const STYLE = {
  'style/attr-quotes': 'error',
  'style/boolean-attr': 'error',
  'style/lowercase': 'error',
  'style/void-element': 'error',
  'style/explicit-start-tag': 'error',
  'style/explicit-end-tag': 'error',
  'style/doctype': 'error',
} as const;

const CONTENT = {
  'content/unknown-element': 'error',
  'content/obsolete': 'error',
  'content/unknown-attribute': 'error',
  'content/attribute-value': 'error',
  'content/missing-attribute': 'error',
  'content/child': 'error',
  'content/order': 'error',
  'content/descendant': 'error',
  'content/context': 'error',
  'content/duplicate-id': 'error',
  'content/invalid-id': 'error',
  'content/idref': 'error',
  'content/document': 'error',
} as const;

const M1 = 'not implemented until M1';

export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  strict: {
    name: 'strict',
    severities: { ...SYNTAX, ...STYLE, ...CONTENT },
    options: { voidElements: 'xhtml', booleanValue: 'true' },
    maxWarnings: null,
    untested: [
      { check: 'component/*', reason: M1 },
      { check: 'a11y/*', reason: M1 },
      { check: 'semantic/*', reason: M1 },
      { check: 'policy/*', reason: M1 },
      { check: 'bloat/*', reason: M1 },
      { check: 'style/escape', reason: M1 },
      { check: 'style/whitespace', reason: M1 },
    ],
  },
  standard: {
    name: 'standard',
    severities: { ...SYNTAX, ...Object.fromEntries(Object.keys(STYLE).map((id) => [id, 'off'])), ...CONTENT },
    options: { voidElements: 'xhtml', booleanValue: null },
    maxWarnings: null,
    untested: [
      { check: 'component/*', reason: M1 },
      { check: 'a11y/*', reason: M1 },
      { check: 'semantic/*', reason: M1 },
    ],
  },
};

export function isProfileName(name: string): name is ProfileName {
  return name === 'strict' || name === 'standard';
}
