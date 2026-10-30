import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AutoMute from '~/server/services/scam-auto-mute.service';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

vi.mock('~/server/services/scam-auto-mute.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AutoMute>()),
  autoMuteScamAccount: vi.fn(async () => ({ muted: false, skipped: 'duplicate' })),
}));

const { autoMuteIfScamAccount, clavataScamEvidence } = await import(
  '~/server/jobs/entity-moderation'
);
const { autoMuteScamAccount } = await import('~/server/services/scam-auto-mute.service');

const TAG = 'Impersonating Civitai Staff';
const AT = new Date('2026-09-24T12:00:00Z');

beforeEach(() => vi.clearAllMocks());

describe('Clavata scam auto-mute', () => {
  it.each([
    ['Chat', 'chatMessages'],
    ['Comment', 'comments'],
    ['CommentV2', 'commentsV2'],
  ] as const)('%s mutes with cleanup %s', async (type, cleanup) => {
    await autoMuteIfScamAccount({ type, entityId: 9, userId: 5, matches: [TAG], value: 'x' });
    expect(autoMuteScamAccount).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: 5, cleanup })
    );
  });

  it('ignores other tags and other entity types', async () => {
    await autoMuteIfScamAccount({
      type: 'Comment',
      entityId: 9,
      userId: 5,
      matches: ['Other'],
      value: 'x',
    });
    await autoMuteIfScamAccount({
      type: 'Model',
      entityId: 9,
      userId: 5,
      matches: [TAG],
      value: 'x',
    });
    expect(autoMuteScamAccount).not.toHaveBeenCalled();
  });

  it('logs rather than throws when the mute fails', async () => {
    vi.mocked(autoMuteScamAccount).mockRejectedValueOnce(new Error('db down'));
    await expect(
      autoMuteIfScamAccount({ type: 'Comment', entityId: 9, userId: 5, matches: [TAG], value: 'x' })
    ).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalled();
  });
});

describe('clavataScamEvidence', () => {
  const chat = (messageId: number) =>
    clavataScamEvidence({
      type: 'Chat',
      entityId: 4,
      matches: [TAG, 'B'],
      value: 'group text',
      sender: { messageId, at: AT },
    });

  it('keys a chat verdict by the sender’s newest flagged message and dates it by that message', () => {
    expect(chat(30)).toMatchObject({ dedupeKey: `clavata:Chat:4:m30:B|${TAG}`, contentAt: AT });
    expect(chat(31).dedupeKey).not.toBe(chat(30).dedupeKey);
  });

  it('keys other entities by their text, so an edit is a new verdict and the same text is not', () => {
    const at = (value: string) =>
      clavataScamEvidence({ type: 'Comment', entityId: 7, matches: [TAG], value });
    expect(at('a').dedupeKey).toBe(at('a').dedupeKey);
    expect(at('a').dedupeKey).not.toBe(at('b').dedupeKey);
    expect(at('a').dedupeKey).toMatch(
      /^clavata:Comment:7:[0-9a-f]{16}:Impersonating Civitai Staff$/
    );
    expect(at('a')).toMatchObject({
      contentAt: null,
      textHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('never produces NaN in a key', () => {
    expect(chat(30).dedupeKey).not.toContain('NaN');
  });
});
