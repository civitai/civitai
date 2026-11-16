import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
import { FliptClient } from '@flipt-io/flipt-client-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FliptNodeClient } from '../client';
import { buildFliptContext, type FliptTargetUser } from '../context';
import { createSnapshotFetcher } from '../snapshot';
import { canonical, evaluateCase, formatLines, sameResult } from '../../parity/evaluate.mjs';

// Node <-> Go Flipt parity, the NODE half. The corpus below is evaluated by the installed
// @flipt-io/flipt-client-js against parity/snapshot.json, and the cases with their results must
// equal parity/expected.json EXACTLY. The Go half (parity/go) evaluates the cases in that file with
// go.flipt.io/flipt-client and asserts the same results, so a change to either client's engine on
// its own turns one side red. parity/README.md has the engine-version mapping and the CI wiring.
//
// REGENERATE (after an intended change to the corpus, the snapshot or the Node client):
//   FLIPT_PARITY_WRITE=1 pnpm --filter @civitai/flipt exec vitest run src/__tests__/parity.test.ts
// Without a local Node, take it from CI: on a mismatch this test prints the regenerated file as
// gzip+base64 between the FLIPT-PARITY-EXPECTED markers (decode: base64 -d | gunzip).

const here = path.dirname(fileURLToPath(import.meta.url));
const parityDir = path.resolve(here, '../../parity');
const expectedPath = path.join(parityDir, 'expected.json');
const snapshot = JSON.parse(readFileSync(path.join(parityDir, 'snapshot.json'), 'utf8'));

/**
 * The go.flipt.io/flipt-client release whose embedded engine is built from the same
 * flipt-evaluation source as the pinned JS client (see parity/README.md). Recorded in the file so
 * the Go test can refuse to run against any other release.
 */
const GO_CLIENT = 'v1.1.1';

type Kind = 'boolean' | 'variant';
type ParityCase = {
  id: string;
  kind: Kind;
  flagKey: string;
  entityId: string;
  context: Record<string, string>;
};
type SnapshotFlag = {
  key: string;
  type: 'BOOLEAN_FLAG_TYPE' | 'VARIANT_FLAG_TYPE';
  rollouts?: { threshold?: { percentage: number } }[];
  rules?: { distributions: { rollout: number }[] }[];
};

function installedJsClientVersion(): string {
  const require = createRequire(import.meta.url);
  // The package's `exports` hides package.json; walk up from its resolved entry instead.
  let dir = path.dirname(require.resolve('@flipt-io/flipt-client-js'));
  while (!existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
}

// ── corpus ───────────────────────────────────────────────────────────────────────────────────

// A seeded PRNG, so the corpus is the same on every run and every machine.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// CRC-32 (IEEE), the engine's rollout hash. Used ONLY to pick entity ids that land on rollout
// boundaries; no expected result is computed from it (the results are the client's).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(s: string): number {
  let c = 0xffffffff;
  for (const b of new TextEncoder().encode(s)) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Boolean threshold bucket (engine: crc32(entityId + flagKey) % 100). */
const boolBucket = (flagKey: string, entityId: string) => crc32(entityId + flagKey) % 100;
/** Variant distribution bucket (engine: crc32(flagKey + entityId) % 1000). */
const variantBucket = (flagKey: string, entityId: string) => crc32(flagKey + entityId) % 1000;

/** The first `n` numeric user ids whose bucket is `target`. */
function idsInBucket(bucket: (id: string) => number, target: number, n: number): string[] {
  const out: string[] = [];
  for (let id = 1; out.length < n && id < 1_000_000; id++) {
    if (bucket(String(id)) === target) out.push(String(id));
  }
  if (out.length < n) throw new Error(`no user id lands in bucket ${target}`);
  return out;
}

/**
 * Bucket edges of a distribution list under BOTH formulas the engine has shipped: cumulative
 * truncated tenths (0.2.0), and rollouts normalised to their sum, rounded, with the last edge
 * pinned to 1000 (0.4.0+). Inputs on either side of either edge are where two engines can differ.
 */
function distributionEdges(rollouts: number[]): number[] {
  const valid = rollouts.filter((r) => r > 0).map((r) => Math.fround(r));
  const edges = new Set<number>();
  let truncated = 0;
  for (const r of valid) {
    truncated += Math.trunc(Math.fround(r * 10));
    edges.add(truncated);
  }
  const total = valid.reduce((a, b) => a + b, 0);
  let cumulative = 0;
  valid.forEach((r, i) => {
    cumulative += (r / total) * 100;
    edges.add(i === valid.length - 1 ? 1000 : Math.round(cumulative * 10));
  });
  return [...edges];
}

type Persona = {
  label: string;
  user: FliptTargetUser | null;
  extra?: Record<string, string>;
  deploymentId?: string;
};

// Shapes the Node app actually sends: every one goes through the real buildFliptContext.
const PERSONAS: Persona[] = [
  { label: 'anonymous', user: null },
  { label: 'free-42', user: { id: 42, tier: 'free' } },
  { label: 'no-tier-1001', user: { id: 1001 } },
  { label: 'gold-7', user: { id: 7, tier: 'gold' } },
  { label: 'silver-999', user: { id: 999, tier: 'silver' } },
  { label: 'bronze-1000', user: { id: 1000, tier: 'bronze' } },
  { label: 'moderator-123456', user: { id: 123456, isModerator: true } },
  { label: 'moderator-gold-5', user: { id: 5, isModerator: true, tier: 'gold' } },
  { label: 'early-adopter-77', user: { id: 77, isEarlyAdopter: true } },
  { label: 'app-builder-88', user: { id: 88, appBuilderApproved: true } },
  { label: 'creator-99', user: { id: 99 }, extra: { isInCreatorProgram: 'true' } },
  { label: 'not-creator-100', user: { id: 100 }, extra: { isInCreatorProgram: 'false' } },
  { label: 'canary-2024', user: { id: 2024 }, deploymentId: 'canary-3' },
  { label: 'stable-2025', user: { id: 2025, tier: 'silver' }, deploymentId: 'stable-1' },
  { label: 'string-id-31337', user: { id: '31337', tier: 'gold' } },
];

// Contexts that do NOT come from buildFliptContext: missing keys and type edge cases (the engine
// parses BOOLEAN and NUMBER constraints from these strings).
const RAW_CONTEXTS: { label: string; context: Record<string, string> }[] = [
  { label: 'empty', context: {} },
  { label: 'logged-in-only', context: { isLoggedIn: 'true' } },
  { label: 'moderator-True', context: { userId: '555', isModerator: 'True', isLoggedIn: 'true' } },
  { label: 'moderator-TRUE', context: { userId: '556', isModerator: 'TRUE', isLoggedIn: 'true' } },
  { label: 'moderator-1', context: { userId: '557', isModerator: '1', isLoggedIn: 'true' } },
  { label: 'moderator-yes', context: { userId: '558', isModerator: 'yes', isLoggedIn: 'true' } },
  {
    label: 'moderator-space',
    context: { userId: '559', isModerator: ' true', isLoggedIn: 'true' },
  },
  { label: 'moderator-empty', context: { userId: '560', isModerator: '', isLoggedIn: 'true' } },
  {
    label: 'moderator-false',
    context: { userId: '561', isModerator: 'false', isLoggedIn: 'true' },
  },
  {
    label: 'tier-Gold',
    context: { userId: '562', tier: 'Gold', isLoggedIn: 'true', isMember: 'true' },
  },
  { label: 'tier-empty', context: { userId: '563', tier: '', isLoggedIn: 'true' } },
  { label: 'userId-abc', context: { userId: 'abc', isLoggedIn: 'true' } },
  { label: 'userId-negative', context: { userId: '-5', isLoggedIn: 'true' } },
  { label: 'userId-leading-zeros', context: { userId: '0042', isLoggedIn: 'true' } },
  { label: 'userId-plus', context: { userId: '+7', isLoggedIn: 'true' } },
  { label: 'userId-exponent', context: { userId: '1e3', isLoggedIn: 'true' } },
  { label: 'userId-decimal', context: { userId: '999.5', isLoggedIn: 'true' } },
  { label: 'userId-overflow', context: { userId: '2147483648', isLoggedIn: 'true' } },
  { label: 'creator-anonymous', context: { isInCreatorProgram: 'true', isLoggedIn: 'false' } },
  {
    label: 'app-builder-TRUE',
    context: { userId: '564', appBuilderApproved: 'TRUE', isLoggedIn: 'true' },
  },
  { label: 'deployment-only', context: { deploymentId: 'canary' } },
];

function personaContext(p: Persona): Record<string, string> {
  const before = process.env.FLIPT_DEPLOYMENT_ID;
  if (p.deploymentId) process.env.FLIPT_DEPLOYMENT_ID = p.deploymentId;
  else delete process.env.FLIPT_DEPLOYMENT_ID;
  try {
    return { ...buildFliptContext(p.user, p.extra) };
  } finally {
    if (before === undefined) delete process.env.FLIPT_DEPLOYMENT_ID;
    else process.env.FLIPT_DEPLOYMENT_ID = before;
  }
}

/** The app's entity id: the user id, else 'anonymous'. */
const entityFor = (context: Record<string, string>) => context.userId ?? 'anonymous';

function buildCorpus(): ParityCase[] {
  const flags = snapshot.flags as SnapshotFlag[];
  const rand = mulberry32(0x5eed2026);
  const cases: ParityCase[] = [];
  const add = (kind: Kind, flagKey: string, label: string, context: Record<string, string>) =>
    cases.push({
      id: `${flagKey}|${kind}|${label}`,
      kind,
      flagKey,
      entityId: entityFor(context),
      context,
    });

  const randomShapes: ((id: number) => FliptTargetUser)[] = [
    (id) => ({ id, tier: 'free' }),
    (id) => ({ id, tier: 'gold' }),
    (id) => ({ id, isEarlyAdopter: true }),
    (id) => ({ id, isModerator: true }),
  ];

  for (const flag of flags) {
    const kind: Kind = flag.type === 'BOOLEAN_FLAG_TYPE' ? 'boolean' : 'variant';
    for (const p of PERSONAS) add(kind, flag.key, p.label, personaContext(p));
    for (const r of RAW_CONTEXTS) add(kind, flag.key, `raw-${r.label}`, r.context);
    randomShapes.forEach((shape, i) => {
      const id = 1 + Math.floor(rand() * 10_000_000);
      add(kind, flag.key, `random-${i}-${id}`, personaContext({ label: '', user: shape(id) }));
    });

    // Entity ids on each side of every rollout boundary, as a logged-in free user (who reaches the
    // threshold rollouts and the catch-all rules of every flag here).
    const targets = new Set<number>();
    let bucket: (id: string) => number;
    if (kind === 'boolean') {
      bucket = (id) => boolBucket(flag.key, id);
      for (const r of flag.rollouts ?? []) {
        if (!r.threshold) continue;
        const edge = Math.ceil(r.threshold.percentage);
        for (const t of [0, 99, edge - 1, edge]) if (t >= 0 && t <= 99) targets.add(t);
      }
    } else {
      bucket = (id) => variantBucket(flag.key, id);
      for (const rule of flag.rules ?? []) {
        if (rule.distributions.length < 2) continue;
        for (const e of distributionEdges(rule.distributions.map((d) => d.rollout))) {
          // e + 1 too: the 0.4.0+ edges are computed here in f64, the engine's in f32.
          for (const t of [0, 999, e - 1, e, e + 1]) if (t >= 0 && t <= 999) targets.add(t);
        }
      }
    }
    for (const t of [...targets].sort((a, b) => a - b)) {
      for (const id of idsInBucket(bucket, t, 2)) {
        add(
          kind,
          flag.key,
          `bucket-${t}-${id}`,
          personaContext({ label: '', user: { id, tier: 'free' } })
        );
      }
    }
  }

  // Errors: the wrong evaluation for a flag's type, and a flag that does not exist.
  const free = personaContext({ label: '', user: { id: 42, tier: 'free' } });
  add('boolean', 'variant-50-50', 'wrong-type', free);
  add('variant', 'bool-threshold-25', 'wrong-type', free);
  add('boolean', 'missing-flag', 'not-found', free);
  add('variant', 'missing-flag', 'not-found', free);
  return cases;
}

// ── test ─────────────────────────────────────────────────────────────────────────────────────

async function initClient(data: unknown): Promise<FliptNodeClient> {
  // No `updateInterval`, so the client never polls; the fetcher is the one the package uses for a
  // snapshot-seeded client, so nothing reaches the network.
  return (await FliptClient.init({
    fetcher: createSnapshotFetcher(data),
  })) as unknown as FliptNodeClient;
}

describe('Node <-> Go Flipt parity (Node half)', () => {
  let client: FliptNodeClient;
  const corpus = buildCorpus();

  beforeAll(async () => {
    client = await initClient(snapshot);
  });
  afterAll(() => client?.close());

  it('the corpus is large, deterministic and unique', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(200);
    expect(new Set(corpus.map((c) => c.id)).size).toBe(corpus.length);
    expect(buildCorpus()).toEqual(corpus);
  });

  it('evaluates the corpus to exactly the checked-in expected results', () => {
    const cases = corpus.map((c) => ({ ...c, result: evaluateCase(client, c) }));

    // Positive controls: the instrument sees real, varied outcomes rather than one constant.
    const results = cases.map((c) => c.result as Record<string, unknown>);
    expect(results.some((r) => r.enabled === true)).toBe(true);
    expect(results.some((r) => r.enabled === false)).toBe(true);
    expect(results.some((r) => r.error === true)).toBe(true);
    const variants = new Set(results.filter((r) => r.match === true).map((r) => r.variantKey));
    expect(variants.size).toBeGreaterThanOrEqual(10);

    const header = {
      description:
        'Node <-> Go Flipt parity corpus: each case evaluated by the pinned Node client against snapshot.json. ' +
        'Generated by packages/civitai-flipt/src/__tests__/parity.test.ts; asserted by that test and by parity/go.',
      regenerate:
        'FLIPT_PARITY_WRITE=1 pnpm --filter @civitai/flipt exec vitest run src/__tests__/parity.test.ts',
      clients: { js: installedJsClientVersion(), go: GO_CLIENT },
      snapshot: 'snapshot.json',
      caseCount: cases.length,
    };
    const text = formatLines(header, 'cases', cases);

    if (process.env.FLIPT_PARITY_WRITE === '1') {
      writeFileSync(expectedPath, text);
      return;
    }

    const blob = () =>
      console.log(
        `FLIPT-PARITY-EXPECTED-BEGIN ${gzipSync(text).toString('base64')} FLIPT-PARITY-EXPECTED-END`
      );
    if (!existsSync(expectedPath)) {
      blob();
      throw new Error(`${expectedPath} is missing; regenerate it (see this file's header)`);
    }
    const want = JSON.parse(readFileSync(expectedPath, 'utf8'));
    const wantById = new Map<string, unknown>(want.cases.map((c: { id: string }) => [c.id, c]));
    const changed = cases.filter((c) => !sameResult(wantById.get(c.id), c)).map((c) => c.id);
    const removed = [...wantById.keys()].filter((id) => !cases.some((c) => c.id === id));
    if (changed.length || removed.length || !sameResult(want, JSON.parse(text))) {
      blob();
    }
    expect({ changed: changed.slice(0, 20), removed: removed.slice(0, 20) }).toEqual({
      changed: [],
      removed: [],
    });
    // The header too: it records the client versions the Go half checks itself against.
    expect(canonical(JSON.parse(text))).toEqual(canonical(want));
  });

  // Negative control: the comparison can go red. A one-flag change to the snapshot must move the
  // results of exactly that flag's cases.
  it('a changed snapshot changes the results (the comparison is not blind)', async () => {
    const mutated = structuredClone(snapshot);
    const flag = mutated.flags.find((f: { key: string }) => f.key === 'bool-enabled-no-rules');
    flag.enabled = false;
    const other = await initClient(mutated);
    try {
      const moved = corpus.filter(
        (c) => !sameResult(evaluateCase(client, c), evaluateCase(other, c))
      );
      expect(moved.length).toBeGreaterThan(0);
      expect(new Set(moved.map((c) => c.flagKey))).toEqual(new Set(['bool-enabled-no-rules']));
    } finally {
      other.close();
    }
  });
});
