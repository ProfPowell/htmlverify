// `htmlverify init [--claude]` (spec §10.1, §10.4): a config, and with
// --claude the skill and the PostToolUse hook. Existing files are kept, and an
// existing settings.json is merged, never replaced.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from '../config.ts';
import type { ProfileName } from '../profiles.ts';
import { DEFAULT_VOCABULARIES } from '../vocab/vocabulary.ts';

export const HOOK_COMMAND = 'npx htmlverify hook claude';
const SKILL = fileURLToPath(new URL('../../assets/claude/SKILL.md', import.meta.url));

export class InitError extends Error {}

/** One matcher group of a Claude Code hooks setting. */
interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}

export interface InitOptions {
  claude: boolean;
  force: boolean;
  profile: ProfileName;
}

/** Creates or updates the files; returns one line per file, saying what happened. */
export async function init(cwd: string, options: InitOptions): Promise<string[]> {
  const done: string[] = [];
  const write = async (path: string, content: string, label: string) => {
    if (existsSync(path) && !options.force) {
      done.push(`${label}: exists; left as is (--force replaces it)`);
      return;
    }
    const existed = existsSync(path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    done.push(`${label}: ${existed ? 'replaced' : 'created'}`);
  };

  const config = { extends: options.profile, vocabularies: [...DEFAULT_VOCABULARIES] };
  await write(join(cwd, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, CONFIG_FILE);
  if (!options.claude) return done;

  await write(join(cwd, '.claude', 'skills', 'htmlverify', 'SKILL.md'), await readFile(SKILL, 'utf8'), '.claude/skills/htmlverify/SKILL.md');

  // The hook goes into the shared project settings, beside whatever hooks are there.
  const settingsPath = join(cwd, '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      settings = parsed as Record<string, unknown>;
    } catch (error) {
      throw new InitError(`.claude/settings.json isn’t valid JSON (${(error as Error).message}); fix it, then run init again`);
    }
  }
  const hooks = (settings['hooks'] ??= {}) as Record<string, unknown>;
  const post = (hooks['PostToolUse'] ??= []) as HookEntry[];
  if (!Array.isArray(post)) throw new InitError('.claude/settings.json: hooks.PostToolUse must be an array');
  if (post.some((entry) => entry.hooks?.some((h) => h.command?.includes('htmlverify hook claude')))) {
    done.push('.claude/settings.json: the htmlverify hook is already there');
  } else {
    post.push({ matcher: 'Write|Edit', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 60 }] });
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    done.push(`.claude/settings.json: added the PostToolUse hook (${HOOK_COMMAND})`);
  }
  return done;
}
