import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATABASE_ENVIRONMENT_VAR,
  isDatabaseEnvironmentConfigured,
  isNonProductionDatabase,
  resolveDatabaseEnvironment,
} from '~/env/database-target';

/**
 * The decision table for "does this deployment write to a non-production database".
 *
 * Every expectation below is a HAND-WRITTEN LITERAL chosen from the deployment matrix, not a
 * value recomputed from the module under test. The three rows that matter:
 *
 *   production                              → nothing set                                → false
 *   non-production env, PRODUCTION database → IS_PREVIEW=true, DATABASE_ENVIRONMENT unset → false
 *                                             once configured with 'production'
 *   non-production env, scratch database    → IS_PREVIEW=true + 'non-production'          → true
 *
 * plus the transitional row that this change must not disturb: IS_PREVIEW=true with the new
 * variable UNSET must keep answering `true`, because that is today's behaviour and the
 * configuration half of the fix ships separately.
 */

describe('env/database-target — resolveDatabaseEnvironment', () => {
  it('reads the two documented spellings', () => {
    expect(resolveDatabaseEnvironment({ DATABASE_ENVIRONMENT: 'production' })).toBe('production');
    expect(resolveDatabaseEnvironment({ DATABASE_ENVIRONMENT: 'non-production' })).toBe(
      'non-production'
    );
  });

  it('trims and lowercases', () => {
    expect(resolveDatabaseEnvironment({ DATABASE_ENVIRONMENT: '  Production ' })).toBe('production');
    expect(resolveDatabaseEnvironment({ DATABASE_ENVIRONMENT: 'NON-PRODUCTION' })).toBe(
      'non-production'
    );
  });

  it('is unknown when unset, empty, or unrecognised', () => {
    expect(resolveDatabaseEnvironment({})).toBe('unknown');
    expect(resolveDatabaseEnvironment({ DATABASE_ENVIRONMENT: '' })).toBe('unknown');
    expect(resolveDatabaseEnvironment({ DATABASE_ENVIRONMENT: '   ' })).toBe('unknown');
    // 🔴 A typo must NOT round to one of the two real answers.
    expect(resolveDatabaseEnvironment({ DATABASE_ENVIRONMENT: 'prod' })).toBe('unknown');
    expect(resolveDatabaseEnvironment({ DATABASE_ENVIRONMENT: 'nonproduction' })).toBe('unknown');
    expect(resolveDatabaseEnvironment({ DATABASE_ENVIRONMENT: 'preview' })).toBe('unknown');
  });

  it('names its own variable', () => {
    expect(DATABASE_ENVIRONMENT_VAR).toBe('DATABASE_ENVIRONMENT');
  });
});

describe('env/database-target — isNonProductionDatabase', () => {
  it('production: neither variable set → false', () => {
    expect(isNonProductionDatabase({})).toBe(false);
  });

  it('explicit production database wins over IS_PREVIEW=true', () => {
    // The already-live falsifying case: a non-production environment on the production database.
    expect(
      isNonProductionDatabase({ IS_PREVIEW: 'true', DATABASE_ENVIRONMENT: 'production' })
    ).toBe(false);
  });

  it('explicit non-production database → true', () => {
    expect(
      isNonProductionDatabase({ IS_PREVIEW: 'true', DATABASE_ENVIRONMENT: 'non-production' })
    ).toBe(true);
  });

  it('explicit non-production database → true even without IS_PREVIEW', () => {
    // The variable is the sole authority once set; it does not need IS_PREVIEW's agreement.
    expect(isNonProductionDatabase({ DATABASE_ENVIRONMENT: 'non-production' })).toBe(true);
  });

  it('explicit production database → false even without IS_PREVIEW', () => {
    expect(isNonProductionDatabase({ DATABASE_ENVIRONMENT: 'production' })).toBe(false);
  });

  it('🔴 transitional: IS_PREVIEW=true with the variable UNSET keeps answering true', () => {
    // This is the whole safe-when-absent guarantee. If this flips to false, every ephemeral
    // deployment starts writing scratch-database rows into production-shared sinks the moment
    // the app ships and before any configuration lands.
    expect(isNonProductionDatabase({ IS_PREVIEW: 'true' })).toBe(true);
  });

  it('transitional: an unrecognised value falls back to the legacy reading, not to a guess', () => {
    expect(isNonProductionDatabase({ IS_PREVIEW: 'true', DATABASE_ENVIRONMENT: 'prod' })).toBe(true);
    expect(isNonProductionDatabase({ DATABASE_ENVIRONMENT: 'prod' })).toBe(false);
  });

  it('IS_PREVIEW is matched exactly, as the string "true"', () => {
    expect(isNonProductionDatabase({ IS_PREVIEW: 'false' })).toBe(false);
    expect(isNonProductionDatabase({ IS_PREVIEW: '1' })).toBe(false);
    expect(isNonProductionDatabase({ IS_PREVIEW: 'TRUE' })).toBe(false);
  });

  it('defaults to the live process env', () => {
    const original = process.env;
    try {
      process.env = { ...original, IS_PREVIEW: 'true', DATABASE_ENVIRONMENT: 'production' };
      expect(isNonProductionDatabase()).toBe(false);
      process.env = { ...original, IS_PREVIEW: 'true', DATABASE_ENVIRONMENT: 'non-production' };
      expect(isNonProductionDatabase()).toBe(true);
    } finally {
      process.env = original;
    }
  });
});

describe('env/database-target — differential vs the behaviour it replaces', () => {
  /**
   * 🔴 The safe-when-absent constraint, pinned STRUCTURALLY rather than case by case.
   *
   * `LEGACY` is a hand-written copy of the predicate the call sites used before this change
   * (`IS_PREVIEW === 'true'`) — written out here, not imported, so it cannot drift with the code
   * under test. Over the full cross product of the inputs that existed BEFORE the new variable,
   * the new predicate must agree with it EXACTLY. Any disagreement is a behaviour change shipped
   * ahead of the configuration that justifies it.
   */
  const LEGACY = (env: NodeJS.ProcessEnv) => env.IS_PREVIEW === 'true';

  const IS_PREVIEW_VALUES = [undefined, 'true', 'false', 'TRUE', '1', ''];

  it('agrees with the pre-change predicate on every input, while the variable is UNSET', () => {
    for (const IS_PREVIEW of IS_PREVIEW_VALUES) {
      const env: NodeJS.ProcessEnv = IS_PREVIEW === undefined ? {} : { IS_PREVIEW };
      expect({ IS_PREVIEW, answer: isNonProductionDatabase(env) }).toEqual({
        IS_PREVIEW,
        answer: LEGACY(env),
      });
    }
  });

  it('agrees with the pre-change predicate on every input, for an UNRECOGNISED value', () => {
    // A typo must not be a behaviour change either — it routes to the legacy reading.
    for (const IS_PREVIEW of IS_PREVIEW_VALUES) {
      const env: NodeJS.ProcessEnv = {
        DATABASE_ENVIRONMENT: 'prod',
        ...(IS_PREVIEW === undefined ? {} : { IS_PREVIEW }),
      };
      expect({ IS_PREVIEW, answer: isNonProductionDatabase(env) }).toEqual({
        IS_PREVIEW,
        answer: LEGACY(env),
      });
    }
  });

  it('positive control: the differential CAN disagree once the variable is set', () => {
    // Without this, the two cases above are indistinguishable from a comparison wired to
    // nothing. Set the variable and the predicates must part company — that is the whole point
    // of the change.
    const onProdDb: NodeJS.ProcessEnv = { IS_PREVIEW: 'true', DATABASE_ENVIRONMENT: 'production' };
    expect(LEGACY(onProdDb)).toBe(true);
    expect(isNonProductionDatabase(onProdDb)).toBe(false);

    const onScratchDb: NodeJS.ProcessEnv = { DATABASE_ENVIRONMENT: 'non-production' };
    expect(LEGACY(onScratchDb)).toBe(false);
    expect(isNonProductionDatabase(onScratchDb)).toBe(true);
  });

  it('production is unchanged: nothing set → false under both predicates', () => {
    expect(LEGACY({})).toBe(false);
    expect(isNonProductionDatabase({})).toBe(false);
  });
});

describe('env/database-target — isDatabaseEnvironmentConfigured', () => {
  it('distinguishes configured from legacy-fallback', () => {
    expect(isDatabaseEnvironmentConfigured({})).toBe(false);
    expect(isDatabaseEnvironmentConfigured({ IS_PREVIEW: 'true' })).toBe(false);
    expect(isDatabaseEnvironmentConfigured({ DATABASE_ENVIRONMENT: 'prod' })).toBe(false);
    expect(isDatabaseEnvironmentConfigured({ DATABASE_ENVIRONMENT: 'production' })).toBe(true);
    expect(isDatabaseEnvironmentConfigured({ DATABASE_ENVIRONMENT: 'non-production' })).toBe(true);
  });
});

describe('env/database-target — warnIfDatabaseEnvironmentUnset', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules(); // fresh module → fresh once-per-process `warned` latch
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('warns once when IS_PREVIEW=true and the variable is unset', async () => {
    const { warnIfDatabaseEnvironmentUnset } = await import('~/env/database-target');

    warnIfDatabaseEnvironmentUnset({ IS_PREVIEW: 'true' });
    warnIfDatabaseEnvironmentUnset({ IS_PREVIEW: 'true' });
    warnIfDatabaseEnvironmentUnset({ IS_PREVIEW: 'true' });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('DATABASE_ENVIRONMENT');
  });

  it('stays silent in production', async () => {
    const { warnIfDatabaseEnvironmentUnset } = await import('~/env/database-target');
    warnIfDatabaseEnvironmentUnset({});
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('stays silent once the variable is configured', async () => {
    const { warnIfDatabaseEnvironmentUnset } = await import('~/env/database-target');
    warnIfDatabaseEnvironmentUnset({ IS_PREVIEW: 'true', DATABASE_ENVIRONMENT: 'production' });
    warnIfDatabaseEnvironmentUnset({ IS_PREVIEW: 'true', DATABASE_ENVIRONMENT: 'non-production' });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const { warnIfDatabaseEnvironmentUnset } = await import('~/env/database-target');
    expect(() => warnIfDatabaseEnvironmentUnset({ IS_PREVIEW: 'true' })).not.toThrow();
  });
});
