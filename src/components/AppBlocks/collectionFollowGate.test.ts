import { describe, expect, it } from 'vitest';
import {
  buildCollectionFollowConsentCopy,
  resolveCollectionFollowRequest,
} from './collectionFollowGate';

/**
 * Unit pins for the SHARED decision layer behind the collection-follow host
 * bridge (SET_COLLECTION_FOLLOW). Both hosts route every message through
 * `resolveCollectionFollowRequest`, so the security properties are pinned once
 * here and exercised end-to-end per host in
 * `PageBlockHostCollectionFollow.browser.test.tsx` /
 * `IframeHostCollectionFollow.browser.test.tsx`.
 */

const ok = { signedIn: true, reviewNack: false };

describe('resolveCollectionFollowRequest', () => {
  it('accepts a well-formed follow request from a signed-in viewer', () => {
    expect(
      resolveCollectionFollowRequest({
        raw: { requestId: 'rq1', collectionId: 77, follow: true },
        ...ok,
      })
    ).toEqual({ kind: 'confirm', request: { requestId: 'rq1', collectionId: 77, follow: true } });
  });

  it('accepts an UNfollow request (follow:false is a value, not an absence)', () => {
    expect(
      resolveCollectionFollowRequest({
        raw: { requestId: 'rq2', collectionId: 5, follow: false },
        ...ok,
      })
    ).toEqual({ kind: 'confirm', request: { requestId: 'rq2', collectionId: 5, follow: false } });
  });

  it('DROPS a payload with no usable requestId — there is nothing to reply to', () => {
    for (const raw of [
      undefined,
      null,
      'nope',
      42,
      {},
      { collectionId: 1, follow: true },
      { requestId: '', collectionId: 1, follow: true },
      { requestId: 7, collectionId: 1, follow: true },
    ]) {
      expect(resolveCollectionFollowRequest({ raw, ...ok })).toEqual({ kind: 'drop' });
    }
  });

  it('🔴 REFUSES an anonymous viewer — the HTTP endpoint answered 403, this replies sign-in-required', () => {
    expect(
      resolveCollectionFollowRequest({
        raw: { requestId: 'rq3', collectionId: 9, follow: true },
        signedIn: false,
        reviewNack: false,
      })
    ).toEqual({ kind: 'refuse', requestId: 'rq3', error: 'sign-in-required' });
  });

  it('🔴 REFUSES under the mod-review NACK even for a perfect request from a signed-in mod', () => {
    // This op is SESSION-authed, so it does not ride the scope-stripped review
    // token: without this branch an untrusted pending app would drive the
    // reviewing mod's own account.
    expect(
      resolveCollectionFollowRequest({
        raw: { requestId: 'rq4', collectionId: 11, follow: true },
        signedIn: true,
        reviewNack: true,
      })
    ).toEqual({ kind: 'refuse', requestId: 'rq4', error: 'review-mode' });
  });

  it('the review NACK outranks the anonymous refusal (both refuse; review is named first)', () => {
    expect(
      resolveCollectionFollowRequest({
        raw: { requestId: 'rq5', collectionId: 11, follow: true },
        signedIn: false,
        reviewNack: true,
      })
    ).toEqual({ kind: 'refuse', requestId: 'rq5', error: 'review-mode' });
  });

  it('REFUSES (never drops) a malformed collectionId — a reply, so the block cannot hang', () => {
    for (const collectionId of [0, -1, 1.5, '12', null, undefined, NaN, Infinity]) {
      const res = resolveCollectionFollowRequest({
        raw: { requestId: 'rq6', collectionId, follow: true },
        ...ok,
      });
      expect(res, `collectionId=${String(collectionId)}`).toEqual({
        kind: 'refuse',
        requestId: 'rq6',
        error: 'invalid-request',
      });
    }
    // Positive control on the same axis: `1` is the smallest accepted id, so the
    // list above cannot be passing merely because everything is refused.
    expect(
      resolveCollectionFollowRequest({
        raw: { requestId: 'rq6b', collectionId: 1, follow: true },
        ...ok,
      })
    ).toEqual({ kind: 'confirm', request: { requestId: 'rq6b', collectionId: 1, follow: true } });
  });

  it('REFUSES a non-boolean `follow` (a truthy string is not a follow instruction)', () => {
    for (const follow of ['true', 1, 0, null, undefined]) {
      expect(
        resolveCollectionFollowRequest({
          raw: { requestId: 'rq7', collectionId: 3, follow },
          ...ok,
        })
      ).toEqual({ kind: 'refuse', requestId: 'rq7', error: 'invalid-request' });
    }
  });

  it('🔴 IGNORES any user id the block tries to supply — the subject is never on the wire', () => {
    const res = resolveCollectionFollowRequest({
      raw: {
        requestId: 'rq8',
        collectionId: 4,
        follow: true,
        userId: 999,
        targetUserId: 999,
        sub: 999,
      },
      ...ok,
    });
    // The resolved request carries EXACTLY three fields; nothing a block adds
    // survives to reach a mutation call.
    expect(res).toEqual({
      kind: 'confirm',
      request: { requestId: 'rq8', collectionId: 4, follow: true },
    });
    expect(Object.keys((res as { request: object }).request).sort()).toEqual([
      'collectionId',
      'follow',
      'requestId',
    ]);
  });
});

describe('buildCollectionFollowConsentCopy', () => {
  it('asks a FOLLOW question naming the app, with a Follow confirm label', () => {
    const copy = buildCollectionFollowConsentCopy({
      follow: true,
      appName: 'Playable Collections',
    });
    expect(copy.title).toBe('Follow this collection?');
    expect(copy.confirmLabel).toBe('Follow');
    expect(copy.message).toContain('Playable Collections');
    expect(copy.message).toContain('follow');
  });

  it('asks a distinct UNFOLLOW question — the two are not one string with a swapped verb', () => {
    const copy = buildCollectionFollowConsentCopy({
      follow: false,
      appName: 'Playable Collections',
    });
    expect(copy.title).toBe('Unfollow this collection?');
    expect(copy.confirmLabel).toBe('Unfollow');
    expect(copy.message).toContain('unfollow');
  });

  it('falls back to "This app" when the publisher name is missing or illegible', () => {
    for (const appName of [undefined, null, '', '   ', '​​']) {
      expect(buildCollectionFollowConsentCopy({ follow: true, appName }).message).toContain(
        'This app'
      );
    }
  });

  it('🔴 SANITIZES the publisher-controlled name — this dialog is the consent boundary', () => {
    // A bidi override + control chars would otherwise let a publisher misrepresent
    // WHO the viewer is granting something to, on the one screen where that matters.
    const copy = buildCollectionFollowConsentCopy({
      follow: true,
      appName: 'Evil‮App\nName',
    });
    expect(copy.message).not.toContain('‮');
    expect(copy.message).not.toContain('\n');
    expect(copy.message).toContain('EvilApp Name');
  });
});
