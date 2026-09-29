import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { constants } from '~/server/common/constants';
import '~/server/services/text-scan/profiles/comment.profile';
import '~/server/services/text-scan/profiles/comment-v2.profile';
import '~/server/services/text-scan/profiles/resource-review.profile';
import '~/server/services/text-scan/profiles/user.profile';
import '~/server/services/text-scan/profiles/user-profile.profile';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
import {
  scamEligibleAuthors,
  scamTextFromHtml,
} from '~/server/services/text-scan/profiles/scam-text';

const load = (entityType: string, ids: number[]) => getTextScanProfile(entityType)!.load(ids);
const EDITED = new Date('2026-09-24T10:00:00Z');
const eligible = (...ids: number[]) =>
  dbMock.dbWrite.user.findMany.mockResolvedValueOnce(
    ids.map((id) => ({
      id,
      createdAt: new Date(),
      isModerator: false,
      deletedAt: null,
      bannedAt: null,
    }))
  );

beforeEach(() => vi.clearAllMocks());

describe('scamTextFromHtml', () => {
  it('keeps a link that only exists in an href', () => {
    expect(scamTextFromHtml('<p>DM me <a href="https://scam.example/claim">here</a></p>')).toBe(
      'DM me [link: https://scam.example/claim] here'
    );
  });

  it.each([
    ["<a href='https://a.example'>x</a>", '[link: https://a.example] x'],
    ['<a href=https://b.example>x</a>', '[link: https://b.example] x'],
    ['<p>plain</p><p>text</p>', 'plain text'],
    ['<p>Tom &amp; Jerry &lt;3 &#x1F600;</p>', 'Tom & Jerry <3 😀'],
    ['<a href="https://c.example/?a=1&amp;b=2">x</a>', '[link: https://c.example/?a=1&b=2] x'],
  ])('%s -> %s', (html, text) => expect(scamTextFromHtml(html)).toBe(text));

  it.each([null, undefined, ''])('%s -> empty', (html) => expect(scamTextFromHtml(html)).toBe(''));
});

describe('scamEligibleAuthors', () => {
  const NOW = new Date('2026-09-24T12:00:00Z');
  const DAY = 86_400_000;
  const account = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    createdAt: new Date(NOW.getTime() - DAY),
    isModerator: false,
    deletedAt: null,
    bannedAt: null,
    ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('keeps new, live, non-moderator, non-judge accounts, from the primary', async () => {
    dbMock.dbWrite.user.findMany.mockResolvedValue([
      account(5),
      account(6, { isModerator: true }),
      account(7, { isModerator: null }),
      account(8),
      account(9, { deletedAt: new Date() }),
      account(10, { bannedAt: new Date() }),
    ]);
    dbMock.dbWrite.challengeJudge.findMany.mockResolvedValue([{ userId: 8 }]);
    const ids = await scamEligibleAuthors([
      5,
      6,
      7,
      8,
      9,
      10,
      5,
      -1,
      0,
      constants.system.officialUserId,
    ]);
    expect([...ids].sort((a, b) => a - b)).toEqual([5, 7]);

    const { where } = dbMock.dbWrite.user.findMany.mock.calls[0][0];
    expect(where.id).toEqual({ in: [5, 6, 7, 8, 9, 10] });
    expect(where.createdAt).toEqual({ gt: new Date(NOW.getTime() - 8 * DAY) });
    expect(dbMock.dbRead.user.findMany).not.toHaveBeenCalled();
  });

  it('keeps an account one minute short of eight days, and not one a minute past', async () => {
    dbMock.dbWrite.user.findMany.mockResolvedValue([
      account(5, { createdAt: new Date(NOW.getTime() - 7 * DAY - 60_000) }),
      account(6, { createdAt: new Date(NOW.getTime() - 8 * DAY - 60_000) }),
    ]);
    expect([...(await scamEligibleAuthors([5, 6]))]).toEqual([5]);
  });

  it('drops the age filter when asked', async () => {
    dbMock.dbWrite.user.findMany.mockResolvedValue([
      account(5, { createdAt: new Date(NOW.getTime() - 900 * DAY) }),
    ]);
    expect([...(await scamEligibleAuthors([5], { ignoreAccountAge: true }))]).toEqual([5]);
    expect(dbMock.dbWrite.user.findMany.mock.calls[0][0].where.createdAt).toBeUndefined();
  });

  it('reads nothing for an empty or system-only list', async () => {
    expect((await scamEligibleAuthors([-1, 0])).size).toBe(0);
    expect(dbMock.dbWrite.user.findMany).not.toHaveBeenCalled();
  });
});

describe('scam profiles', () => {
  it.each(['Comment', 'CommentV2', 'ResourceReview', 'User', 'UserProfile'])(
    '%s requests only the scam label',
    (entityType) => expect(getTextScanProfile(entityType)?.labels).toEqual(['scam'])
  );

  it.each([
    ['Comment', 'comment'],
    ['CommentV2', 'commentV2'],
  ] as const)(
    '%s reads the primary, names the author and dates the content by its last edit',
    async (entityType, model) => {
      dbMock.dbWrite[model].findMany.mockResolvedValue([
        {
          id: 1,
          userId: 9,
          updatedAt: EDITED,
          content: '<p>hello <a href="https://x.example">there</a></p>',
        },
      ]);
      eligible(9);
      const subject = (await load(entityType, [1])).get(1);
      expect(subject).toEqual({
        fields: [{ heading: 'Comment', text: 'hello [link: https://x.example] there' }],
        declared: {},
        userId: 9,
        meta: { subjectUserId: 9, contentAt: EDITED.toISOString() },
      });
      expect(dbMock.dbRead[model].findMany).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['Comment', 'comment'],
    ['CommentV2', 'commentV2'],
  ] as const)('%s drops an author outside the scam window', async (entityType, model) => {
    dbMock.dbWrite[model].findMany.mockResolvedValue([
      { id: 1, userId: 9, updatedAt: EDITED, content: 'x' },
    ]);
    eligible();
    expect((await load(entityType, [1])).size).toBe(0);
  });

  it('ResourceReview scans details and skips short ones', async () => {
    dbMock.dbWrite.resourceReview.findMany.mockResolvedValue([
      { id: 3, userId: 4, updatedAt: EDITED, details: '<p>Great model</p>' },
    ]);
    eligible(4);
    const subject = (await load('ResourceReview', [3])).get(3);
    expect(subject?.fields).toEqual([{ heading: 'Review', text: 'Great model' }]);
    expect(subject?.userId).toBe(4);
    expect(getTextScanProfile('ResourceReview')?.minChars).toBe(25);
  });

  it('User scans the username of live accounts at any age', async () => {
    dbMock.dbWrite.user.findMany
      .mockResolvedValueOnce([
        { id: 5, username: 'CivitaiHelpDesk' },
        { id: 6, username: null },
      ])
      .mockResolvedValueOnce([{ id: 5, isModerator: false }]);
    const map = await load('User', [5, 6]);
    expect([...map.keys()]).toEqual([5]);
    expect(map.get(5)).toEqual({
      fields: [{ heading: 'Username', text: 'CivitaiHelpDesk' }],
      declared: {},
      userId: 5,
      meta: { subjectUserId: 5 },
    });
    expect(dbMock.dbWrite.user.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [5, 6] },
      deletedAt: null,
    });
    expect(dbMock.dbWrite.user.findMany.mock.calls[1][0].where.createdAt).toBeUndefined();
  });

  it('UserProfile scans both bios and both announcements, keyed by user', async () => {
    dbMock.dbWrite.userProfile.findMany.mockResolvedValue([
      { userId: 7, bio: 'b', message: 'm', sfwBio: 'sb', sfwMessage: null },
    ]);
    eligible(7);
    const subject = (await load('UserProfile', [7])).get(7);
    expect(subject?.fields).toEqual([
      { heading: 'Bio', text: 'b' },
      { heading: 'Profile announcement', text: 'm' },
      { heading: 'Bio (SFW domain)', text: 'sb' },
      { heading: 'Profile announcement (SFW domain)', text: '' },
    ]);
    expect(subject?.userId).toBe(7);
    expect(subject?.meta).toEqual({ subjectUserId: 7 });
    expect(dbMock.dbRead.userProfile.findMany).not.toHaveBeenCalled();
  });
});
