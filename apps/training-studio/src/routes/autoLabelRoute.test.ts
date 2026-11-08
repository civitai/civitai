import { describe, expect, it } from 'vitest';
import { AUTO_LABEL_UNAVAILABLE_CODE } from '$lib/autolabel-errors';
import { POST } from './api/auto-label/+server';

describe('standalone auto-label route', () => {
  it('refuses with a 503 marked as our own refusal, so the client can return the cap slot', async () => {
    const err = await Promise.resolve(POST({} as Parameters<typeof POST>[0])).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.body).toEqual({
      message: 'Auto-labeling is unavailable right now.',
      code: AUTO_LABEL_UNAVAILABLE_CODE,
    });
  });
});
