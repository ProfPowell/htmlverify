import type { Options, RuleOptionValue, Severity } from './rules/types.ts';
import type { VocabElement } from './vocab/types.ts';
import { DEFAULT_VOCABULARIES } from './vocab/vocabulary.ts';

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
  /** Vocabulary snapshots (name@version) and the project's elements.json. */
  vocabularies: readonly string[];
  elements: Readonly<Record<string, VocabElement>> | null;
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

// The component, semantic, policy, and bloat tables of spec §6.4 and §6.6–§6.8: [strict, standard]. Review-only rules are on at info.
const LATER_FAMILIES: Record<string, readonly [Severity | 'off', Severity | 'off']> = {
  // Runs only with --nu; each finding takes Nu's own severity.
  'conformance/nu': ['error', 'error'],
  // Assembly (spec §9.8); review status is an error only under strict without --draft.
  'assembly/plan': ['error', 'error'],
  'assembly/component': ['error', 'error'],
  'assembly/data': ['error', 'error'],
  'assembly/slot': ['error', 'error'],
  'assembly/key': ['error', 'error'],
  'assembly/ref': ['error', 'error'],
  'assembly/id-collision': ['error', 'error'],
  'assembly/heading-depth': ['error', 'error'],
  'assembly/restricted-html': ['error', 'error'],
  'assembly/budget': ['error', 'error'],
  'assembly/round-trip': ['error', 'error'],
  'component/unknown-element': ['error', 'warning'],
  'component/attribute': ['error', 'error'],
  'component/content': ['error', 'error'],
  'component/output-attribute': ['warning', 'warning'],
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

export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  strict: {
    name: 'strict',
    severities: { ...SYNTAX, ...STYLE, ...CONTENT, ...A11Y, 'a11y/tabindex': 'error', ...later(0) },
    options: { voidElements: 'xhtml', booleanValue: 'true', linkTextLanguage: 'en', adHocPrefix: 'x-' },
    maxWarnings: null,
    ruleOptions: {},
    untested: [],
    vocabularies: DEFAULT_VOCABULARIES,
    elements: null,
  },
  standard: {
    name: 'standard',
    severities: { ...SYNTAX, ...Object.fromEntries(Object.keys(STYLE).map((id) => [id, 'off'])), ...CONTENT, ...A11Y, 'a11y/tabindex': 'warning', ...later(1) },
    options: { voidElements: 'xhtml', booleanValue: null, linkTextLanguage: 'en', adHocPrefix: 'x-' },
    maxWarnings: null,
    ruleOptions: {},
    untested: [],
    vocabularies: DEFAULT_VOCABULARIES,
    elements: null,
  },
};

export function isProfileName(name: string): name is ProfileName {
  return name === 'strict' || name === 'standard';
}
