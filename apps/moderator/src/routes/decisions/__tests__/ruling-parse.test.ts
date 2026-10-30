import { describe, expect, it, vi } from 'vitest';

// Reached through the support source's import graph; it demands a connection string at import.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { foreignEmailIn, parseGroupRuling } = await import('../support/[groupKey]/ruling');

const GK = 'g_5b0c81e7a4d2';
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const ANSWER = 'Open Settings, choose Sessions, and end the old one.';

describe('parseGroupRuling — the resolved answer', () => {
  it('keeps the trimmed answer and its source on resolved', () => {
    expect(
      parseGroupRuling(
        form({
          ruling: 'resolved',
          answerText: `  ${ANSWER}\n`,
          answerTicketId: '73618',
          answerConversationId: '150003911207',
        }),
        GK
      )
    ).toEqual({
      ruling: 'resolved',
      targetKey: null,
      escalateTo: null,
      note: null,
      answer: { text: ANSWER, source: { ticketId: '73618', conversationId: '150003911207' } },
    });
  });

  it('keeps an answer with no source', () => {
    expect(parseGroupRuling(form({ ruling: 'resolved', answerText: ANSWER }), GK)).toMatchObject({
      answer: { text: ANSWER, source: null },
    });
  });

  it('drops a stray answer and source on any other ruling', () => {
    expect(
      parseGroupRuling(
        form({
          ruling: 'correct',
          answerText: ANSWER,
          answerTicketId: '73618',
          answerConversationId: '150003911207',
        }),
        GK
      )
    ).toMatchObject({ ruling: 'correct', answer: null });
  });

  it.each([
    ['no answer', {}],
    ['a blank answer', { answerText: ' \n\t ' }],
  ])('refuses resolved with %s', (_label, fields) => {
    expect(parseGroupRuling(form({ ruling: 'resolved', ...fields }), GK)).toMatch(
      /Write the answer/
    );
  });

  it('refuses an answer over the limit, and accepts one at it', () => {
    expect(
      parseGroupRuling(form({ ruling: 'resolved', answerText: 'z'.repeat(8001) }), GK)
    ).toMatch(/8001 characters; the limit is 8000/);
    expect(
      parseGroupRuling(form({ ruling: 'resolved', answerText: 'z'.repeat(8000) }), GK)
    ).toMatchObject({ ruling: 'resolved' });
  });

  it("refuses an answer holding a customer's email address, naming it", () => {
    const out = parseGroupRuling(
      form({ ruling: 'resolved', answerText: `Hi Dana (dana.r+cv@mailbox.example), ${ANSWER}` }),
      GK
    );
    expect(out).toMatch(/Remove the email address \(dana\.r\+cv@mailbox\.example\)/);
  });

  it('accepts our own support address in an answer', () => {
    expect(
      parseGroupRuling(
        form({
          ruling: 'resolved',
          answerText: `${ANSWER} Still stuck? Write to support@civitai.com.`,
        }),
        GK
      )
    ).toMatchObject({ ruling: 'resolved' });
  });

  it.each([
    ['a ticket without its reply', { answerTicketId: '73618' }],
    ['a reply without its ticket', { answerConversationId: '150003911207' }],
    ['a non-numeric ticket', { answerTicketId: '7361a', answerConversationId: '150003911207' }],
    ['a non-numeric reply', { answerTicketId: '73618', answerConversationId: '15000391120x' }],
  ])('refuses %s', (_label, fields) => {
    expect(
      parseGroupRuling(form({ ruling: 'resolved', answerText: ANSWER, ...fields }), GK)
    ).toMatch(/malformed/);
  });
});

describe('foreignEmailIn', () => {
  it('finds the first address not on our domain', () => {
    expect(foreignEmailIn('mail help@civitai.com or me at kai@other.example')).toBe(
      'kai@other.example'
    );
    expect(foreignEmailIn('HELP@CIVITAI.COM')).toBeNull();
    expect(foreignEmailIn('no address at all')).toBeNull();
  });

  it('is not fooled by our domain as a prefix of someone else’s', () => {
    expect(foreignEmailIn('x@civitai.com.attacker.example')).toBe('x@civitai.com.attacker.example');
  });
});
