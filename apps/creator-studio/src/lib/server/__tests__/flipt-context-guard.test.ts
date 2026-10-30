import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../../', import.meta.url));
const EVAL_METHODS = ['isEnabled', 'isEnabledSync', 'getBoolean', 'getVariant'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : walk(full);
    return /\.(ts|svelte)$/.test(entry) && !entry.includes('.test.') ? [full] : [];
  });
}

/** Slice the argument list of `name(` starting at `from`, balancing parens. */
function callArgs(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(from + 1, i);
    }
  }
  return source.slice(from);
}

function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of args) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

// 🔴 The defect this exists for: a Flipt segment matches on CONTEXT PROPERTIES, never on the
// entity id, so `isEnabled(flag, String(user.id))` matches no segment and returns the flag's
// `enabled` value — false for every segmented flag we ship. That 404'd creator-announcements and
// scheduled-model-sales for every Creator Studio user, moderators included, while the flag itself
// read as correctly configured. Reviewing a call site does not catch it; nothing else does either.
describe('every Flipt evaluation in the Studio passes a targeting context', () => {
  const offenders: string[] = [];
  const checked: string[] = [];

  for (const file of walk(SRC)) {
    // The shim is where fliptContext is defined; it evaluates nothing.
    if (relative(SRC, file) === join('lib', 'server', 'flipt.ts')) continue;
    const source = readFileSync(file, 'utf8');
    for (const method of EVAL_METHODS) {
      let index = source.indexOf(`.${method}(`);
      while (index !== -1) {
        const args = topLevelArgs(callArgs(source, index + method.length + 1));
        const where = `${relative(SRC, file).split(sep).join('/')} .${method}(${args[0] ?? ''})`;
        checked.push(where);
        if (args.length < 3 || !args[2].includes('fliptContext')) offenders.push(where);
        index = source.indexOf(`.${method}(`, index + 1);
      }
    }
  }

  it('finds the evaluations to check', () => {
    // Guards the guard: a walk that silently matches nothing would pass the assertion below.
    expect(checked.length).toBeGreaterThanOrEqual(4);
  });

  it('leaves none of them context-less', () => {
    expect(offenders).toEqual([]);
  });
});
