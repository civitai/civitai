import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

/** The Studio's dataset-rating endpoint runs free GPU work: it must sit behind the Studio gate and
 *  refuse an oversized batch before anything is submitted. */

const service = vi.hoisted(() => ({
  rate: vi.fn<(input: unknown) => Promise<{ results: never[] }>>(async () => ({ results: [] })),
}));
vi.mock('~/server/services/training-studio-dataset-rating.service', () => ({
  rateStudioDatasetImages: service.rate,
}));
const gate = vi.hoisted(() => ({ allow: vi.fn() }));
vi.mock('~/server/utils/training-studio-access', () => ({ allowTrainingStudio: gate.allow }));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  handleEndpointError: (await importOriginal<typeof EndpointHelpers>()).handleEndpointError,
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, user: { id: number }) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, { id: 7 }),
}));

import handler from '~/pages/api/training-studio/dataset-rating';
import { STUDIO_DATASET_RATING_BATCH } from '~/server/schema/training-studio-dataset-rating.schema';

const item = (i: number) => ({
  mediaUrl: `https://orchestration.civitai.com/v2/consumer/blobs/${i}.png`,
  key: `${i}.png`,
});

async function call(body: unknown) {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  await (handler as unknown as (req: unknown, r: typeof res) => Promise<unknown>)(
    { method: 'POST', query: {}, body },
    res
  );
  return res;
}

describe('POST /api/training-studio/dataset-rating', () => {
  beforeEach(() => {
    service.rate.mockClear();
    gate.allow.mockReset().mockResolvedValue(true);
  });

  it('rates for the session user', async () => {
    const res = await call({ items: [item(1)] });
    expect(res.statusCode).toBe(200);
    expect(service.rate).toHaveBeenCalledWith({ items: [item(1)], userId: 7 });
  });

  it('a user the Studio gate refuses rates nothing', async () => {
    gate.allow.mockResolvedValue(false);
    await call({ items: [item(1)] });
    expect(service.rate).not.toHaveBeenCalled();
  });

  it('refuses a batch over the cap with 0 submits', async () => {
    const items = Array.from({ length: STUDIO_DATASET_RATING_BATCH + 1 }, (_, i) => item(i));
    const res = await call({ items });
    expect(res.statusCode).toBe(400);
    expect(service.rate).not.toHaveBeenCalled();
  });
});
