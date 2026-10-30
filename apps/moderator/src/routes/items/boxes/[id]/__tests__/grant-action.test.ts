import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The box page's bulk grant: bound to `items.boxes.grant` through the REAL `requiresGrant`, and the
 * pasted id list reaches the service as numbers, or not at all.
 */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { grantMysteryBoxes } = vi.hoisted(() => ({
  grantMysteryBoxes: vi.fn(async () => ({
    grantedUserIds: [11, 22, 33],
    alreadyGrantedUserIds: [] as number[],
    busyUserIds: [] as number[],
    failedUserIds: [] as number[],
  })),
}));
vi.mock('$lib/server/mystery-box-grant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/mystery-box-grant.service')>()),
  grantMysteryBoxes,
}));

const { actions } = await import('../+page.server');
const { BoxGrantRefused } = await import('$lib/server/mystery-box-grant.service');

const MODERATOR = 990000007;

const grantEvent = (grants: Record<string, boolean>, fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    params: { id: '7' },
    request: { formData: async () => data },
    locals: { user: { id: MODERATOR }, grants },
  } as unknown as Parameters<(typeof actions)['grant']>[0];
};
const GRANTER = { 'items.boxes.grant': true };
const fields = (userIds: string) => ({ userIds, count: '3', grantId: 'abc123' });

beforeEach(() => vi.clearAllMocks());

describe('grant action', () => {
  it('refuses a moderator who may only grant cosmetics', async () => {
    const result = await actions.grant(grantEvent({ 'user.cosmetics.grant': true }, fields('11')));
    expect(result).toMatchObject({ status: 403, data: { scope: 'denied' } });
    expect(grantMysteryBoxes).not.toHaveBeenCalled();
  });

  it('reads ids split by commas, spaces and new lines, and answers with what happened', async () => {
    const result = await actions.grant(grantEvent(GRANTER, fields(' 11, 22\n33 22')));
    expect(grantMysteryBoxes).toHaveBeenCalledWith({
      boxId: 7,
      userIds: [11, 22, 33],
      count: 3,
      grantId: 'abc123',
      moderatorId: MODERATOR,
    });
    // The count as posted, so the confirmation names what was granted, not what the field says now.
    expect(result).toEqual({
      scope: 'grant',
      count: 3,
      grantedUserIds: [11, 22, 33],
      alreadyGrantedUserIds: [],
      busyUserIds: [],
      failedUserIds: [],
    });
  });

  it.each([
    ['an id that is not a number', '11, bob', 'Not a user id: bob'],
    ['an id past int4', '11 2147483648', 'Not a user id: 2147483648'],
    ['no ids', ' ,\n ', 'Name at least one user id.'],
    ['more than 500 ids', Array.from({ length: 501 }, (_, i) => i + 1).join(','), 'At most 500'],
  ])('refuses %s before granting anything', async (_, userIds, message) => {
    const result = await actions.grant(grantEvent(GRANTER, fields(userIds)));
    expect(result).toMatchObject({ status: 400, data: { scope: 'grant' } });
    expect((result as { data: { error: string } }).data.error).toContain(message);
    expect(grantMysteryBoxes).not.toHaveBeenCalled();
  });

  // A throw renders the error page, which unmounts the box editor and its unsaved work.
  it('answers any other failure as a 500, never a throw', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    grantMysteryBoxes.mockRejectedValueOnce(new Error('connection lost'));
    const result = await actions.grant(grantEvent(GRANTER, fields('11')));
    expect(result).toMatchObject({ status: 500, data: { scope: 'grant' } });
  });

  it("answers the service's refusal as a 409", async () => {
    grantMysteryBoxes.mockRejectedValueOnce(
      new BoxGrantRefused('Only a published box can be granted.')
    );
    const result = await actions.grant(grantEvent(GRANTER, fields('11')));
    expect(result).toMatchObject({
      status: 409,
      data: { scope: 'grant', error: 'Only a published box can be granted.' },
    });
  });
});
