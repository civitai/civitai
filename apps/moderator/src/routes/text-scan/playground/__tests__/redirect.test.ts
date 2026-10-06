import { describe, expect, it } from 'vitest';
import { load } from '../+page.server';

describe('/text-scan/playground', () => {
  it('redirects to Check keeping the query', async () => {
    const event = { url: new URL('http://x/text-scan/playground?draft=3') } as Parameters<
      typeof load
    >[0];
    await expect(Promise.resolve().then(() => load(event))).rejects.toMatchObject({
      status: 307,
      location: '/text-scan/check?draft=3',
    });
  });
});
