import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every `vi.mock` factory that stands in for a module `base.reward` imports must
 * provide the bindings it actually imports.
 *
 * Two of those modules cannot be mocked by spreading `importOriginal` — the
 * reward suites replace `~/server/clickhouse/client` and
 * `~/server/services/buzz.service` precisely to avoid constructing the real
 * clients, and spreading loads them for real (measured at 1.8s → 15.6s of import
 * on one file). `~/server/prom/client` is replaced globally in `setup.ts` for
 * the same reason. So the export surface is hand-written in three places, and a
 * hand-written surface pins itself to the day it was typed.
 *
 * The failure when it falls behind is the invisible one: the missing binding
 * resolves to `undefined`, the test file fails to LOAD, and a file that fails to
 * load reports **0 tests** rather than a red one.
 *
 * Two properties make this an actual guard rather than a restatement:
 *
 *  - It reads the **mock factories themselves**, not a list kept alongside them.
 *    An earlier version asserted `base.reward`'s imports against a literal in
 *    this file, which left the mocks — the thing that has to be right —
 *    unchecked, and made "add the name to the literal" the fastest way to get
 *    green while the suites still collected nothing.
 *  - It derives the modules from `base.reward`'s own imports, so a module it
 *    starts importing is covered without anyone adding it here. The prom
 *    regression that produced this file was in a module the earlier version did
 *    not name.
 *
 * It lives in its own file, importing only `fs`, on purpose: a check inside a
 * suite that fails to load cannot run either.
 */

const REWARDS_TESTS = path.resolve(__dirname);
const BASE_REWARD = path.resolve(__dirname, '../base.reward.ts');
const GLOBAL_SETUP = path.resolve(__dirname, '../../../__tests__/setup.ts');

/** Files whose `vi.mock` factories can stand in for a module base.reward loads. */
const mockSources = () => [
  GLOBAL_SETUP,
  ...fs
    .readdirSync(REWARDS_TESTS)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => path.join(REWARDS_TESTS, name))
    .filter((file) => file !== __filename),
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Comments out, quotes intact.
 *
 * Not optional tidying: `setup.ts`'s prom factory carries a comment containing a
 * literal `'...'`, which the brace scanner below read as a spread and reported
 * the whole module as fully mocked. That is how the first version of this guard
 * passed while the very stub it should have demanded was missing.
 */
function stripComments(source: string) {
  let out = '';
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      out += char;
      if (char === '\\') out += source[++i] ?? '';
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 1;
      if (i === 0) throw new Error('mock-surface guard: unterminated block comment');
      continue;
    }
    out += char;
  }

  return out;
}

/** The named value bindings `source` imports from `module`. */
function valueImportsFrom(source: string, module: string) {
  const pattern = new RegExp(
    `import\\s+(?!type\\s)\\{([^}]*)\\}\\s+from\\s+'${escape(module)}'`,
    'g'
  );
  const names = new Set<string>();
  for (const match of source.matchAll(pattern))
    for (const specifier of match[1].split(','))
      if (specifier.trim()) names.add(specifier.trim().split(/\s+as\s+/)[0]);

  return [...names];
}

/** Every module `base.reward` takes a value binding from, with those bindings. */
function importedModules(source: string) {
  const modules = new Map<string, string[]>();
  for (const [, module] of source.matchAll(/from\s+'([^']+)'/g))
    if (!modules.has(module)) {
      const imports = valueImportsFrom(source, module);
      if (imports.length) modules.set(module, imports);
    }

  return modules;
}

/** The text between `open` and its matching close, exclusive. */
function balanced(source: string, open: number, closing: string) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(' || source[i] === '{') depth++;
    else if (source[i] === ')' || source[i] === '}') {
      depth--;
      if (depth === 0) {
        if (source[i] !== closing) break;
        return source.slice(open + 1, i);
      }
    }
  }

  throw new Error(`mock-surface guard: unbalanced ${closing} — the parser needs fixing, not you`);
}

/**
 * What a file's `vi.mock` of `module` provides: the factory's top-level keys, or
 * `'all'` when it spreads (`importOriginal`), or `null` when it does not mock it.
 *
 * Throws rather than returning nothing when a mock is present but unreadable —
 * a parser that quietly gives up would report every suite as covered.
 */
function mockedExports(source: string, module: string): string[] | 'all' | null {
  const call = source.indexOf(`vi.mock('${module}'`);
  if (call === -1) return null;

  const args = balanced(source, source.indexOf('(', call), ')');
  const factory = args.indexOf('=>');
  // `vi.mock(path)` with no factory automocks and keeps the real shape.
  if (factory === -1) return 'all';

  const literal = args.indexOf('{', factory);
  if (literal === -1)
    throw new Error(`mock-surface guard: could not read the factory for ${module}`);

  const body = balanced(args, literal, '}');
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(' || body[i] === '{' || body[i] === '[') depth++;
    else if (body[i] === ')' || body[i] === '}' || body[i] === ']') depth--;
    else if (depth === 0) {
      if (body.startsWith('...', i)) return 'all';
      const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
      if (key && (i === 0 || /[\s,]/.test(body[i - 1]))) keys.push(key[1]);
    }
  }

  return keys;
}

// Stripped for the same reason the mock sources are: a commented-out import
// would otherwise be demanded of every mock.
const baseReward = stripComments(fs.readFileSync(BASE_REWARD, 'utf-8'));

const cases = mockSources().flatMap((file) => {
  const source = stripComments(fs.readFileSync(file, 'utf-8'));
  return [...importedModules(baseReward)]
    .map(([module, imports]) => ({ file, module, imports, mocked: mockedExports(source, module) }))
    .filter((entry) => entry.mocked !== null)
    .map((entry) => [`${path.basename(entry.file)} mocks ${entry.module}`, entry] as const);
});

describe('the mocks the reward suites stand in for base.reward with', () => {
  // A file that mocks nothing base.reward imports contributes no case, so an
  // empty set would mean the discovery above broke rather than that all is well.
  it('finds the mocks to check', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('%s and provides everything it imports', (_, { module, imports, mocked }) => {
    if (mocked === 'all') return;

    // A mock missing one of these does not fail here at runtime — it makes the
    // suite that uses it collect 0 tests, silently. Add the binding to that
    // factory (or spread `importOriginal`, if the module is cheap to load).
    expect({ module, missing: imports.filter((name) => !mocked.includes(name)) }).toEqual({
      module,
      missing: [],
    });
  });
});
