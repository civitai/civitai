import { describe, expect, it } from 'vitest';
import type { SiteAppealSubject } from '$lib/server/site-appeals.service';
import { approvalEffect, outcomeLabel } from '../site-appeal-display';

const account = (over: Partial<Extract<SiteAppealSubject, { kind: 'account' }>>) =>
  ({
    kind: 'account',
    bannedAt: null,
    banReason: null,
    banDetailsExternal: null,
    banDetailsInternal: null,
    muted: false,
    muteExpiresAt: null,
    muteReason: null,
    ...over,
  } satisfies SiteAppealSubject);

const unpublished = {
  unpublishedReason: null,
  customMessage: null,
  unpublishedAt: null,
  ownerBanned: false,
};

describe('approvalEffect', () => {
  it('blocks approving a banned account without the Ban permission, as the server refuses it', () => {
    const banned = account({ bannedAt: new Date('2026-10-01') });
    expect(approvalEffect(banned, false).blocked).toMatch(/Ban permission/);
    expect(approvalEffect(banned, true).blocked).toBeNull();
    expect(approvalEffect(account({ muted: true }), false).blocked).toBeNull();
  });

  it('names what an account approval lifts', () => {
    expect(approvalEffect(account({ bannedAt: new Date(), muted: true }), true).text).toBe(
      'Approving lifts the ban and the mute.'
    );
    expect(approvalEffect(account({}), true).text).toMatch(/lifts nothing/);
  });

  it('promises a republish only for a moderator-removed article or model', () => {
    const article = (status: string | null, restoresTo = 'Published') =>
      approvalEffect({ kind: 'article', title: 't', status, restoresTo, ...unpublished }, true)
        .text;
    expect(article('UnpublishedViolation')).toBe('Approving republishes the article.');
    // A draft a block took down goes back to its author: approving must not promise a publish.
    expect(article('UnpublishedViolation', 'Draft')).toBe(
      'Approving returns the article to its author as a draft, as it was when it was taken down. It is not published.'
    );
    expect(article('UnpublishedViolation', 'Unpublished')).toBe(
      'Approving returns the article to its author unpublished, as it was when it was taken down. It is not published.'
    );
    expect(article('Published')).toMatch(/already published/);
    expect(article('Unpublished')).toMatch(/restores nothing/);
    expect(article(null)).toMatch(/no longer exists/);

    const model = (status: string, deleted: boolean) =>
      approvalEffect({ kind: 'model', name: 'm', status, deleted, ...unpublished }, true).text;
    expect(model('UnpublishedViolation', false)).toBe('Approving republishes the model.');
    expect(model('UnpublishedViolation', true)).toMatch(/no longer exists/);
  });
});

describe('outcomeLabel', () => {
  it('names what the approval lifted', () => {
    expect(
      outcomeLabel(
        { type: 'success', status: 200, data: { lifted: ['ban', 'mute'] } },
        'Appeal approved'
      )
    ).toBe('Appeal approved: unbanned, unmuted');
  });

  // A lifted article may be a blocked draft, which goes back to its author unpublished.
  it('says an article was restored, not republished', () => {
    expect(
      outcomeLabel({ type: 'success', status: 200, data: { lifted: ['article'] } }, 'Approved')
    ).toBe('Approved: article restored');
  });

  it('keeps the plain outcome when nothing was lifted or the action failed', () => {
    expect(
      outcomeLabel({ type: 'success', status: 200, data: { lifted: [] } }, 'Appeal rejected')
    ).toBe('Appeal rejected');
    expect(outcomeLabel({ type: 'failure', status: 400, data: { lifted: ['ban'] } }, 'x')).toBe(
      'x'
    );
  });
});
