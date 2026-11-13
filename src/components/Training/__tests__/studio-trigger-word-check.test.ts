import { describe, expect, it, vi } from 'vitest';
import { checkStudioTriggerWord } from '~/components/Training/studio-trigger-word-check';

/** How the embedded Studio's host page reads the trigger word check's answer: anything but an
 *  explicit verdict must stop the element from submitting. */

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const check = (fetchImpl: typeof fetch) =>
  checkStudioTriggerWord({ triggerWord: 'mystyle' }, fetchImpl);

describe('checkStudioTriggerWord', () => {
  it('passes an explicit ok', async () => {
    await expect(check(answer(200, { ok: true }))).resolves.toEqual({ ok: true });
  });

  it('turns a 400 into a refusal carrying the reason', async () => {
    await expect(check(answer(400, { message: 'blocked: x' }))).resolves.toEqual({
      ok: false,
      error: 'blocked: x',
    });
  });

  it.each([
    ['a 2xx without the verdict', 200, { something: 'else' }],
    ['a 401', 401, { error: 'Unauthorized' }],
    ['a 403', 403, { error: 'Restricted' }],
    ['a 500', 500, { message: 'Internal error' }],
  ])('rejects %s rather than passing it', async (_l, status, body) => {
    await expect(check(answer(status, body))).rejects.toThrow();
  });

  it('rejects when the request itself fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(check(fetchImpl)).rejects.toThrow();
  });
});
