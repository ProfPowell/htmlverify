// `htmlverify fix` (spec §8): applies the tree-preserving fixes that findings
// propose, in rounds, keeping only edits that leave the tree as it was and add
// no error.

import { resolveProfile } from '../config.ts';
import { decodeUtf8 } from '../parse/decode.ts';
import { parseHtml } from '../parse/parse.ts';
import { check, type CheckInput, type CheckOptions, type FileReport, type Finding, type Report } from '../report/report.ts';
import type { Edit } from '../rules/types.ts';
import { vocabularyBooleans } from '../vocab/booleans.ts';
import { Vocabulary } from '../vocab/vocabulary.ts';
import { applyEdits, conflicts } from './apply.ts';
import { treeSignature } from './equivalence.ts';

export interface FixResult {
  path: string;
  /** The input as decoded (without a BOM) and after fixing; equal when nothing changed. */
  before: string;
  after: string;
  bom: boolean;
  /** Findings whose fixes were applied. */
  applied: number;
  /** Fixes that would have changed the tree or added an error, kept as suggestions. */
  dropped: Pick<Finding, 'rule' | 'line' | 'column' | 'message'>[];
  /** The fixed text's report. */
  report: Report;
}

const ROUNDS = 5;

export async function fix(input: CheckInput, options: CheckOptions = {}): Promise<FixResult> {
  const bytes = typeof input.source === 'string' ? new TextEncoder().encode(input.source) : input.source;
  const decoded = decodeUtf8(bytes);
  if (!decoded.ok) {
    const report = await check(input, options);
    return { path: input.path, before: '', after: '', bom: false, applied: 0, dropped: [], report };
  }
  const context = input.context ?? null;
  const profile = resolveProfile(options.profile, options.config ?? null);
  const booleans = vocabularyBooleans(new Vocabulary(profile.vocabularies, profile.elements, profile.options.adHocPrefix));
  const signature = (text: string) => treeSignature(parseHtml(text, context), booleans);
  const run = async (text: string) => check({ path: input.path, source: (decoded.bom ? '﻿' : '') + text, context }, options);
  const errors = (file: FileReport) => {
    const counts = new Map<string, number>();
    for (const f of file.findings) if (f.severity === 'error') counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
    return counts;
  };
  const original = signature(decoded.text);
  const refused = new Set<string>();
  const key = (f: Finding) => `${f.rule}\0${f.message}\0${f.fix!.edits.map((e) => e.text).join('\0')}`;

  let text = decoded.text;
  let report = await run(text);
  let applied = 0;
  const dropped: FixResult['dropped'] = [];
  /** The text after `edits`, or null when it changes the tree or adds an error. */
  const attempt = async (edits: Edit[], before: FileReport): Promise<{ text: string; report: Report } | null> => {
    const candidate = applyEdits(text, edits);
    if (signature(candidate) !== original) return null;
    const after = await run(candidate);
    const was = errors(before);
    for (const [rule, n] of errors(after.files[0]!)) if (n > (was.get(rule) ?? 0)) return null;
    return { text: candidate, report: after };
  };

  for (let round = 0; round < ROUNDS; round++) {
    const file = report.files[0]!;
    // Earlier findings win when two fixes touch the same text; the rest wait for the next round.
    const chosen: Finding[] = [];
    const edits: Edit[] = [];
    for (const f of file.findings) {
      if (!f.fix || refused.has(key(f))) continue;
      if (f.fix.edits.some((e) => edits.some((taken) => conflicts(e, taken)))) continue;
      chosen.push(f);
      edits.push(...f.fix.edits);
    }
    if (chosen.length === 0) break;
    const together = await attempt(edits, file);
    if (together) {
      ({ text, report } = together);
      applied += chosen.length;
      continue;
    }
    // Something in the batch doesn't hold: halve it until the fixes that don't are found.
    const bisect = async (group: Finding[]): Promise<Finding[]> => {
      if (await attempt(group.flatMap((f) => f.fix!.edits), file)) return group;
      if (group.length === 1) {
        const f = group[0]!;
        refused.add(key(f));
        dropped.push({ rule: f.rule, line: f.line, column: f.column, message: f.message });
        return [];
      }
      const half = Math.ceil(group.length / 2);
      return [...(await bisect(group.slice(0, half))), ...(await bisect(group.slice(half)))];
    };
    const good = await bisect(chosen);
    if (good.length === 0) break;
    // Fixes that hold one by one can still clash together; then take the first alone.
    let kept = await attempt(good.flatMap((f) => f.fix!.edits), file);
    let count = good.length;
    if (!kept) {
      kept = await attempt(good[0]!.fix!.edits, file);
      count = 1;
    }
    if (!kept) break;
    ({ text, report } = kept);
    applied += count;
  }
  return { path: input.path, before: decoded.text, after: text, bom: decoded.bom, applied, dropped, report };
}
