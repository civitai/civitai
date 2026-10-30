import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordShown, settleShown } from '../csam-shown';

const shown = { imageId: 41, userId: 20, action: 'select', rendition: 'original' } as const;

afterEach(() => vi.unstubAllGlobals());

describe('settleShown', () => {
  it('waits for a row still being sent', async () => {
    let land!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((resolve) => (land = () => resolve(new Response(null)))))
    );
    recordShown(shown);
    let settled = false;
    const settling = settleShown(60_000).then(() => (settled = true));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    land();
    await settling;
    expect(settled).toBe(true);
  });

  it('stops waiting for a request that never answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined))
    );
    recordShown(shown);

    const stuck = new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1000));
    expect(await Promise.race([settleShown(20).then(() => 'settled'), stuck])).toBe('settled');
  });
});
