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
  it("uses the creator's pick, even off that currency's site", async () => {
    await create({ buzzType: 'green' }, false);
    expect(chargedIn()).toBe('green');

    await create({ buzzType: 'yellow' }, true);
    expect(chargedIn()).toBe('yellow');
  });

  it("falls back to the site's currency when none is picked", async () => {
    await create({}, true);
    expect(chargedIn()).toBe('green');

    await create({}, false);
    expect(chargedIn()).toBe('yellow');
  });

  it('accepts only green or yellow', () => {
    expect(createCrucibleInputBaseSchema.shape.buzzType.safeParse('green').success).toBe(true);
    expect(createCrucibleInputBaseSchema.shape.buzzType.safeParse('blue').success).toBe(false);
  });
});
