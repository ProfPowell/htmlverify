import type { LineIndex } from '../parse/lines.ts';
import type { Parsed } from '../parse/parse.ts';
import type { Signals } from '../parse/reconcile.ts';
import type { Vocabulary } from '../vocab/vocabulary.ts';

export type Severity = 'error' | 'warning' | 'info';
export type Authority = 'standard' | 'vocabulary' | 'policy' | 'heuristic';

export interface Edit {
  offset: number;
  endOffset: number;
  text: string;
}

/** A finding before the report assigns severity and positions. */
export interface RawFinding {
  rule: string;
  offset: number;
  endOffset: number;
  message: string;
  /** Overrides the profile's severity for this one finding. */
  severity?: Severity;
  evidence?: Record<string, string | number | boolean>;
  fix?: Edit[];
  /** Offsets of other places the defect shows, such as where the parser closed the element. */
  alsoAt?: number[];
  /**
   * Names the defect when rules of several families can report it: findings
   * with the same defect at the same location merge into one (spec §5.1).
   */
  defect?: string;
}

/** A judgment the tool can't make, asked of a person (spec §5.2). */
export interface RawReview {
  rule: string;
  offset: number;
  endOffset: number;
  ask: string;
}

export interface Options {
  /** `<br />`, `<br/>`, or `<br>`. */
  voidElements: 'xhtml' | 'tight' | 'html';
  /** The house form of boolean attributes; null when no house form applies. */
  booleanValue: 'true' | 'empty' | 'name' | null;
  /** Language of the generic link texts a11y/link-text looks for. */
  linkTextLanguage: 'en';
  /** Undeclared custom elements with this prefix are ad hoc: accepted with a warning. Null turns it off. */
  adHocPrefix: string | null;
}

export interface RuleContext {
  text: string;
  bytes: Uint8Array;
  bom: boolean;
  parsed: Parsed;
  signals: Signals;
  lines: LineIndex;
  options: Options;
  /** Each rule's options: its defaults with the config's values applied. */
  ruleOptions: Readonly<Record<string, Readonly<Record<string, RuleOptionValue>>>>;
  vocabulary: Vocabulary;
}

export type RuleOptionValue = number | readonly string[];

export interface RuleOptionSpec {
  type: 'number' | 'strings';
  default: RuleOptionValue;
  summary: string;
  /** Numbers: only whole numbers, and the smallest allowed (default 0). */
  integer?: boolean;
  min?: number;
}

export interface RuleMeta {
  id: string;
  authority: Authority;
  summary: string;
  ref: string;
  /** Options the config can set: "bloat/depth": ["warning", { "max": 16 }]. */
  options?: Readonly<Record<string, RuleOptionSpec>>;
  /** Always an error: the config can't change it, since correct output depends on it. */
  fixed?: true;
}
