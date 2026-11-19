import type { NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The host-media safety counters are incremented only on a refusal or a degraded decision,
 * which most pods never see. Only a scrape of the real endpoint shows whether a pod that has
 * never refused anything still exposes them at 0. Mock setup mirrors
 * metrics-endpoint-image-upload-relay-seeding.test.ts.
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

async function scrape(): Promise<string> {
  const mod = await import('~/pages/api/metrics');
  const handler = mod.default as unknown as Handler;
  let body = '';
  const res = {
    setHeader: () => undefined,
    send: (b: string) => {
      body = b;
    },
  } as unknown as NextApiResponse;
  await handler({}, res);
  return body;
}

beforeEach(() => {
  dbMock.dbRead.$metrics.prometheus.mockResolvedValue('');
  dbMock.dbWrite.$metrics.prometheus.mockResolvedValue('');
});

describe('/api/metrics publishes the host-media safety counters at 0', () => {
  it('POSITIVE CONTROL: the scrape carries other metrics', async () => {
    expect(await scrape()).toMatch(/process_cpu_user_seconds_total|nodejs_/);
  });

  it.each([
    ['civitai_app_block_media_serving_degraded_total', 'reason', 'eval_failed'],
    ['civitai_app_block_media_serving_degraded_total', 'reason', 'no_session'],
    ['civitai_app_block_media_input_refused_total', 'phase', 'estimate'],
    ['civitai_app_block_media_input_refused_total', 'phase', 'submit'],
    ['civitai_app_block_unlock_charged_not_released_total', 'read_back', 'ok'],
    ['civitai_app_block_unlock_charged_not_released_total', 'read_back', 'failed'],
  ])('%s{%s="%s"} is exposed at 0 on a pod that never fired it', async (name, label, value) => {
    expect(await scrape()).toMatch(
      new RegExp(`^${name}\\{[^}]*\\b${label}="${value}"[^}]*\\} 0$`, 'm')
    );
  });
});
