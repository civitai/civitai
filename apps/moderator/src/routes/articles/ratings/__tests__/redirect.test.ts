import { describe, expect, it } from 'vitest';
import { load } from '../+page.server';

const at = (path: string) => ({ url: new URL(`http://x${path}`) } as never);

describe('/articles/ratings redirect', () => {
  it('lands on the Articles tab and keeps the other params', async () => {
    await expect(
      Promise.resolve().then(() => load(at('/articles/ratings?status=Actioned&q=bob')))
    ).rejects.toMatchObject({
      status: 307,
      location: '/ratings?status=Actioned&q=bob&tab=articles',
    });
  });
});
