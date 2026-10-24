import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The audit is its own grant, and holding it is not holding User Lookup's addresses. Everything the
 * model wrote can quote an address its moderator was shown, the reasoning included, so a viewer without
 * address access gets each of those fields redacted.
 */

const { listAuditTurns, canSeeAddresses } = vi.hoisted(() => ({
  listAuditTurns: vi.fn(),
  canSeeAddresses: vi.fn(),
}));

vi.mock('$lib/server/assistant/store', () => ({ listAuditTurns }));
vi.mock('$lib/server/access', () => ({ canSeeAddresses }));
// `$lib/server/db` demands its replica URL at module scope; see routes/abuse/__tests__/load-status.test.ts.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/users.service')>()),
  usersByIds: vi.fn(async () => new Map()),
}));

const { load } = await import('../+page.server');

const ADDRESS = '192.0.2.16';
const row = {
  id: 1,
  chatId: 1,
  moderatorId: 7,
  prompt: `who else is on ${ADDRESS}?`,
  playbookSlug: null,
  playbookVersion: null,
  status: 'done',
  toolCalls: [],
  answer: `Two accounts share ${ADDRESS}.`,
  reasoning: `- ${ADDRESS} is shared by two accounts`,
  unverified: [],
  error: null,
  model: 'm',
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
  createdAt: new Date(0),
  finishedAt: new Date(0),
  chatTitle: 'c',
};

const run = async (grants: Record<string, true> = {}) =>
  (
    (await (load as unknown as (e: unknown) => Promise<unknown>)({
      url: new URL('https://moderator.example/assistant/audit'),
      locals: { grants },
    })) as { turns: (typeof row)[] }
  ).turns[0];

beforeEach(() => {
  listAuditTurns.mockReset().mockResolvedValue([row]);
});

describe('/assistant/audit', () => {
  it('redacts addresses from the reasoning as well as the prompt and answer', async () => {
    canSeeAddresses.mockReturnValue(false);
    const turn = await run();
    expect(turn.reasoning).toBe('- [address] is shared by two accounts');
    expect(`${turn.prompt} ${turn.answer}`).not.toContain(ADDRESS);
  });

  it('shows the reasoning as written to a viewer who may see addresses', async () => {
    canSeeAddresses.mockReturnValue(true);
    expect((await run()).reasoning).toBe(row.reasoning);
  });

  describe('registration emails a pilot was shown', () => {
    const EMAIL = 'b.o.t+7@gmail.com';
    const quoting = {
      ...row,
      prompt: `is ${EMAIL} a bot?`,
      answer: `Both accounts registered as ${EMAIL} on ${ADDRESS}.`,
      reasoning: `- ${EMAIL} matches`,
      toolCalls: [{ name: 'find_user', args: { query: EMAIL } }],
    };

    it('are redacted, every field, for an address viewer without assistant.emails', async () => {
      listAuditTurns.mockResolvedValue([quoting]);
      canSeeAddresses.mockReturnValue(true);
      const turn = await run();
      expect(turn.answer).toBe(`Both accounts registered as [email] on ${ADDRESS}.`);
      expect(JSON.stringify(turn)).not.toContain('gmail');
    });

    it('are redacted inside nested and multi-line arguments, and the error, without breaking the page', async () => {
      listAuditTurns.mockResolvedValue([
        {
          ...quoting,
          error: `provider echoed ${EMAIL}`,
          toolCalls: [
            { name: 'request_tool', args: { need: `line one\n${EMAIL}`, list: [`\t${EMAIL}`] } },
            { name: EMAIL, args: {}, error: `No tool named "${EMAIL}"` },
          ],
        },
      ]);
      canSeeAddresses.mockReturnValue(true);
      const turn = await run();
      expect(turn.toolCalls[0]).toMatchObject({
        args: { need: 'line one\n[email]', list: ['\t[email]'] },
      });
      expect(JSON.stringify(turn)).not.toContain('gmail');
    });

    it('are shown to a viewer holding assistant.emails', async () => {
      listAuditTurns.mockResolvedValue([quoting]);
      canSeeAddresses.mockReturnValue(true);
      expect((await run({ 'assistant.emails': true })).answer).toBe(quoting.answer);
    });

    it('are redacted with the grant when the viewer cannot see addresses either', async () => {
      listAuditTurns.mockResolvedValue([quoting]);
      canSeeAddresses.mockReturnValue(false);
      expect((await run({ 'assistant.emails': true })).answer).toBe(
        'Both accounts registered as [email] on [address].'
      );
    });
  });
});
