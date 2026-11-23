import { describe, expect, it } from 'vitest';
import { studioServerCalls } from '$lib/studio-server-calls';
import { DATASET_TOO_LARGE_MESSAGE } from '$lib/submit-limits';

const startWith = (res: Response) => studioServerCalls(async () => res).submitTraining([]);

describe('submitTraining when the server refuses', () => {
  it('names a body too large for a proxy in front of the Studio, which sends no message', async () => {
    await expect(
      startWith(new Response('Body exceeded 16mb limit', { status: 413 }))
    ).rejects.toThrow(DATASET_TOO_LARGE_MESSAGE);
  });

  it("keeps the Studio's own message on a 413 that carries one", async () => {
    await expect(
      startWith(Response.json({ message: 'from the Studio' }, { status: 413 }))
    ).rejects.toThrow('from the Studio');
  });

  it('control: another bare refusal still names its status', async () => {
    await expect(startWith(new Response('', { status: 500 }))).rejects.toThrow(
      'Training could not start (500)'
    );
  });
});
