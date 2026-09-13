import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

/**
 * Shared harness for the two suites that exercise the REAL Flipt client against a
 * REAL evaluation snapshot — `app-blocks-flag.real-flipt-client.integration.test.ts`
 * (production shapes, base OFF) and `app-blocks-flag.base-enabled-flip.test.ts`
 * (the same shapes re-keyed with base ON).
 *
 * It exists because those two suites were byte-for-byte duplicating the server, the
 * env plumbing and the request ledger. The instrument is the same in both; only the
 * snapshot served differs. A snapshot cannot be shared between them — the base-false
 * and base-true cases assign opposite values to `app-blocks-enabled` — so the
 * SERVER is the shared part, not the fixture.
 */

/** The path the Flipt v2 client fetches its evaluation snapshot from. */
export const SNAPSHOT_PATH = '/internal/v1/evaluation/snapshot/namespace/default';

export type FliptFixtureServer = {
  /** Base URL the client should be pointed at. */
  url: string;
  /** Every request the fake Flipt received — the instrument control. */
  received: { url: string; environment?: string; auth?: string }[];
  close: () => Promise<void>;
};

/**
 * Start a localhost server that serves `snapshot` at {@link SNAPSHOT_PATH} and 404s
 * everything else. Port 0, so parallel suites cannot collide.
 */
export async function startFliptFixtureServer(snapshot: unknown): Promise<FliptFixtureServer> {
  const received: FliptFixtureServer['received'] = [];
  const server: Server = createServer((req, res) => {
    received.push({
      url: req.url ?? '',
      environment: req.headers['x-flipt-environment'] as string | undefined,
      auth: req.headers.authorization as string | undefined,
    });
    if (!req.url?.startsWith(SNAPSHOT_PATH)) {
      res.writeHead(404).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(snapshot));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The body of each suite's `vi.mock('~/server/flipt/client', …)` factory.
 *
 * Substitutes ONLY the app's env plumbing (`~/env/server` is not loadable in a unit
 * run): the returned `isFlipt` is a REAL `createFliptClient` instance pointed at the
 * fixture server. Everything a defect could live in — the client factory, its cache,
 * the wasm engine, the segment matcher — stays production code.
 *
 * The URL is read from an env var rather than passed, because `vi.mock` factories are
 * hoisted above every other statement in the file; the suite writes the var in
 * `beforeAll`, which still runs before the first `await import(…)`.
 */
export async function buildRealFliptClientMock(urlEnvVar: string) {
  const { createFliptClient } = await import('@civitai/flipt');
  const flipt = createFliptClient({
    url: process.env[urlEnvVar] as string,
    clientToken: 'test-token',
    environment: 'civitai-app',
    log: () => undefined,
    onInitError: (e) => {
      throw e;
    },
  });
  return {
    isFlipt: flipt.isEnabled,
    isFliptSync: flipt.isEnabledSync,
    getFliptVariant: flipt.getVariant,
    getFliptBoolean: flipt.getBoolean,
    ensureFliptInitialized: flipt.ensureInitialized,
  };
}

type SnapshotFlag = { key: string; enabled: boolean; [k: string]: unknown };
type Snapshot = { namespace: unknown; flags: SnapshotFlag[]; digest?: unknown };

/**
 * Derive a snapshot by copying ONE flag's shape out of `source` under new keys with
 * chosen base `enabled` values.
 *
 * 🔴 DERIVED, NEVER HAND-WRITTEN. The base-true case needs the production flag SHAPE
 * (base + a `SEGMENT_ROLLOUT_TYPE` whose `OR_SEGMENT_OPERATOR` combines the segments)
 * with only `enabled` changed. A second checked-in fixture would be a copy that
 * cannot track the original: the source fixture's own docblock says re-capturing it
 * means re-anonymising it, so a hand-edited twin silently keeps the old segment shape
 * while still claiming production fidelity — it already lagged a segment by the time
 * this was written. Copying at runtime makes a re-capture propagate to both suites.
 */
export function deriveSnapshotFromFlagShape(
  source: Snapshot,
  templateKey: string,
  flags: { key: string; enabled: boolean }[]
): Snapshot {
  const template = source.flags.find((f) => f.key === templateKey);
  if (!template) {
    throw new Error(
      `deriveSnapshotFromFlagShape: no flag '${templateKey}' in the source snapshot ` +
        `(has: ${source.flags.map((f) => f.key).join(', ')})`
    );
  }
  const rollouts = (template as { rollouts?: { type?: unknown }[] }).rollouts;
  // 🔴 ASSERT THE ROLLOUT *TYPE*, not merely that some rollout exists. The sentence
  // this guard enforces is "models a SEGMENT-rolled-out flag", and three weaker tests
  // all pass while that sentence is false:
  //   - no `rollouts` key at all → a base-`true` flag with no rollouts is an honest
  //     global on-switch: a different shape and a different claim;
  //   - an EMPTY array → same, while passing `Array.isArray`;
  //   - a THRESHOLD (percentage) rollout → the shape `APP_LISTINGS_PUBLIC_EXTERNAL_FLAG`
  //     names as live and hazardous. If the sibling snapshot is ever re-captured with
  //     one, a length check still passes and the base-true suite quietly stops
  //     measuring the segment case — and a 100% threshold would sail past the
  //     `base-false-control` backstop too, because that control would also be `true`.
  // Every `true` in the consuming suite is attributable to the base value only if the
  // template really carries a segment rollout, so that is what gets checked.
  if (!Array.isArray(rollouts) || !rollouts.some((r) => r?.type === 'SEGMENT_ROLLOUT_TYPE')) {
    throw new Error(
      `deriveSnapshotFromFlagShape: template flag '${templateKey}' carries no ` +
        `SEGMENT_ROLLOUT_TYPE rollout — the derived snapshot would not model a ` +
        `segment-rolled-out flag at all`
    );
  }
  return {
    namespace: source.namespace,
    flags: flags.map(({ key, enabled }) => ({
      ...(structuredClone(template) as SnapshotFlag),
      key,
      enabled,
    })),
    digest: 'derived-from-' + templateKey,
  };
}
