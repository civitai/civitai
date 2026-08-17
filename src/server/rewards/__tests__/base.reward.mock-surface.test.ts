import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The reward suites hand-write `vi.mock` factories for the two modules
 * `base.reward` pulls a live client out of — `~/server/clickhouse/client` and
 * `~/server/services/buzz.service`. Neither can be replaced by spreading
 * `importOriginal`: that loads the real graph, which is the client construction
 * the mock exists to avoid (measured at 1.8s → 15.6s of import on one file).
 *
 * A hand-written factory pins the export surface to the day it was written, and
 * the failure when the surface grows is the bad one: the import resolves to
 * `undefined`, the test file fails to LOAD, and a file that fails to load
 * reports **0 tests** rather than a red one. Nothing goes red; the suite stops
 * existing.
 *
 * This file is the guard, and it is deliberately in its own module: a check
 * living inside a suite that fails to load cannot run either. It imports
 * nothing but `fs`, so it always executes, and it reads `base.reward`'s imports
 * as source rather than evaluating them.
 */

const BASE_REWARD = path.resolve(__dirname, '../base.reward.ts');

/**
 * What each mocked module must expose. Change one of these ONLY together with
 * every `vi.mock` of that module under `src/server/rewards/__tests__`.
 */
const MOCKED_MODULE_SURFACE: Record<string, string[]> = {
  '~/server/clickhouse/client': ['clickhouse'],
  '~/server/services/buzz.service': ['createBuzzTransactionMany', 'getMultipliersForUser'],
};

/** The named value imports `base.reward` takes from one module. */
function valueImportsFrom(source: string, module: string) {
  const pattern = new RegExp(`import\\s+(?!type\\s)\\{([^}]*)\\}\\s+from\\s+'${module}'`, 'g');
  const names: string[] = [];
  for (const match of source.matchAll(pattern))
    for (const specifier of match[1].split(','))
      if (specifier.trim()) names.push(specifier.trim().split(/\s+as\s+/)[0]);

  return names.sort();
}

describe('the modules the reward suites hand-mock', () => {
  it.each(Object.entries(MOCKED_MODULE_SURFACE))(
    'base.reward imports exactly the mocked surface of %s',
    (module, expected) => {
      const source = fs.readFileSync(BASE_REWARD, 'utf-8');

      // A mismatch means base.reward now needs an export the reward suites'
      // mocks do not provide. Add it to every vi.mock of this module under
      // src/server/rewards/__tests__ AND here — otherwise those suites will
      // silently collect 0 tests instead of failing.
      expect(valueImportsFrom(source, module)).toEqual([...expected].sort());
    }
  );
});
