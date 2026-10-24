import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AutoMute from '~/server/services/scam-auto-mute.service';

vi.mock('~/server/services/scam-auto-mute.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AutoMute>()),
  autoMuteScamAccount: vi.fn(async () => ({ muted: false, skipped: 'duplicate' })),
}));
const { applyScamVerdict, SCAM_ENTITY_TYPES, SCAM_TRIGGER_TEXT_CHARS } = await import(
  '~/server/services/text-scan/scam.adapter'
);
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { autoMuteScamAccount } = await import('~/server/services/scam-auto-mute.service');

const CONTENT_AT = '2026-09-24T10:00:00.000Z';
const detected = {
  scam: { detected: true, reason: 'Fake support' },
  triggeredLabels: ['scam' as const],
  nsfwLevel: null,
};
const clean = {
  scam: { detected: false, reason: 'Ordinary' },
  triggeredLabels: [],
  nsfwLevel: null,
};
const subject = (userId?: number, meta?: Record<string, unknown>, text = 'claim your prize') => ({
  fields: [{ heading: 'Comment', text }],
  declared: {},
  userId,
  meta,
});
const args = (over: Record<string, unknown> = {}) => ({
  entityId: 77,
  workflowId: 'wf-9',
  outcome: detected,
  subject: subject(5, { contentAt: CONTENT_AT, subjectUserId: 5 }),
  textHash: 'submitted-hash',
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('applyScamVerdict', () => {
  it.each([
    ['ChatMessage', 'chatMessages', false],
    ['Comment', 'comments', false],
    ['CommentV2', 'commentsV2', false],
    ['ResourceReview', 'none', false],
    ['User', 'none', true],
    ['UserProfile', 'none', false],
  ] as const)(
    '%s mutes the subject with cleanup %s (age rule waived: %s)',
    async (entityType, cleanup, waived) => {
      await applyScamVerdict(entityType, args());
      expect(autoMuteScamAccount).toHaveBeenCalledWith({
        userId: 5,
        cleanup,
        ignoreAccountAge: waived,
        evidence: {
          source: `text-scan:${entityType}:77`,
          dedupeKey: 'wf-9',
          reason: 'Fake support',
          entityType,
          entityId: 77,
          text: 'claim your prize',
          textHash: 'submitted-hash',
          contentAt: new Date(CONTENT_AT),
        },
      });
    }
  );

  it('passes no content time when the profile has none', async () => {
    await applyScamVerdict('User', args({ subject: subject(5, { subjectUserId: 5 }) }));
    expect(vi.mocked(autoMuteScamAccount).mock.calls[0][0].evidence.contentAt).toBeNull();
  });

  it('caps the text it puts on the ledger', async () => {
    await applyScamVerdict(
      'Comment',
      args({ subject: subject(5, {}, 'z'.repeat(SCAM_TRIGGER_TEXT_CHARS + 10)) })
    );
    expect(vi.mocked(autoMuteScamAccount).mock.calls[0][0].evidence.text).toHaveLength(
      SCAM_TRIGGER_TEXT_CHARS
    );
  });

  it('does nothing on a clean verdict', async () => {
    await applyScamVerdict('Comment', args({ outcome: clean }));
    expect(autoMuteScamAccount).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1])('does nothing without a real subject user (%s)', async (userId) => {
    await applyScamVerdict('Comment', args({ subject: subject(userId) }));
    expect(autoMuteScamAccount).not.toHaveBeenCalled();
  });

  it('a chat window verdict mutes its sender and nobody else', async () => {
    await applyScamVerdict(
      'ChatMessage',
      args({
        entityId: 30,
        subject: subject(5, { chatId: 4, senderId: 5, messageIds: [30, 21], subjectUserId: 5 }),
      })
    );
    expect(autoMuteScamAccount).toHaveBeenCalledTimes(1);
    expect(vi.mocked(autoMuteScamAccount).mock.calls[0][0].userId).toBe(5);
  });
});

describe('registration', () => {
  it.each(SCAM_ENTITY_TYPES)('%s resolves to a text-scan adapter', (entityType) => {
    const adapter = getModerationAdapter(entityType);
    expect(adapter?.applyTextScan).toBeTypeOf('function');
    expect(adapter?.isEnabled).toBeTypeOf('function');
  });

  it('routes a verdict through the registered adapter', async () => {
    await getModerationAdapter('Comment')!.applyTextScan!(args() as never);
    expect(autoMuteScamAccount).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 5, cleanup: 'comments' })
    );
  });
});
