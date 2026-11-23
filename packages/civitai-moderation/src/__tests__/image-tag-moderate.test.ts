import { describe, expect, it } from 'vitest';
import { createModeratorClient, imageTagModerateInput, MOD_ACTION } from '../index';

const valid = { imageId: 10, tagId: 20, disable: true, userId: 30, settledAtMinimum: true };

describe('image-tag-moderate contract', () => {
  it('accepts a write-back and refuses one without a player or with an out-of-range id', () => {
    expect(imageTagModerateInput.safeParse(valid).success).toBe(true);
    const { userId: _userId, ...noPlayer } = valid;
    expect(imageTagModerateInput.safeParse(noPlayer).success).toBe(false);
    expect(imageTagModerateInput.safeParse({ ...valid, tagId: 2 ** 31 }).success).toBe(false);
    expect(imageTagModerateInput.safeParse({ ...valid, disable: 'yes' }).success).toBe(false);
  });

  it('posts to the action path and returns the outcome; an answer it cannot read throws', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const answer = (result: unknown) =>
      createModeratorClient({
        endpoint: 'http://mod.test/',
        token: 't',
        fetch: async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return Response.json({ ok: true, result });
        },
      });
    expect(await answer({ outcome: 'already-ruled' }).imageTagModerate(valid)).toEqual({
      outcome: 'already-ruled',
    });
    expect(calls[0]).toEqual({
      url: `http://mod.test/api/mod/${MOD_ACTION.imageTagModerate}`,
      body: valid,
    });
    await expect(answer({ outcome: 'done' }).imageTagModerate(valid)).rejects.toThrow();
  });
});
