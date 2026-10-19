import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Granting a mystery box and taking a granted one back are bound to `items.boxes.grant` through the
 * REAL `requiresGrant`: a moderator who may grant cosmetics may not hand out boxes.
 */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { grantMysteryBoxes, takeBackGrantedBox } = vi.hoisted(() => ({
  grantMysteryBoxes: vi.fn(async () => ({
    grantedUserIds: [8675309],
    alreadyGrantedUserIds: [] as number[],
    busyUserIds: [] as number[],
    failedUserIds: [] as number[],
  })),
  takeBackGrantedBox: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock('$lib/server/mystery-box-grant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/mystery-box-grant.service')>()),
  grantMysteryBoxes,
}));
vi.mock('$lib/server/user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/user-actions.service')>()),
  takeBackGrantedBox,
}));

const { actions } = await import('../+page.server');

const TARGET = 8675309;
const MODERATOR = 990000007;

const formEvent = (grants: Record<string, boolean>, fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: MODERATOR }, grants },
  } as unknown as Parameters<(typeof actions)['grantBox']>[0];
};
const grantFields = { userId: String(TARGET), boxId: '3', count: '2', grantId: 'abc123' };

beforeEach(() => vi.clearAllMocks());

describe('grantBox action', () => {
  it('refuses a moderator who may only grant cosmetics', async () => {
    const result = await actions.grantBox(formEvent({ 'user.cosmetics.grant': true }, grantFields));
    expect(result).toMatchObject({ status: 403, data: { scope: 'denied' } });
    expect(grantMysteryBoxes).not.toHaveBeenCalled();
  });

  it('grants to this user alone, as the acting moderator', async () => {
    const result = await actions.grantBox(formEvent({ 'items.boxes.grant': true }, grantFields));
    expect(result).toEqual({ success: true });
    expect(grantMysteryBoxes).toHaveBeenCalledWith({
      boxId: 3,
      userIds: [TARGET],
      count: 2,
      grantId: 'abc123',
      moderatorId: MODERATOR,
    });
  });

  it('is a failure, not a success, when the user was busy, failed, or the form was already used', async () => {
    grantMysteryBoxes.mockResolvedValueOnce({
      grantedUserIds: [],
      alreadyGrantedUserIds: [],
      busyUserIds: [TARGET],
      failedUserIds: [],
    });
    expect(
      await actions.grantBox(formEvent({ 'items.boxes.grant': true }, grantFields))
    ).toMatchObject({ status: 400, data: { scope: 'shop' } });

    grantMysteryBoxes.mockResolvedValueOnce({
      grantedUserIds: [],
      alreadyGrantedUserIds: [TARGET],
      busyUserIds: [],
      failedUserIds: [],
    });
    expect(
      await actions.grantBox(formEvent({ 'items.boxes.grant': true }, grantFields))
    ).toMatchObject({ status: 400, data: { scope: 'shop' } });

    grantMysteryBoxes.mockResolvedValueOnce({
      grantedUserIds: [],
      alreadyGrantedUserIds: [],
      busyUserIds: [],
      failedUserIds: [TARGET],
    });
    expect(
      await actions.grantBox(formEvent({ 'items.boxes.grant': true }, grantFields))
    ).toMatchObject({ status: 400, data: { scope: 'shop' } });
  });
});

describe('takeBackGrantedBox action', () => {
  const fields = { userId: String(TARGET), sourceKey: `mod-grant-abc123-${TARGET}-1` };

  it('refuses a moderator who may only grant cosmetics', async () => {
    const result = await actions.takeBackGrantedBox(
      formEvent({ 'user.cosmetics.grant': true }, fields)
    );
    expect(result).toMatchObject({ status: 403, data: { scope: 'denied' } });
    expect(takeBackGrantedBox).not.toHaveBeenCalled();
  });

  it('takes it back with the grant, as the acting moderator', async () => {
    const result = await actions.takeBackGrantedBox(
      formEvent({ 'items.boxes.grant': true }, fields)
    );
    expect(result).toEqual({ success: true, warning: undefined });
    expect(takeBackGrantedBox).toHaveBeenCalledWith({
      userId: TARGET,
      sourceKey: fields.sourceKey,
      moderatorId: MODERATOR,
    });
  });
});
