import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The group page's two form actions. The service's own behaviour (append-only, CHECKs, the
 * schema.sql message on a missing table) is asserted against real Postgres in
 * `lib/server/__tests__/decision-resolution.pglite.test.ts`; this file asserts what the route hands
 * it and what it refuses first.
 */

const { getSupportGroup, recordResolution, currentResolutions } = vi.hoisted(() => ({
  getSupportGroup: vi.fn(),
  recordResolution: vi.fn(),
  currentResolutions: vi.fn(),
}));

vi.mock('$lib/server/decision-sources/support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/decision-sources/support')>()),
  getSupportGroup,
  supportVersion: vi.fn(async () => ({ version: 'v-live', overridden: false })),
  listDuplicateTargets: vi.fn(async () => []),
  listSupportTopics: vi.fn(async () => []),
}));
vi.mock('$lib/server/decision-resolution.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/decision-resolution.service')>()),
  recordResolution,
  currentResolutions,
}));
// The route's import graph reaches `$lib/server/db`, which demands a connection string at import.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { actions, load } = await import('../support/[groupKey]/+page.server');

const GK = 'g_3fa9c01d22be';

const detail = (over: { members?: string[] } = {}) => ({
  group: { groupKey: GK, topic: 'billing-buzz', createdBy: 'router', foundedTicketId: '1' },
  decision: {
    id: `support:${GK}`,
    groupKey: GK,
    lead: { ticketId: '1' },
    members: (over.members ?? ['1', '2']).map((id) => ({
      ticketId: id,
      chosenTopic: 'billing-buzz',
      isFounder: id === '1',
      questionSpecHash: 'h',
      probabilities: { topic: 0.9, group: id === '1' ? null : 0.8, novel: id === '1' ? null : 0.1 },
    })),
  },
  founder: 'first',
  topicsSpanned: ['billing-buzz'],
  specHashes: ['h'],
});

type Result = { status?: number; data?: { error?: string; scope?: string } } & Record<
  string,
  unknown
>;
type Handler = (e: unknown) => Promise<Result>;

const post = (
  action: 'rule' | 'label',
  fields: Record<string, string>,
  opts: { grants?: Record<string, true>; userId?: number } = {}
): Promise<Result> =>
  (actions as unknown as Record<string, Handler>)[action]({
    request: new Request(`https://moderator.example/decisions/support/${GK}`, {
      method: 'POST',
      body: new URLSearchParams({ version: 'v-shown', ...fields }),
    }),
    params: { groupKey: GK },
    url: new URL(`https://moderator.example/decisions/support/${GK}`),
    locals: {
      user: { id: opts.userId ?? 4821, username: 'mod-a' },
      grants: opts.grants ?? { 'decisions.rule': true },
    },
  });

beforeEach(() => {
  for (const m of [getSupportGroup, recordResolution, currentResolutions]) m.mockReset();
  getSupportGroup.mockResolvedValue(detail());
  recordResolution.mockResolvedValue({ inserted: 1, id: '1' });
  currentResolutions.mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('permission', () => {
  it.each(['rule', 'label'] as const)(
    '%s is refused 403 without decisions.rule, before any write',
    async (a) => {
      const out = await post(
        a,
        { ruling: a === 'rule' ? 'correct' : 'belongs', ticketId: '2' },
        { grants: {} }
      );
      expect(out.status).toBe(403);
      expect(out.data?.scope).toBe('denied');
      expect(recordResolution).not.toHaveBeenCalled();
    }
  );

  it('the page grant alone does not enable the controls', async () => {
    const page = (await (load as unknown as Handler)({
      params: { groupKey: GK },
      url: new URL(`https://moderator.example/decisions/support/${GK}`),
      locals: { grants: {} },
    })) as { canRule: boolean };
    expect(page.canRule).toBe(false);
  });
});

describe('the rule action', () => {
  it('records the ruling against the SHOWN version, as the user id, with a server-built snapshot', async () => {
    const out = await post('rule', { ruling: 'correct', note: ' looks right ' }, { userId: 77 });
    expect(out).toMatchObject({ success: true, ruling: 'correct' });
    expect(getSupportGroup).toHaveBeenCalledWith({ version: 'v-shown', groupKey: GK });
    const arg = recordResolution.mock.calls[0][0];
    expect(arg).toMatchObject({
      source: 'support-ticket',
      itemKey: GK,
      subKey: '',
      sourceVersion: 'v-shown',
      area: 'billing-buzz',
      ruling: 'correct',
      targetKey: null,
      escalateTo: null,
      note: 'looks right',
      ruledBy: 77,
    });
    // The founder's never-measured probabilities stay null in the stored evidence.
    expect(arg.shown.members[0]).toMatchObject({ ticket_id: '1', p_group: null, p_novel: null });
    expect(arg.shown.n_members).toBe(2);
  });

  it('refuses duplicate_of without a target (400), and with itself as the target', async () => {
    expect((await post('rule', { ruling: 'duplicate_of' })).status).toBe(400);
    expect((await post('rule', { ruling: 'duplicate_of', targetKey: GK })).status).toBe(400);
    expect(recordResolution).not.toHaveBeenCalled();
  });

  it('refuses a target that does not exist in the version', async () => {
    getSupportGroup.mockImplementation(async ({ groupKey }: { groupKey: string }) =>
      groupKey === GK ? detail() : null
    );
    expect(
      (await post('rule', { ruling: 'duplicate_of', targetKey: 'g_000000000000' })).status
    ).toBe(400);
  });

  it('drops a stray target on a ruling that does not use one', async () => {
    await post('rule', { ruling: 'park', targetKey: 'g_000000000000' });
    expect(recordResolution.mock.calls[0][0]).toMatchObject({ ruling: 'park', targetKey: null });
  });

  it('refuses an unknown ruling and a member label posted as a group ruling', async () => {
    expect((await post('rule', { ruling: 'merge' })).status).toBe(400);
    expect((await post('rule', { ruling: 'belongs' })).status).toBe(400);
  });

  it('404s when the group is gone from the version (0 rows), without writing', async () => {
    getSupportGroup.mockResolvedValue(null);
    const out = await post('rule', { ruling: 'correct' });
    expect(out.status).toBe(404);
    expect(recordResolution).not.toHaveBeenCalled();
  });

  it('treats 0 rows written as a failure', async () => {
    recordResolution.mockResolvedValue({ inserted: 0, id: null });
    expect((await post('rule', { ruling: 'correct' })).status).toBe(503);
  });

  it('503s naming schema.sql when the table is absent', async () => {
    recordResolution.mockRejectedValue(
      new Error('decision_resolution does not exist — apply apps/moderator/decisions/schema.sql')
    );
    const out = await post('rule', { ruling: 'correct' });
    expect(out.status).toBe(503);
    expect(out.data?.error).toMatch(/decisions\/schema\.sql/);
    expect(out.data?.scope).toBe('rule');
  });
});

describe('the label action', () => {
  it('labels a current member', async () => {
    const out = await post('label', { ticketId: '2', ruling: 'not_belongs' });
    expect(out).toMatchObject({ success: true, ticketId: '2' });
    expect(recordResolution.mock.calls[0][0]).toMatchObject({
      subKey: '2',
      ruling: 'not_belongs',
      sourceVersion: 'v-shown',
    });
    expect(recordResolution.mock.calls[0][0].shown).toMatchObject({ ticket_id: '2', p_group: 0.8 });
  });

  it('404s a ticket that is no longer a member', async () => {
    const out = await post('label', { ticketId: '99', ruling: 'belongs' });
    expect(out.status).toBe(404);
    expect(out.data).toMatchObject({ scope: 'label', ticketId: '99' });
    expect(recordResolution).not.toHaveBeenCalled();
  });

  it('refuses a group ruling posted as a label', async () => {
    expect((await post('label', { ticketId: '2', ruling: 'park' })).status).toBe(400);
  });
});

describe('load degrades when the ruling table is absent', () => {
  it('still renders the group, read-only, and says why', async () => {
    currentResolutions.mockRejectedValue(
      Object.assign(new Error('relation does not exist'), { code: '42P01' })
    );
    const page = (await (load as unknown as Handler)({
      params: { groupKey: GK },
      url: new URL(`https://moderator.example/decisions/support/${GK}`),
      locals: { grants: { 'decisions.rule': true } },
    })) as { storeStatus: string; canRule: boolean; detail: unknown };
    expect(page.storeStatus).toBe('no-schema');
    expect(page.canRule).toBe(false);
    expect(page.detail).toBeTruthy();
  });
});
