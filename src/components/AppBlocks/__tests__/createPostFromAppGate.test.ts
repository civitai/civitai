import { describe, expect, it, vi } from 'vitest';

import {
  buildCreatePostConsentCopy,
  CREATE_POST_HOST_ERRORS,
  createPostSettlement,
  resolveCreatePostRequest,
  type CreatePostPreview,
} from '~/components/AppBlocks/createPostFromAppGate';

/**
 * The host half of the `CREATE_POST_FROM_APP` bridge: the drop/refuse/proceed
 * decision, the exactly-once + consent latch, and the consent copy.
 *
 * 🔴 THE LATCH TESTS ARE THE POINT OF THIS FILE. `declined` must mean "no post
 * was created", and the naive implementation gets that wrong in a way no type can
 * catch: `ConfirmDialog` keeps ESC/overlay live during the awaited `onConfirm`,
 * so a dismissal mid-flight wins a bare `settled` boolean and replies `declined`
 * while the post lands. The publish bridge still carries that bug. These cases
 * replay both orderings.
 */

function preview(over: Partial<CreatePostPreview> = {}): CreatePostPreview {
  return {
    title: 'A study in blue',
    detail: 'Three renders from the same seed.',
    tags: ['anime'],
    droppedTags: [],
    images: [{ url: 'https://img.example/a', width: 1, height: 1 }],
    gallery: null,
    ...over,
  };
}

const BASE = { ready: true, signedIn: true, reviewNack: false };

describe('resolveCreatePostRequest', () => {
  it('DROPS only when there is no usable requestId — nothing is awaiting a reply', () => {
    expect(resolveCreatePostRequest({ raw: undefined, ...BASE }).kind).toBe('drop');
    expect(resolveCreatePostRequest({ raw: 'not-an-object', ...BASE }).kind).toBe('drop');
    expect(resolveCreatePostRequest({ raw: {}, ...BASE }).kind).toBe('drop');
    expect(resolveCreatePostRequest({ raw: { requestId: 42 }, ...BASE }).kind).toBe('drop');
    expect(resolveCreatePostRequest({ raw: { requestId: '' }, ...BASE }).kind).toBe('drop');
  });

  it('REFUSES rather than drops once a requestId is known — a drop there hangs the block 10 min', () => {
    // The distinction this file exists to pin: after `requestId` is readable,
    // every failure must carry it back.
    const r = resolveCreatePostRequest({ raw: { requestId: 'r1' }, ...BASE });
    expect(r).toEqual({ kind: 'refuse', requestId: 'r1', error: 'no images to post' });
  });

  it.each([
    ['review-mode', { ...BASE, reviewNack: true }, 'review-mode'],
    ['a not-yet-ready host', { ...BASE, ready: false }, 'block is not ready'],
    ['an anonymous viewer', { ...BASE, signedIn: false }, 'sign in to post'],
  ])('refuses %s with its own message', (_label, flags, error) => {
    const r = resolveCreatePostRequest({
      raw: { requestId: 'r1', sources: [{ kind: 'workflow', workflowId: 'w' }] },
      ...flags,
    });
    expect(r).toEqual({ kind: 'refuse', requestId: 'r1', error });
  });

  it('review-mode wins over every other refusal', () => {
    // Ordering claim: a moderator previewing an unapproved app must see the
    // review refusal, not a downstream one that implies the action is available.
    const r = resolveCreatePostRequest({
      raw: { requestId: 'r1' },
      ready: false,
      signedIn: false,
      reviewNack: true,
    });
    expect(r).toMatchObject({ kind: 'refuse', error: 'review-mode' });
  });

  it('proceeds with the optional fields it can read, and omits the ones it cannot', () => {
    const r = resolveCreatePostRequest({
      raw: {
        requestId: 'r1',
        sources: [{ kind: 'published', imageIds: [1] }],
        title: 'T',
        detail: 'D',
        tags: ['a', 7, 'b'],
        modelVersionId: 900,
      },
      ...BASE,
    });
    expect(r).toEqual({
      kind: 'proceed',
      request: {
        requestId: 'r1',
        sources: [{ kind: 'published', imageIds: [1] }],
        title: 'T',
        detail: 'D',
        tags: ['a', 'b'],
        modelVersionId: 900,
      },
    });
  });

  it('drops a NON-INTEGER modelVersionId rather than forwarding it', () => {
    const r = resolveCreatePostRequest({
      raw: { requestId: 'r1', sources: [{}], modelVersionId: 1.5 },
      ...BASE,
    });
    expect(r).toMatchObject({ kind: 'proceed' });
    expect((r as { request: Record<string, unknown> }).request.modelVersionId).toBeUndefined();
  });

  it('does NOT bound text or cap tags — the server is the gate, not this layer', () => {
    // Asserted POSITIVELY so nobody "hardens" the client and starts believing it.
    // A 10,000-char detail passes here and is refused by `validateBlockPostText`.
    const long = 'x'.repeat(10_000);
    const r = resolveCreatePostRequest({
      raw: { requestId: 'r1', sources: [{}], detail: long, tags: Array(50).fill('t') },
      ...BASE,
    });
    expect(r).toMatchObject({ kind: 'proceed' });
    expect((r as { request: { detail?: string; tags?: string[] } }).request.detail).toHaveLength(
      10_000
    );
    expect((r as { request: { tags?: string[] } }).request.tags).toHaveLength(50);
  });
});

describe('createPostSettlement — exactly-once + the consent latch', () => {
  it('emits exactly once and stamps the requestId', () => {
    const emit = vi.fn();
    const s = createPostSettlement({ requestId: 'r1', emit });
    s.reply({ result: { postId: 1 } });
    s.reply({ error: 'too late' });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ requestId: 'r1', result: { postId: 1 } });
  });

  it('a dismissal BEFORE consent replies `declined`', () => {
    const emit = vi.fn();
    const s = createPostSettlement({ requestId: 'r1', emit });
    s.decline();
    expect(emit).toHaveBeenCalledWith({ requestId: 'r1', error: 'declined' });
  });

  it('🔴 a dismissal AFTER consent is a NO-OP — `declined` may never describe a post that exists', () => {
    // The measured ConfirmDialog behaviour: ESC during the awaited onConfirm. A
    // bare `settled` latch replies `declined` here while the write completes.
    const emit = vi.fn();
    const s = createPostSettlement({ requestId: 'r1', emit });
    s.markConsented(); // synchronous, top of onConfirm
    s.decline(); // ESC mid-flight
    expect(emit).not.toHaveBeenCalled();

    // …and the in-flight write still settles the request when it finishes.
    s.reply({ result: { postId: 5150 } });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ requestId: 'r1', result: { postId: 5150 } });
  });

  it('a dismissal after consent AND after a failure reply stays a no-op', () => {
    const emit = vi.fn();
    const s = createPostSettlement({ requestId: 'r1', emit });
    s.markConsented();
    s.reply({ error: 'server said no' });
    s.decline();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ requestId: 'r1', error: 'server said no' });
  });

  it('two settlements for two requests are independent', () => {
    const emit = vi.fn();
    const a = createPostSettlement({ requestId: 'a', emit });
    const b = createPostSettlement({ requestId: 'b', emit });
    a.reply({ error: 'x' });
    b.reply({ error: 'y' });
    expect(emit).toHaveBeenCalledTimes(2);
  });
});

describe('buildCreatePostConsentCopy', () => {
  it('names the app, the image count, and the PUBLIC/byline consequence', () => {
    const copy = buildCreatePostConsentCopy({
      appName: 'Benchmarker',
      preview: preview({ images: [{ url: 'a', width: null, height: null }] }),
    });
    expect(copy.title).toBe('Publish this post to your profile?');
    expect(copy.intro).toBe(
      'Benchmarker wants to publish 1 image as a post on your Civitai profile.'
    );
    // The two consequences a thumbnail cannot show.
    expect(copy.destination).toContain('public');
    expect(copy.destination).toContain('under your name');
  });

  it('pluralises the image count', () => {
    const copy = buildCreatePostConsentCopy({
      appName: 'App',
      preview: preview({
        images: [
          { url: 'a', width: null, height: null },
          { url: 'b', width: null, height: null },
        ],
      }),
    });
    expect(copy.intro).toContain('2 images');
  });

  it('SANITIZES a spoofing app name and falls back when nothing legible remains', () => {
    // The publish confirm does NOT do this at its call site; this one must.
    const bidi = buildCreatePostConsentCopy({
      appName: 'Evil‮App',
      preview: preview(),
    });
    expect(bidi.intro).not.toContain('‮');

    const empty = buildCreatePostConsentCopy({ appName: '​​', preview: preview() });
    expect(empty.intro).toContain('This app');
    const missing = buildCreatePostConsentCopy({ appName: null, preview: preview() });
    expect(missing.intro).toContain('This app');
  });

  it('names the HOST-RESOLVED model + version when a gallery attach is requested', () => {
    const copy = buildCreatePostConsentCopy({
      appName: 'App',
      preview: preview({
        gallery: { modelVersionId: 3100, modelName: 'DreamThing', versionName: 'v2.0' },
      }),
    });
    expect(copy.galleryLine).toBe('It will also appear in the gallery for DreamThing — v2.0.');
  });

  it('omits the gallery line entirely when there is no attach', () => {
    expect(
      buildCreatePostConsentCopy({ appName: 'App', preview: preview() }).galleryLine
    ).toBeNull();
  });

  it('surfaces dropped tags so a silent discard is visible to the viewer', () => {
    const copy = buildCreatePostConsentCopy({
      appName: 'App',
      preview: preview({ droppedTags: ['nonexistent-tag', 'another'] }),
    });
    expect(copy.droppedTagsLine).toBe(
      'These requested tags do not exist and will not be added: nonexistent-tag, another.'
    );
  });

  it('omits the dropped-tags line when nothing was dropped', () => {
    expect(
      buildCreatePostConsentCopy({ appName: 'App', preview: preview() }).droppedTagsLine
    ).toBeNull();
  });
});

describe('CREATE_POST_HOST_ERRORS — the reply contract', () => {
  it('every refusal this layer can emit is a declared code', () => {
    // A typed constant rather than scattered literals so the SDK can branch on
    // them and `tsc` catches a typo at the emit site.
    const emitted = [
      resolveCreatePostRequest({
        raw: { requestId: 'r' },
        ready: true,
        signedIn: true,
        reviewNack: true,
      }),
      resolveCreatePostRequest({
        raw: { requestId: 'r' },
        ready: false,
        signedIn: true,
        reviewNack: false,
      }),
      resolveCreatePostRequest({
        raw: { requestId: 'r' },
        ready: true,
        signedIn: false,
        reviewNack: false,
      }),
      resolveCreatePostRequest({
        raw: { requestId: 'r' },
        ready: true,
        signedIn: true,
        reviewNack: false,
      }),
    ]
      .filter((d): d is Extract<typeof d, { kind: 'refuse' }> => d.kind === 'refuse')
      .map((d) => d.error);

    expect(emitted).toHaveLength(4);
    for (const e of emitted) expect(CREATE_POST_HOST_ERRORS).toContain(e);
  });

  it('the settlement emits the declared `declined` code verbatim', () => {
    const emit = vi.fn();
    createPostSettlement({ requestId: 'r', emit }).decline();
    expect(emit).toHaveBeenCalledWith({ requestId: 'r', error: 'declined' });
    expect(CREATE_POST_HOST_ERRORS).toContain('declined');
  });

  it('🔴 the list is CLOSED for HOST codes but must NOT bound what a block RECEIVES', () => {
    // The SDK-side validator has to accept ANY string. The server's own refusal
    // messages travel through the SAME field, and a reply that fails validation
    // is DROPPED before correlation — wedging the block for ten minutes rather
    // than surfacing the reason. Pinned with a real server message so the
    // constant can never be mistaken for an allowlist.
    const serverMessage = 'this app may not attach posts to its own publisher’s models';
    expect(CREATE_POST_HOST_ERRORS as readonly string[]).not.toContain(serverMessage);

    // …and the settlement carries it through untouched, which is what the block
    // must be able to display.
    const emit = vi.fn();
    createPostSettlement({ requestId: 'r', emit }).reply({ error: serverMessage });
    expect(emit).toHaveBeenCalledWith({ requestId: 'r', error: serverMessage });
  });
});
