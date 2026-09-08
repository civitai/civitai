import type { NextApiResponse } from 'next';
import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  IMAGE_UPLOAD_RELAY_METRIC,
  IMAGE_UPLOAD_RELAY_OUTCOMES,
} from '~/server/prom/image-upload-relay.metrics';

/**
 * 🔴 THE SEAM: the image-upload relay's usage counter is registered in ONE module and
 * seeded from ANOTHER, and neither half works alone.
 *
 * `image-upload-relay.metrics.ts` seeds all eleven outcome series at 0 on registration.
 * But prom-client materialises a child only on its first `inc()`, and Next.js loads an
 * API route lazily — so nothing evaluates that module on a pod until something calls
 * into it. For this counter that is the relay route itself, which is a FALLBACK that
 * fires for the handful of clients who cannot reach the storage host at all. On nearly
 * every pod it never runs.
 *
 * So without the explicit `ensureRegisterImageUploadRelayMetrics()` call in
 * `src/pages/api/metrics.ts`, a scrape returns NO relay series at all, PromQL answers
 * `no data`, and that is indistinguishable from "the instrument was never wired" — the
 * exact ambiguity this counter was added to remove, since the question it exists to
 * settle is "has this fallback ever rescued anyone?".
 *
 * Neither the metrics module's own unit test nor the route's suite can see this: both
 * import the module directly, which registers it. Only a scrape of the real endpoint,
 * with no relay having occurred, exercises the seam. This is the surface nobody owns.
 *
 * Mock setup below mirrors metrics-endpoint-registry-failure.test.ts — see its notes;
 * the same module-load hazards apply and the reasons have not been restated here.
 */

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
}));

const poolStub = () => ({ totalCount: 0, idleCount: 0, waitingCount: 0 });
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: poolStub(),
  pgDbWrite: poolStub(),
  pgDbReadLong: poolStub(),
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: poolStub() }));

type Handler = (req: unknown, res: NextApiResponse) => Promise<void> | void;

function fakeRes() {
  const state = { body: '', headers: {} as Record<string, string> };
  const res = {
    setHeader: (key: string, value: string) => {
      state.headers[key] = value;
    },
    send: (body: string) => {
      state.body = body;
    },
  } as unknown as NextApiResponse;
  return { res, state };
}

async function scrape(): Promise<string> {
  const mod = await import('~/pages/api/metrics');
  const handler = mod.default as unknown as Handler;
  const { res, state } = fakeRes();
  await handler({}, res);
  return state.body;
}

beforeEach(() => {
  dbMock.dbRead.$metrics.prometheus.mockResolvedValue('');
  dbMock.dbWrite.$metrics.prometheus.mockResolvedValue('');
});

describe('/api/metrics seeds the image-upload relay counter', () => {
  it('POSITIVE CONTROL: the scrape produces a non-empty body carrying other metrics', async () => {
    // Without this, every assertion below could be satisfied by a handler that returns
    // an empty string and a `toContain` that was never going to match anything real —
    // a zero indistinguishable from a probe wired to nothing.
    const body = await scrape();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/process_cpu_user_seconds_total|nodejs_/);
  });

  it('🔴 exposes ALL eleven outcome series at 0 on a pod where no relay has ever run', async () => {
    const body = await scrape();
    expect(body).toContain(IMAGE_UPLOAD_RELAY_METRIC);
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      // The exact exposition line, value included: presence alone would be satisfied by
      // the HELP/TYPE header lines, which prom-client emits for a metric with no
      // children at all — i.e. by exactly the unseeded state this guards against.
      expect(body, `outcome=${outcome} must be exposed at 0`).toContain(
        `${IMAGE_UPLOAD_RELAY_METRIC}{outcome="${outcome}"} 0`
      );
    }
  });

  it('renders it on the DEFAULT registry block, which is the one the scrape serves', async () => {
    // A counter on some other registry would still be a real counter and would still
    // pass a "the module exports it" check — and would be scraped by nothing.
    expect(client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC)).toBeDefined();
    const body = await scrape();
    const rendered = await client.register.metrics();
    expect(rendered).toContain(IMAGE_UPLOAD_RELAY_METRIC);
    expect(body).toContain(IMAGE_UPLOAD_RELAY_METRIC);
  });
});
