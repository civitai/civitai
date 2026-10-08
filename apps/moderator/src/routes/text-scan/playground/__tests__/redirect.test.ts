import { describe, expect, it } from 'vitest';
import { load } from '../+page.server';

describe('/text-scan/playground', () => {
  it('redirects to Check', async () => {
    const event = { url: new URL('http://x/text-scan/playground') } as Parameters<typeof load>[0];
    await expect(Promise.resolve().then(() => load(event))).rejects.toMatchObject({
      status: 307,
      location: '/text-scan/check',
    });
  });
});
