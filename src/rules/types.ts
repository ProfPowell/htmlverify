import type { LineIndex } from '../parse/lines.ts';
import type { Parsed } from '../parse/parse.ts';
import type { Signals } from '../parse/reconcile.ts';

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
}

export interface Options {
  /** `<br />`, `<br/>`, or `<br>`. */
  voidElements: 'xhtml' | 'tight' | 'html';
  /** The house form of boolean attributes; null when no house form applies. */
  booleanValue: 'true' | 'empty' | 'name' | null;
}

export interface RuleContext {
  text: string;
  bytes: Uint8Array;
  bom: boolean;
  parsed: Parsed;
  signals: Signals;
  lines: LineIndex;
  options: Options;
}

export interface RuleMeta {
  id: string;
  authority: Authority;
  summary: string;
  ref: string;
}
