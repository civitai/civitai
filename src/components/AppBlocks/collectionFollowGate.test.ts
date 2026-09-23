import { describe, expect, it, vi } from 'vitest';
import {
  buildCollectionFollowConsentCopy,
  createCollectionFollowSettlement,
  createCollectionLookupBudget,
  resolveCollectionFollowRequest,
  resolveCollectionIdentity,
} from './collectionFollowGate';

/**
 * Unit pins for the SHARED decision layer behind the collection-follow host
 * bridge (SET_COLLECTION_FOLLOW). Both hosts route every message through
 * `resolveCollectionFollowRequest`, so the security properties are pinned once
 * here and exercised end-to-end per host in
 * `PageBlockHostCollectionFollow.browser.test.tsx` /
 * `IframeHostCollectionFollow.browser.test.tsx`.
 */

const ok = { ready: true, signedIn: true, reviewNack: false };

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
        ready: true,
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
        ready: true,
        signedIn: true,
        reviewNack: true,
      })
    ).toEqual({ kind: 'refuse', requestId: 'rq4', error: 'review-mode' });
  });

  it('the review NACK outranks the anonymous refusal (both refuse; review is named first)', () => {
    expect(
      resolveCollectionFollowRequest({
        raw: { requestId: 'rq5', collectionId: 11, follow: true },
        ready: true,
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

/**
 * 🔴 F2 REGRESSION. Before this branch the two handlers gated on nothing but the
 * payload and the viewer, so a block that had never sent `BLOCK_READY` — i.e. a
 * page the viewer had not interacted with at all — could pop a permission modal
 * on load. Three sibling handlers already document the opposite posture; this is
 * the only ungated one that performs an ACCOUNT WRITE.
 */
describe('resolveCollectionFollowRequest — pre-handshake gate', () => {
  it('🔴 REFUSES a pre-handshake request with `not-ready`, WITH a reply (never a silent drop)', () => {
    expect(
      resolveCollectionFollowRequest({
        raw: { requestId: 'rq_pre', collectionId: 77, follow: true },
        ready: false,
        signedIn: true,
        reviewNack: false,
      })
    ).toEqual({ kind: 'refuse', requestId: 'rq_pre', error: 'not-ready' });
  });

  it('the pre-handshake refusal outranks BOTH the anonymous and the malformed refusals', () => {
    // Otherwise a pre-handshake block learns whether the viewer is signed in.
    expect(
      resolveCollectionFollowRequest({
        raw: { requestId: 'rq_pre2', collectionId: -1, follow: 'nope' },
        ready: false,
        signedIn: false,
        reviewNack: false,
      })
    ).toEqual({ kind: 'refuse', requestId: 'rq_pre2', error: 'not-ready' });
  });

  it('the review NACK still outranks the pre-handshake refusal', () => {
    expect(
      resolveCollectionFollowRequest({
        raw: { requestId: 'rq_pre3', collectionId: 3, follow: true },
        ready: false,
        signedIn: true,
        reviewNack: true,
      })
    ).toEqual({ kind: 'refuse', requestId: 'rq_pre3', error: 'review-mode' });
  });

  it('positive control: the SAME request with ready:true reaches `confirm`', () => {
    // Without this the block above could pass merely because everything refuses.
    expect(
      resolveCollectionFollowRequest({
        raw: { requestId: 'rq_pre', collectionId: 77, follow: true },
        ready: true,
        signedIn: true,
        reviewNack: false,
      })
    ).toEqual({
      kind: 'confirm',
      request: { requestId: 'rq_pre', collectionId: 77, follow: true },
    });
  });
});

/**
 * 🔴 F1 REGRESSION, half one. The host must learn the collection's identity from
 * the id it is about to act on — and a collection it cannot see must be
 * indistinguishable from one that does not exist.
 */
describe('resolveCollectionIdentity', () => {
  it('reads the name and owner from a `collection.getById` result', () => {
    expect(
      resolveCollectionIdentity({
        collection: { id: 77, name: 'Cute Cats', user: { id: 3, username: 'alice' } },
        permissions: { read: true },
      })
    ).toEqual({ kind: 'ok', identity: { name: 'Cute Cats', ownerUsername: 'alice' } });
  });

  it('🔴 a NONEXISTENT id and a PRIVATE collection resolve IDENTICALLY (no existence leak)', () => {
    // `getCollectionByIdHandler` returns `{ collection: null }` for BOTH: a
    // missing row and a viewer with no read permission. Anything that told them
    // apart would let a block enumerate private collection ids by asking the host
    // to name them.
    const notFound = resolveCollectionIdentity({ collection: null, permissions: {} });
    const forbidden = resolveCollectionIdentity({
      collection: null,
      permissions: { read: false, write: false, manage: false },
    });
    expect(notFound).toEqual({ kind: 'unavailable' });
    expect(forbidden).toEqual(notFound);
  });

  it('treats any unexpected shape as unavailable rather than rendering undefined', () => {
    for (const raw of [undefined, null, 'nope', 42, {}, { collection: 'yes' }, { collection: 7 }]) {
      expect(resolveCollectionIdentity(raw), JSON.stringify(raw) ?? 'undefined').toEqual({
        kind: 'unavailable',
      });
    }
  });

  it('🔴 SANITIZES the fetched name and owner — other users control these strings', () => {
    const res = resolveCollectionIdentity({
      collection: { name: 'Cute‮Cats\nHere', user: { username: 'ali\u0000ce' } },
    });
    expect(res).toEqual({
      kind: 'ok',
      identity: { name: 'CuteCats Here', ownerUsername: 'ali ce' },
    });
  });

  it('nulls a name/owner that sanitizes away entirely, rather than rendering ""', () => {
    expect(
      resolveCollectionIdentity({ collection: { name: '​​', user: { username: '   ' } } })
    ).toEqual({ kind: 'ok', identity: { name: null, ownerUsername: null } });
  });
});

/**
 * 🔴 F3 REGRESSION. `ConfirmDialog.handleConfirm` awaits `onConfirm()` BEFORE
 * closing its Modal, and does not disable escape / overlay dismissal while it
 * waits — so a dismissal mid-flight used to win the exactly-once latch with
 * `declined` for a write that completed. `declined` MUST mean "no write occurred".
 */
describe('createCollectionFollowSettlement', () => {
  it('replies exactly once and stamps the requestId', () => {
    const emit = vi.fn();
    const s = createCollectionFollowSettlement({ requestId: 'rq1', emit });
    s.reply({ result: { collectionId: 7, followed: true } });
    s.reply({ error: 'too late' });
    s.decline();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      requestId: 'rq1',
      result: { collectionId: 7, followed: true },
    });
  });

  it('a dismissal BEFORE consent replies `declined`', () => {
    const emit = vi.fn();
    const s = createCollectionFollowSettlement({ requestId: 'rq2', emit });
    s.decline();
    expect(emit).toHaveBeenCalledWith({ requestId: 'rq2', error: 'declined' });
  });

  it('🔴 a dismissal AFTER consent is a NO-OP — the in-flight write reports itself', () => {
    const emit = vi.fn();
    const s = createCollectionFollowSettlement({ requestId: 'rq3', emit });
    s.markConsented(); // synchronous, at the top of onConfirm
    s.decline(); // ESC / overlay click while the mutation is in flight
    expect(emit).not.toHaveBeenCalled();
    s.reply({ result: { collectionId: 9, followed: true } }); // mutation resolves
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      requestId: 'rq3',
      result: { collectionId: 9, followed: true },
    });
  });

  it('a dismissal after consent does not suppress a FAILED write either', () => {
    const emit = vi.fn();
    const s = createCollectionFollowSettlement({ requestId: 'rq4', emit });
    s.markConsented();
    s.decline();
    s.reply({ error: 'FORBIDDEN' });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ requestId: 'rq4', error: 'FORBIDDEN' });
  });
});

describe('buildCollectionFollowConsentCopy', () => {
  const named = { collectionId: 77, collection: { name: 'Cute Cats', ownerUsername: 'alice' } };

  it('asks a FOLLOW question naming the app, with a Follow confirm label', () => {
    const copy = buildCollectionFollowConsentCopy({
      follow: true,
      appName: 'Playable Collections',
      ...named,
    });
    expect(copy.title).toBe('Follow this collection?');
    expect(copy.confirmLabel).toBe('Follow');
    expect(copy.message).toContain('Playable Collections');
    expect(copy.message).toContain('follow');
  });

  /**
   * 🔴 F1 REGRESSION, half two. The whole sentence, pinned. A guard on WORDS is
   * walkable by rewording, and the defect being fixed here WAS a wording: the
   * message named no collection at all, so host chrome asserted nothing the
   * block's own "Follow ⭐ Cute Cats" card could contradict. A cosmetic reword
   * must fail this test.
   */
  it('🔴 NAMES THE COLLECTION the host resolved — id 900123 cannot hide behind "a collection"', () => {
    expect(
      buildCollectionFollowConsentCopy({ follow: true, appName: 'Evil App', ...named }).message
    ).toBe(
      'Evil App wants to follow “Cute Cats” by alice with your Civitai account. It will appear in your collections until you unfollow it.'
    );
    expect(
      buildCollectionFollowConsentCopy({ follow: false, appName: 'Evil App', ...named }).message
    ).toBe(
      'Evil App wants to unfollow “Cute Cats” by alice with your Civitai account. It will be removed from your collections.'
    );
  });

  it('names the collection without an owner when the owner is unknown', () => {
    expect(
      buildCollectionFollowConsentCopy({
        follow: true,
        appName: 'App',
        collectionId: 900123,
        collection: { name: 'Cute Cats', ownerUsername: null },
      }).message
    ).toBe(
      'App wants to follow “Cute Cats” with your Civitai account. It will appear in your collections until you unfollow it.'
    );
  });

  it('🔴 falls back to the numeric ID, never to an object-less sentence', () => {
    const msg = buildCollectionFollowConsentCopy({
      follow: true,
      appName: 'App',
      collectionId: 900123,
      collection: { name: null, ownerUsername: null },
    }).message;
    expect(msg).toBe(
      'App wants to follow collection #900123 with your Civitai account. It will appear in your collections until you unfollow it.'
    );
  });

  it('asks a distinct UNFOLLOW question — the two are not one string with a swapped verb', () => {
    const copy = buildCollectionFollowConsentCopy({
      follow: false,
      appName: 'Playable Collections',
      ...named,
    });
    expect(copy.title).toBe('Unfollow this collection?');
    expect(copy.confirmLabel).toBe('Unfollow');
    expect(copy.message).toContain('unfollow');
  });

  it('falls back to "This app" when the publisher name is missing or illegible', () => {
    for (const appName of [undefined, null, '', '   ', '​​']) {
      expect(
        buildCollectionFollowConsentCopy({ follow: true, appName, ...named }).message
      ).toContain('This app');
    }
  });

  it('🔴 SANITIZES the publisher-controlled name — this dialog is the consent boundary', () => {
    // A bidi override + control chars would otherwise let a publisher misrepresent
    // WHO the viewer is granting something to, on the one screen where that matters.
    const copy = buildCollectionFollowConsentCopy({
      follow: true,
      appName: 'Evil‮App\nName',
      ...named,
    });
    expect(copy.message).not.toContain('‮');
    expect(copy.message).not.toContain('\n');
    expect(copy.message).toContain('EvilApp Name');
  });
});

/**
 * 🔴 THE PER-INSTANCE LOOKUP BUDGET — the bound on the authenticated visibility
 * oracle the identity lookup opened.
 *
 * Because the host resolves the collection BEFORE opening the dialog, a block
 * learns "can this viewer see id N?" with no click and no viewer involvement, at
 * the transport's 30 messages/second. A sandboxed cross-origin block cannot make
 * that authed read itself, so the host was lending it one. These pin the bound:
 * DISTINCT ids, repeats free forever, and a refusal that carries no fact about
 * the collection.
 *
 * The behavioural cases run at `limit: 3` — deliberately NOT the production 20,
 * so a mutant that hardcodes the constant cannot survive by matching the fixture
 * — and the production default is pinned separately, with literal counts.
 */
describe('createCollectionLookupBudget', () => {
  it('admits exactly `limit` DISTINCT ids and refuses the next new one', () => {
    const budget = createCollectionLookupBudget(3);
    expect(budget.admit(101)).toBe(true);
    expect(budget.admit(202)).toBe(true);
    expect(budget.admit(303)).toBe(true);
    // The 4th distinct id is where enumeration would live.
    expect(budget.admit(404)).toBe(false);
    expect(budget.admit(505)).toBe(false);
  });

  it('🔴 a REPEAT of an admitted id is free FOREVER — re-following never stops working', () => {
    const budget = createCollectionLookupBudget(3);
    budget.admit(101);
    budget.admit(202);
    budget.admit(303);
    expect(budget.admit(404)).toBe(false); // budget is exhausted…
    // …and yet every id the viewer has already been asked about still resolves,
    // any number of times. A block that legitimately follows, unfollows and
    // re-follows one collection must not be cut off.
    for (let i = 0; i < 50; i++) {
      expect(budget.admit(101)).toBe(true);
      expect(budget.admit(202)).toBe(true);
      expect(budget.admit(303)).toBe(true);
    }
  });

  it('counts DISTINCT ids, not calls — a repeat spends one unit, not two', () => {
    const budget = createCollectionLookupBudget(3);
    for (let i = 0; i < 10; i++) expect(budget.admit(101)).toBe(true);
    // If repeats were charged, the budget would already be gone here.
    expect(budget.admit(202)).toBe(true);
    expect(budget.admit(303)).toBe(true);
    expect(budget.admit(404)).toBe(false);
  });

  it('🔴 a REFUSED id is not silently admitted by asking again', () => {
    // Otherwise the cap would be a speed bump: probe, get refused, probe again.
    const budget = createCollectionLookupBudget(3);
    budget.admit(101);
    budget.admit(202);
    budget.admit(303);
    for (let i = 0; i < 10; i++) expect(budget.admit(404)).toBe(false);
    // And a refusal must not have evicted anything that was already admitted.
    expect(budget.admit(101)).toBe(true);
  });

  it('🔴 two budgets are INDEPENDENT — no module-scope ledger to share or drain', () => {
    // The hosts hold one of these per block instance in a ref. If the ledger were
    // module scope, two blocks on a page would drain each other and a remount
    // would inherit an exhausted budget.
    const a = createCollectionLookupBudget(3);
    const b = createCollectionLookupBudget(3);
    expect(a.admit(101)).toBe(true);
    expect(a.admit(202)).toBe(true);
    expect(a.admit(303)).toBe(true);
    expect(a.admit(404)).toBe(false);
    // b has spent nothing, including on the ids a spent.
    expect(b.admit(404)).toBe(true);
    expect(b.admit(505)).toBe(true);
    expect(b.admit(606)).toBe(true);
    expect(b.admit(707)).toBe(false);
    // …and a is unchanged by any of it.
    expect(a.admit(101)).toBe(true);
    expect(a.admit(808)).toBe(false);
  });

  it('the PRODUCTION default admits 20 distinct ids and refuses the 21st', () => {
    // Literal counts, not the exported constant: this is the pin that notices if
    // the cap is quietly widened to a number enumeration could live inside.
    const budget = createCollectionLookupBudget();
    for (let i = 1; i <= 20; i++) expect(budget.admit(9000 + i)).toBe(true);
    expect(budget.admit(9021)).toBe(false);
    expect(budget.admit(9001)).toBe(true); // repeat, still free
  });
});
