import type { Options, RuleOptionValue, Severity } from './rules/types.ts';

export type ProfileName = 'strict' | 'standard';

export interface Profile {
  name: ProfileName;
  severities: Readonly<Record<string, Severity | 'off'>>;
  options: Options;
  /** More warnings than this fail the file; null means warnings never fail. */
  maxWarnings: number | null;
  /** Rule options set by a config; rules fall back to their defaults. */
  ruleOptions: Readonly<Record<string, Readonly<Record<string, RuleOptionValue>>>>;
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
  'style/escape': 'warning',
  'style/whitespace': 'warning',
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

const A11Y = {
  'a11y/lang': 'error',
  'a11y/title': 'error',
  'a11y/img-alt': 'error',
  'a11y/svg': 'error',
  'a11y/name': 'error',
  'a11y/label': 'error',
  'a11y/aria-role': 'error',
  'a11y/aria-attr': 'error',
  'a11y/aria-redundant': 'warning',
  'a11y/aria-hidden-focus': 'error',
  'a11y/headings': 'error',
  'a11y/landmarks': 'warning',
  'a11y/link-text': 'warning',
  'a11y/form-group': 'warning',
  'a11y/table': 'warning',
  'a11y/media': 'warning',
} as const;

// The semantic, policy, and bloat tables of spec §6.6–§6.8: [strict, standard]. Review-only rules are on at info.
const LATER_FAMILIES: Record<string, readonly [Severity | 'off', Severity | 'off']> = {
  'semantic/generic-control': ['error', 'warning'],
  'semantic/link-href': ['error', 'warning'],
  'semantic/native-alternative': ['warning', 'info'],
  'semantic/section-heading': ['warning', 'info'],
  'semantic/heading-candidate': ['info', 'info'],
  'semantic/list-candidate': ['info', 'off'],
  'semantic/br-spacing': ['warning', 'info'],
  'semantic/empty-element': ['warning', 'info'],
  'semantic/fragment-link': ['warning', 'warning'],
  'semantic/placeholder-content': ['warning', 'warning'],
  'policy/no-div': ['error', 'off'],
  'policy/single-h1': ['error', 'off'],
  'policy/button-type': ['error', 'off'],
  'policy/inline-handler': ['error', 'warning'],
  'policy/javascript-url': ['error', 'error'],
  'policy/inline-style': ['warning', 'off'],
  'policy/inline-svg': ['error', 'off'],
  'policy/prefer-strong-em': ['warning', 'off'],
  'policy/head': ['error', 'off'],
  'policy/elements': ['off', 'off'],
  'policy/class': ['warning', 'info'],
  'bloat/generic-ratio': ['warning', 'off'],
  'bloat/wrapper-chain': ['warning', 'off'],
  'bloat/class-count': ['warning', 'off'],
  'bloat/depth': ['warning', 'off'],
  'bloat/size': ['warning', 'off'],
};
const later = (column: 0 | 1) => Object.fromEntries(Object.entries(LATER_FAMILIES).map(([id, s]) => [id, s[column]]));

const M1 = 'not implemented until M1';

export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  strict: {
    name: 'strict',
    severities: { ...SYNTAX, ...STYLE, ...CONTENT, ...A11Y, 'a11y/tabindex': 'error', ...later(0) },
    options: { voidElements: 'xhtml', booleanValue: 'true', linkTextLanguage: 'en' },
    maxWarnings: null,
    ruleOptions: {},
    untested: [
      { check: 'component/*', reason: M1 },
    ],
  },
  standard: {
    name: 'standard',
    severities: { ...SYNTAX, ...Object.fromEntries(Object.keys(STYLE).map((id) => [id, 'off'])), ...CONTENT, ...A11Y, 'a11y/tabindex': 'warning', ...later(1) },
    options: { voidElements: 'xhtml', booleanValue: null, linkTextLanguage: 'en' },
    maxWarnings: null,
    ruleOptions: {},
    untested: [
      { check: 'component/*', reason: M1 },
    ],
  },
};

export function isProfileName(name: string): name is ProfileName {
  return name === 'strict' || name === 'standard';
}
