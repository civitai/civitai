import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrucibleInputBaseSchema } from '~/server/schema/crucible.schema';
import type * as CrucibleService from '~/server/services/crucible.service';

const { createCrucible } = vi.hoisted(() => ({ createCrucible: vi.fn() }));

vi.mock('~/server/services/crucible.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleService>()),
  createCrucible,
}));

const { createCrucibleHandler } = await import('~/server/controllers/crucible.controller');

const create = (input: Record<string, unknown>, isGreen: boolean) =>
  createCrucibleHandler({
    input: input as never,
    ctx: { user: { id: 7, isModerator: false }, features: { isGreen } } as never,
  });
const chargedIn = () => createCrucible.mock.calls.at(-1)![0].buzzType;

beforeEach(() => {
  createCrucible.mockReset();
  createCrucible.mockResolvedValue({ id: 1 });
});

describe('creating a crucible — Buzz type', () => {
  // The creator pays setup and seed in the site's currency; there is no per-crucible choice.
  it("charges the creator in the site's currency, whatever the request names", async () => {
    await create({ buzzType: 'yellow' }, true);
    expect(chargedIn()).toBe('green');

    await create({ buzzType: 'green' }, false);
    expect(chargedIn()).toBe('yellow');
  });

  it('no longer accepts a Buzz type on the input', () => {
    expect('buzzType' in createCrucibleInputBaseSchema.shape).toBe(false);
  });
});
