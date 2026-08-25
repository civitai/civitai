import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// On Windows a console child with no console of its own gets a fresh one, and Windows 11 hands that
// to the default terminal app — a Windows Terminal window opens and takes focus. `windowsHide`
// suppresses it, but node applies it only to the process IT creates: with `shell: true` it lands on
// cmd.exe, and the process cmd.exe then starts is created with default flags. The daemon is spawned
// detached with stdio ignored, so it owns no console to lend, and every one of its children is in
// that position. Piping stdio does not prevent the allocation.
const SKILL = resolve(__dirname, '../../.claude/skills/dev-server');

const FILES = [
  'cli.mjs',
  'console.mjs',
  'scripts/daemon.mjs',
  'scripts/test-queue.mjs',
  'scripts/worktree.mjs',
];

const read = (file: string) => readFileSync(resolve(SKILL, file), 'utf8');

/** The object literal enclosing `at`, by brace balance. */
function enclosingLiteral(source: string, at: number) {
  let depth = 0;
  let open = -1;
  for (let i = at; i >= 0; i--) {
    if (source[i] === '}') depth++;
    else if (source[i] === '{') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open === -1) return null;
  depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0)
        return { text: source.slice(open, i + 1), line: source.slice(0, open).split('\n').length };
    }
  }
  return null;
}

describe('the dev-server skill never pops a console window', () => {
  it.each(FILES)('every spawn option object in %s hides the console', (file) => {
    const source = read(file);
    const offenders: string[] = [];
    for (let i = source.indexOf('stdio:'); i !== -1; i = source.indexOf('stdio:', i + 1)) {
      const literal = enclosingLiteral(source, i);
      if (literal && !literal.text.includes('windowsHide')) {
        offenders.push(`${file}:${literal.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(['cli.mjs', 'console.mjs'])('%s starts the daemon without a shell', (file) => {
    const source = read(file);
    const start = source.indexOf('async function startDaemon');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}', start));
    expect(body).toContain('spawn(process.execPath, [serverScript]');
    expect(body.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/\bshell\s*:/);
  });
});
