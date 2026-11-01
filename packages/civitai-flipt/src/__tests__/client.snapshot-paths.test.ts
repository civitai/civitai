import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFliptClient, prepareFliptContext, type FliptOptions } from '../client';

/**
 * The two per-snapshot shortcuts in front of the eval cache, against the REAL SDK and wasm engine
 * fed by a local snapshot server: the engine is both the thing being skipped and the oracle.
 *
 * Snapshot shapes follow the evaluation-snapshot document the SDK consumes (`rules`/`rollouts`
 * arrays, `SEGMENT_ROLLOUT_TYPE` / `THRESHOLD_ROLLOUT_TYPE`, `*_SEGMENT_MATCH_TYPE`), the same shape
 * as the captured fixture in src/server/services/__tests__/fixtures.
 */

const SWITCH = 'flipt-skip-norollout-eval';

type Flag = Record<string, unknown> & { key: string };

const moderators = {
  key: 'moderators',
  name: '',
  description: '',
  matchType: 'ALL_SEGMENT_MATCH_TYPE',
  constraints: [
    {
      type: 'STRING_CONSTRAINT_COMPARISON_TYPE',
      property: 'isModerator',
      operator: 'eq',
      value: 'true',
    },
  ],
};

const boolFlag = (key: string, enabled: boolean, rollouts?: unknown[] | null): Flag => ({
  key,
  name: key,
  description: '',
  enabled,
  type: 'BOOLEAN_FLAG_TYPE',
  rules: [],
  ...(rollouts === undefined ? {} : { rollouts }),
});

// Every shape a boolean evaluation can meet. Each rollout's value is the OPPOSITE of the flag's
// `enabled`, so a fast path wrongly taken for it returns a visibly different answer.
const SHAPES: Flag[] = [
  boolFlag('no-rollouts-on', true, []),
  boolFlag('no-rollouts-off', false, []),
  boolFlag('rollouts-absent-on', true),
  boolFlag('rollouts-null-off', false, null),
  boolFlag('threshold-50', false, [
    { type: 'THRESHOLD_ROLLOUT_TYPE', rank: 1, threshold: { percentage: 50, value: true } },
  ]),
  boolFlag('threshold-100-off', true, [
    { type: 'THRESHOLD_ROLLOUT_TYPE', rank: 1, threshold: { percentage: 100, value: false } },
  ]),
  boolFlag('segment-mods', false, [
    {
      type: 'SEGMENT_ROLLOUT_TYPE',
      rank: 1,
      segment: { value: true, segmentOperator: 'OR_SEGMENT_OPERATOR', segments: [moderators] },
    },
  ]),
  {
    key: 'variant-flag',
    name: 'variant-flag',
    description: '',
    enabled: true,
    type: 'VARIANT_FLAG_TYPE',
    rules: [
      {
        id: 'r1',
        rank: 1,
        segmentOperator: 'OR_SEGMENT_OPERATOR',
        segments: [moderators],
        distributions: [{ variantKey: 'a', rollout: 100 }],
      },
    ],
    rollouts: [],
  },
];
const FAST = ['no-rollouts-on', 'no-rollouts-off', 'rollouts-absent-on', 'rollouts-null-off'];
const SLOW = ['threshold-50', 'threshold-100-off', 'segment-mods', 'variant-flag'];

const SUBJECTS: [string, Record<string, string>][] = [
  ['anonymous', { isLoggedIn: 'false' }],
  ['1', { userId: '1', isModerator: 'true', isLoggedIn: 'true' }],
  ['2', { userId: '2', isModerator: 'false', isLoggedIn: 'true' }],
  ['3', { userId: '3', isModerator: 'false', isLoggedIn: 'true', tier: 'gold' }],
  ['4', {}],
  ['5', { isModerator: 'true' }],
];

let flags: Flag[] = [];
let etag = 0;
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const tag = `"v${etag}"`;
    if (req.headers['if-none-match'] === tag) {
      res.writeHead(304, { etag: tag }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', etag: tag });
    res.end(JSON.stringify({ namespace: { key: 'default' }, flags }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function serve(next: Flag[]) {
  flags = next;
  etag++;
}

async function makeClient(extra: Partial<FliptOptions> = {}) {
  const flipt = createFliptClient({
    url,
    clientToken: 'test-token',
    environment: 'test',
    updateIntervalSeconds: 0,
    initTimeoutMs: 5000,
    failureCooldownMs: 0,
    evalCacheTtlMs: 0,
    evalCacheMaxEntries: 1000,
    localOverrides: {},
    log: () => undefined,
    onInitError: (e) => {
      throw e;
    },
    ...extra,
  });
  // updateIntervalSeconds 0: no refresh timer; snapshots change only on an explicit refresh().
  await flipt.ensureInitialized();
  const sdk = flipt.getClientSync();
  if (!sdk) throw new Error('client did not initialize');
  // The oracle: the engine itself, captured before the spy wraps it.
  const engine = sdk.evaluateBoolean.bind(sdk);
  const oracle = (flag: string, entityId: string, context: Record<string, string>) => {
    try {
      return engine({ flagKey: flag, entityId, context }).enabled;
    } catch {
      return null; // isEnabledSync's answer for any engine error
    }
  };
  const evaluate = vi.spyOn(sdk, 'evaluateBoolean');
  const callsFor = (flag: string) =>
    evaluate.mock.calls.filter(([req]) => req.flagKey === flag).length;
  return { flipt, sdk, evaluate, oracle, callsFor };
}

describe('a flag key the snapshot does not have', () => {
  it('answers exactly as before, from one engine call per snapshot, and picks the key up when it appears', async () => {
    serve([boolFlag('present', true, [])]);
    const onEvalError = vi.fn();
    const { flipt, sdk, callsFor } = await makeClient({ onEvalError, evalCacheTtlMs: 10_000 });

    // Same answers as the engine path: sync null, async false + the engine's error logged.
    for (const [entityId, context] of SUBJECTS) {
      expect(flipt.isEnabledSync('missing-flag', entityId, context)).toBeNull();
      expect(await flipt.isEnabled('missing-flag', entityId, context)).toBe(false);
      expect(await flipt.getBoolean('missing-flag', entityId, context)).toBe(false);
    }
    expect(onEvalError).toHaveBeenCalledTimes(SUBJECTS.length);
    for (const [error, flag] of onEvalError.mock.calls) {
      expect(flag).toBe('missing-flag');
      expect((error as Error).message).toMatch(
        /failed to get flag information default\/missing-flag/
      );
    }
    // 18 evaluations of the missing key, one engine call.
    expect(callsFor('missing-flag')).toBe(1);

    // An unchanged snapshot (304) keeps the remembered miss.
    expect(await sdk.refresh()).toBe(false);
    expect(flipt.isEnabledSync('missing-flag', 'anonymous', {})).toBeNull();
    expect(callsFor('missing-flag')).toBe(1);

    // The next snapshot adds the key: it is evaluated again and answers.
    serve([boolFlag('present', true, []), boolFlag('missing-flag', true, [])]);
    expect(await sdk.refresh()).toBe(true);
    expect(flipt.isEnabledSync('missing-flag', 'anonymous', {})).toBe(true);
    expect(await flipt.isEnabled('missing-flag', '1', {})).toBe(true);
    expect(callsFor('missing-flag')).toBe(3);
  });

  it('keeps retrying an error for a key the engine DOES list', async () => {
    // Evaluating a variant flag as a boolean throws, but the key exists: not a miss.
    serve(SHAPES);
    const { flipt, callsFor } = await makeClient();
    for (let i = 0; i < 4; i++)
      expect(flipt.isEnabledSync('variant-flag', 'anonymous', {})).toBeNull();
    expect(callsFor('variant-flag')).toBe(4);
  });
});

describe('the no-rollout fast path', () => {
  it.each([
    ['ON', true],
    ['OFF', false],
  ])(
    'with the switch %s, answers exactly what the engine answers for every shape and subject',
    async (_label, on) => {
      serve([...SHAPES, boolFlag(SWITCH, on, [])]);
      const { flipt, oracle, callsFor } = await makeClient({ noRolloutFastPathSwitch: SWITCH });

      for (const { key } of SHAPES) {
        for (const [entityId, context] of SUBJECTS) {
          const expected = oracle(key, entityId, context);
          expect({ key, entityId, got: flipt.isEnabledSync(key, entityId, context) }).toEqual({
            key,
            entityId,
            got: expected,
          });
          // A prepared context is the same input.
          expect(flipt.isEnabledSync(key, entityId, prepareFliptContext(entityId, context))).toBe(
            expected
          );
        }
      }
      // Only no-rollout boolean flags skip the engine, and only with the switch on. The cache is
      // off (TTL 0), so every other evaluation reaches it.
      for (const key of FAST) expect(callsFor(key)).toBe(on ? 0 : SUBJECTS.length * 2);
      for (const key of SLOW) expect(callsFor(key)).toBe(SUBJECTS.length * 2);
      // The switch is read on the engine, once (cached for 5s), not through the path it gates.
      expect(callsFor(SWITCH)).toBe(1);
    }
  );

  it('applies from the first snapshot, and stops the moment a snapshot adds a rollout', async () => {
    serve([boolFlag('ramp', false, []), boolFlag(SWITCH, true, [])]);
    const { flipt, sdk, callsFor } = await makeClient({ noRolloutFastPathSwitch: SWITCH });

    expect(flipt.isEnabledSync('ramp', '1', { isModerator: 'true' })).toBe(false);
    expect(callsFor('ramp')).toBe(0);

    serve([
      boolFlag('ramp', false, [
        {
          type: 'SEGMENT_ROLLOUT_TYPE',
          rank: 1,
          segment: { value: true, segmentOperator: 'OR_SEGMENT_OPERATOR', segments: [moderators] },
        },
      ]),
      boolFlag(SWITCH, true, []),
    ]);
    expect(await sdk.refresh()).toBe(true);
    expect(flipt.isEnabledSync('ramp', '1', { isModerator: 'true' })).toBe(true);
    expect(flipt.isEnabledSync('ramp', '2', { isModerator: 'false' })).toBe(false);
    expect(callsFor('ramp')).toBe(2);
  });

  it('is off when the switch key is missing or no switch is configured', async () => {
    serve(SHAPES);
    const missingSwitch = await makeClient({ noRolloutFastPathSwitch: SWITCH });
    expect(missingSwitch.flipt.isEnabledSync('no-rollouts-on', 'anonymous', {})).toBe(true);
    expect(missingSwitch.callsFor('no-rollouts-on')).toBe(1);

    serve([...SHAPES, boolFlag(SWITCH, true, [])]);
    const noSwitch = await makeClient();
    expect(noSwitch.flipt.isEnabledSync('no-rollouts-on', 'anonymous', {})).toBe(true);
    expect(noSwitch.callsFor('no-rollouts-on')).toBe(1);
  });
});
