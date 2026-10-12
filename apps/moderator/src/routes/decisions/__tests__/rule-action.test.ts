import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The group page's two form actions. The service's own behaviour (append-only, CHECKs, the
 * schema.sql message on a missing table) is asserted against real Postgres in
 * `lib/server/__tests__/decision-resolution.pglite.test.ts`; this file asserts what the route hands
 * it and what it refuses first.
 */

const {
  getSupportGroup,
  recordResolution,
  currentResolutions,
  listSupportTopics,
  resolutionAnswer,
  getPublicAgentReplies,
} = vi.hoisted(() => ({
  getSupportGroup: vi.fn(),
  recordResolution: vi.fn(),
  currentResolutions: vi.fn(),
  listSupportTopics: vi.fn(),
  resolutionAnswer: vi.fn(),
  getPublicAgentReplies: vi.fn(),
}));

vi.mock('$lib/server/decision-sources/support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/decision-sources/support')>()),
  getSupportGroup,
  supportVersion: vi.fn(async () => ({ version: 'v-live', overridden: false })),
  listDuplicateTargets: vi.fn(async () => []),
  listSupportTopics,
}));
vi.mock('$lib/server/decision-resolution.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/decision-resolution.service')>()),
  recordResolution,
  currentResolutions,
  resolutionAnswer,
}));
vi.mock('$lib/server/freshdesk.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/freshdesk.service')>()),
  getPublicAgentReplies,
}));
// The route's import graph reaches `$lib/server/db`, which demands a connection string at import.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { actions, load } = await import('../support/[groupKey]/+page.server');
const { snapshotFingerprint } = await import('../support/[groupKey]/ruling');
type Detail = Parameters<typeof snapshotFingerprint>[0];
const fp = (d: unknown) => snapshotFingerprint(d as Detail);

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
      body: new URLSearchParams({ version: 'v-shown', fingerprint: fp(detail()), ...fields }),
    }),
    params: { groupKey: GK },
    url: new URL(`https://moderator.example/decisions/support/${GK}`),
    locals: {
      user: { id: opts.userId ?? 4821, username: 'mod-a' },
      grants: opts.grants ?? { 'decisions.rule': true },
    },
  });

beforeEach(() => {
  for (const m of [
    getSupportGroup,
    recordResolution,
    currentResolutions,
    listSupportTopics,
    resolutionAnswer,
    getPublicAgentReplies,
  ])
    m.mockReset();
  resolutionAnswer.mockResolvedValue(null);
  getPublicAgentReplies.mockResolvedValue({
    status: 'found',
    replies: [{ conversationId: '150003911207', createdAt: null, text: 'Agent reply text.' }],
  });
  getSupportGroup.mockResolvedValue(detail());
  listSupportTopics.mockResolvedValue([
    { topic: 'billing-buzz', groups: 3 },
    { topic: 'crypto', groups: 1 },
  ]);
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
    expect(recordResolution).toHaveBeenCalledTimes(1);
    // The WHOLE snapshot: the founder's never-measured probabilities stay null in the stored
    // evidence, and every field is the re-read's, none the form's.
    expect(arg.shown).toEqual({
      topic: 'billing-buzz',
      created_by: 'router',
      founded_ticket_id: '1',
      founder_position: 'first',
      n_members: 2,
      topics_spanned: ['billing-buzz'],
      question_spec_hashes: ['h'],
      members: [
        {
          ticket_id: '1',
          chosen_topic: 'billing-buzz',
          p_topic: 0.9,
          p_group: null,
          p_novel: null,
        },
        { ticket_id: '2', chosen_topic: 'billing-buzz', p_topic: 0.9, p_group: 0.8, p_novel: 0.1 },
      ],
    });
  });

  it('invariant: the fingerprint LOAD hands the page is one the action accepts', async () => {
    const page = (await (load as unknown as Handler)({
      params: { groupKey: GK },
      url: new URL(`https://moderator.example/decisions/support/${GK}`),
      locals: { grants: { 'decisions.rule': true } },
    })) as unknown as { fingerprint: string; version: string };
    expect(page.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    const out = await post('rule', {
      ruling: 'correct',
      version: page.version,
      fingerprint: page.fingerprint,
    });
    expect(out.success).toBe(true);
  });

  it('refuses a ruling when the group changed since the page loaded (409), without writing', async () => {
    // A member left…
    expect(
      (await post('rule', { ruling: 'correct', fingerprint: fp(detail({ members: ['1'] })) }))
        .status
    ).toBe(409);
    // …or the SAME members, one re-routed in place with new probabilities — invisible to an id list.
    const moved = detail();
    moved.decision.members[1].probabilities.group = 0.42;
    expect((await post('rule', { ruling: 'correct', fingerprint: fp(moved) })).status).toBe(409);
    // …or nothing posted at all.
    expect((await post('rule', { ruling: 'correct', fingerprint: '' })).status).toBe(409);
    expect(recordResolution).not.toHaveBeenCalled();
    // The unchanged page's own fingerprint goes through.
    expect((await post('rule', { ruling: 'correct' })).success).toBe(true);
  });

  it('records an escalation with its area', async () => {
    await post('rule', { ruling: 'escalate', escalateTo: 'crypto' });
    expect(recordResolution.mock.calls[0][0]).toMatchObject({
      ruling: 'escalate',
      escalateTo: 'crypto',
      targetKey: null,
    });
  });

  it('refuses an escalation without an area, with a malformed one, or one not in the version', async () => {
    expect((await post('rule', { ruling: 'escalate' })).status).toBe(400);
    expect((await post('rule', { ruling: 'escalate', escalateTo: 'Bad Area!' })).status).toBe(400);
    expect((await post('rule', { ruling: 'escalate', escalateTo: 'mobile-app' })).status).toBe(400);
    expect(recordResolution).not.toHaveBeenCalled();
  });

  it('drops a stray escalation area on a ruling that does not use one', async () => {
    await post('rule', { ruling: 'correct', escalateTo: 'crypto' });
    expect(recordResolution.mock.calls[0][0]).toMatchObject({
      ruling: 'correct',
      escalateTo: null,
    });
  });

  it('records duplicate_of with a target that exists IN THE SHOWN VERSION', async () => {
    await post('rule', { ruling: 'duplicate_of', targetKey: 'g_000000000001' });
    expect(getSupportGroup).toHaveBeenCalledWith({
      version: 'v-shown',
      groupKey: 'g_000000000001',
    });
    expect(recordResolution.mock.calls[0][0]).toMatchObject({
      ruling: 'duplicate_of',
      targetKey: 'g_000000000001',
    });
  });

  it('503s with the router named — not the database — when the re-read fails', async () => {
    getSupportGroup.mockRejectedValue(new Error('socket hang up'));
    const out = await post('rule', { ruling: 'correct' });
    expect(out.status).toBe(503);
    expect(out.data?.error).toMatch(/re-read the router/);
    expect(recordResolution).not.toHaveBeenCalled();
  });

  it('never shows the operator a raw driver error', async () => {
    recordResolution.mockRejectedValue(new Error('duplicate key value violates xyz_internal'));
    const out = await post('rule', { ruling: 'correct' });
    expect(out.status).toBe(503);
    expect(out.data?.error).not.toMatch(/xyz_internal/);
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
    expect(recordResolution).toHaveBeenCalledTimes(1);
    expect(recordResolution.mock.calls[0][0].shown).toEqual({
      ticket_id: '2',
      chosen_topic: 'billing-buzz',
      p_topic: 0.9,
      p_group: 0.8,
      p_novel: 0.1,
      is_founder: false,
      question_spec_hash: 'h',
      group_created_by: 'router',
      n_members: 2,
    });
  });

  it('refuses to label the founding ticket — that is the group ruling', async () => {
    const out = await post('label', { ticketId: '1', ruling: 'belongs' });
    expect(out.status).toBe(400);
    expect(out.data).toMatchObject({ scope: 'label', ticketId: '1' });
    expect(recordResolution).not.toHaveBeenCalled();
  });

  it('echoes the ticket id on a malformed post, so the refusal renders on its row', async () => {
    const out = await post('label', { ticketId: '2', ruling: 'nope' });
    expect(out.status).toBe(400);
    expect(out.data).toMatchObject({ scope: 'label', ticketId: '2' });
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

describe('load', () => {
  const run = (grants: Record<string, true>) =>
    (load as unknown as Handler)({
      params: { groupKey: GK },
      url: new URL(`https://moderator.example/decisions/support/${GK}`),
      locals: { grants },
    }) as unknown as Promise<{
      storeStatus: string;
      canRule: boolean;
      groupRuling: unknown;
      memberLabels: unknown;
    }>;

  it('enables the controls with the grant and a readable store', async () => {
    const page = await run({ 'decisions.rule': true });
    expect(page.storeStatus).toBe('ok');
    expect(page.canRule).toBe(true);
  });

  it('splits the current resolutions into the group ruling and the member labels', async () => {
    const at = new Date(0);
    currentResolutions.mockResolvedValue([
      {
        id: '1',
        itemKey: GK,
        subKey: '',
        ruling: 'park',
        targetKey: null,
        escalateTo: null,
        note: null,
        ruledBy: 5,
        ruledAt: at,
        applyState: 'pending',
      },
      {
        id: '2',
        itemKey: GK,
        subKey: '2',
        ruling: 'unsure',
        targetKey: null,
        escalateTo: null,
        note: null,
        ruledBy: 6,
        ruledAt: at,
        applyState: 'n/a',
      },
    ]);
    const page = await run({});
    expect(page.groupRuling).toEqual({
      id: '1',
      ruling: 'park',
      ruledBy: 5,
      ruledAt: at,
      targetKey: null,
    });
    expect(page.memberLabels).toEqual({ '2': { ruling: 'unsure', ruledBy: 6, ruledAt: at } });
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

describe('the resolved ruling', () => {
  const ANSWER = 'Update the app, then sign out and back in.';
  const BOTH = { 'decisions.rule': true, 'decisions.answer': true } as const;
  const SOURCE = { answerTicketId: '2', answerConversationId: '150003911207' };

  it('is refused 403 without decisions.answer, even holding decisions.rule — before any read', async () => {
    const out = await post(
      'rule',
      { ruling: 'resolved', answerText: ANSWER },
      { grants: { 'decisions.rule': true } }
    );
    expect(out.status).toBe(403);
    expect(out.data).toMatchObject({ scope: 'denied' });
    expect(out.data?.error).toMatch(/Record the canonical answer for a decision group/);
    expect(getSupportGroup).not.toHaveBeenCalled();
    expect(recordResolution).not.toHaveBeenCalled();
  });

  it('is refused 403 with decisions.answer alone — the ruling grant is still required', async () => {
    const out = await post(
      'rule',
      { ruling: 'resolved', answerText: ANSWER },
      { grants: { 'decisions.answer': true } }
    );
    expect(out.status).toBe(403);
    expect(recordResolution).not.toHaveBeenCalled();
  });

  it('decisions.answer is not needed for any other ruling', async () => {
    const out = await post('rule', { ruling: 'correct' }, { grants: { 'decisions.rule': true } });
    expect(out.success).toBe(true);
  });

  it('records the answer with both grants, without a source', async () => {
    const out = await post('rule', { ruling: 'resolved', answerText: ANSWER }, { grants: BOTH });
    expect(out).toMatchObject({ success: true, ruling: 'resolved' });
    const arg = recordResolution.mock.calls[0][0];
    expect(arg).toMatchObject({
      subKey: '',
      ruling: 'resolved',
      answer: { text: ANSWER, source: null },
    });
    expect(arg.shown).not.toHaveProperty('answer_source');
    expect(getPublicAgentReplies).not.toHaveBeenCalled();
  });

  it('confirms the cited reply with Freshdesk, and stores ids — never text — in the snapshot', async () => {
    const out = await post(
      'rule',
      { ruling: 'resolved', answerText: ANSWER, ...SOURCE },
      { grants: BOTH }
    );
    expect(out.success).toBe(true);
    expect(getPublicAgentReplies).toHaveBeenCalledWith('2');
    const arg = recordResolution.mock.calls[0][0];
    expect(arg.answer).toEqual({
      text: ANSWER,
      source: { ticketId: '2', conversationId: '150003911207' },
    });
    expect(arg.shown.answer_source).toEqual({ ticket_id: '2', conversation_id: '150003911207' });
    expect(JSON.stringify(arg.shown)).not.toContain('Agent reply text.');
  });

  it('refuses a source that is not a current member of the group', async () => {
    const out = await post(
      'rule',
      { ruling: 'resolved', answerText: ANSWER, ...SOURCE, answerTicketId: '99' },
      { grants: BOTH }
    );
    expect(out.status).toBe(400);
    expect(getPublicAgentReplies).not.toHaveBeenCalled();
    expect(recordResolution).not.toHaveBeenCalled();
  });

  it('refuses a reply that is not among the ticket’s public agent replies', async () => {
    getPublicAgentReplies.mockResolvedValue({
      status: 'found',
      replies: [{ conversationId: '150003999999', createdAt: null, text: 'other' }],
    });
    const out = await post(
      'rule',
      { ruling: 'resolved', answerText: ANSWER, ...SOURCE },
      { grants: BOTH }
    );
    expect(out.status).toBe(400);
    expect(recordResolution).not.toHaveBeenCalled();
  });

  it('503s, without writing, when Freshdesk cannot confirm the source', async () => {
    getPublicAgentReplies.mockResolvedValue({ status: 'unavailable', reason: 'rate limited' });
    const out = await post(
      'rule',
      { ruling: 'resolved', answerText: ANSWER, ...SOURCE },
      { grants: BOTH }
    );
    expect(out.status).toBe(503);
    expect(out.data?.error).toMatch(/rate limited.*NOT recorded/);
    expect(recordResolution).not.toHaveBeenCalled();
  });

  it('still refuses a group that moved (409) before asking Freshdesk', async () => {
    const out = await post(
      'rule',
      { ruling: 'resolved', answerText: ANSWER, ...SOURCE, fingerprint: 'stale' },
      { grants: BOTH }
    );
    expect(out.status).toBe(409);
    expect(getPublicAgentReplies).not.toHaveBeenCalled();
  });

  it('load: canAnswer needs both grants, and the answer is read only for a resolved ruling', async () => {
    const run = (grants: Record<string, true>) =>
      (load as unknown as Handler)({
        params: { groupKey: GK },
        url: new URL(`https://moderator.example/decisions/support/${GK}`),
        locals: { grants },
      }) as unknown as Promise<{ canAnswer: boolean; canRule: boolean; answer: unknown }>;
    expect((await run({ 'decisions.rule': true })).canAnswer).toBe(false);
    expect((await run({ 'decisions.answer': true })).canAnswer).toBe(false);
    expect((await run(BOTH)).canAnswer).toBe(true);
    expect(resolutionAnswer).not.toHaveBeenCalled();

    currentResolutions.mockResolvedValue([
      {
        id: '41',
        itemKey: GK,
        subKey: '',
        ruling: 'resolved',
        targetKey: null,
        escalateTo: null,
        note: null,
        ruledBy: 5,
        ruledAt: new Date(0),
        applyState: 'n/a',
      },
    ]);
    resolutionAnswer.mockResolvedValue({ text: ANSWER, source: null });
    const page = await run({});
    expect(resolutionAnswer).toHaveBeenCalledWith('41');
    expect(page.answer).toEqual({ text: ANSWER, source: null });
  });
});
