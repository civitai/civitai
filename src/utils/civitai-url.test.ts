import { describe, expect, it } from 'vitest';
import { parseCivitaiUrlSafe } from '~/utils/civitai-url';

describe('parseCivitaiUrlSafe', () => {
  it('reads a model id and ignores the slug', () => {
    // getModelUrl emits all four of these shapes, and the model page rewrites a
    // stale slug on arrival — so validating one would reject working links.
    expect(parseCivitaiUrlSafe('https://civitai.com/models/123')).toEqual({
      type: 'model',
      modelId: 123,
    });
    expect(parseCivitaiUrlSafe('https://civitai.com/models/123/some-name')).toEqual({
      type: 'model',
      modelId: 123,
    });
    expect(parseCivitaiUrlSafe('https://civitai.com/models/123/a/b/c')).toEqual({
      type: 'model',
      modelId: 123,
    });
    expect(parseCivitaiUrlSafe('https://civitai.com/models/123/reviews')).toEqual({
      type: 'model',
      modelId: 123,
    });
  });

  it('reads modelVersionId from the query, and degrades rather than failing on junk', () => {
    expect(parseCivitaiUrlSafe('https://civitai.com/models/123?modelVersionId=456')).toEqual({
      type: 'model',
      modelId: 123,
      modelVersionId: 456,
    });
    expect(parseCivitaiUrlSafe('https://civitai.com/models/123/slug?modelVersionId=456')).toEqual({
      type: 'model',
      modelId: 123,
      modelVersionId: 456,
    });
    // Still a model link; the bad param must not lose it.
    expect(parseCivitaiUrlSafe('https://civitai.com/models/123?modelVersionId=abc')).toEqual({
      type: 'model',
      modelId: 123,
    });
  });

  it('reads the standalone model-version and collection routes', () => {
    expect(parseCivitaiUrlSafe('https://civitai.com/model-versions/456')).toEqual({
      type: 'modelVersion',
      modelVersionId: 456,
    });
    expect(parseCivitaiUrlSafe('https://civitai.com/collections/789')).toEqual({
      type: 'collection',
      collectionId: 789,
    });
    expect(parseCivitaiUrlSafe('https://civitai.com/collections/789/join')).toEqual({
      type: 'collection',
      collectionId: 789,
    });
  });

  it('reads a username, decoded, and ignores profile sub-pages', () => {
    expect(parseCivitaiUrlSafe('https://civitai.com/user/someone')).toEqual({
      type: 'user',
      username: 'someone',
    });
    expect(parseCivitaiUrlSafe('https://civitai.com/user/someone/models')).toEqual({
      type: 'user',
      username: 'someone',
    });
    // Emitters are inconsistent about encoding, so both forms reach us.
    expect(parseCivitaiUrlSafe('https://civitai.com/user/a%20b')).toEqual({
      type: 'user',
      username: 'a b',
    });
  });

  it('rejects route segments that are not ids', () => {
    // These are real routes. A bare Number() would turn '' into 0 and accept them.
    expect(parseCivitaiUrlSafe('https://civitai.com/models/create')).toBeNull();
    expect(parseCivitaiUrlSafe('https://civitai.com/models/train')).toBeNull();
    expect(parseCivitaiUrlSafe('https://civitai.com/collections/youtube')).toBeNull();
    expect(parseCivitaiUrlSafe('https://civitai.com/models')).toBeNull();
  });

  it('rejects numeric-ish segments that are not plain integers', () => {
    // These are what the /^\d+$/ guard is actually for. `create` and `train`
    // above are caught by Number() returning NaN on their own, so without these
    // cases the guard could be deleted and the suite would stay green.
    expect(parseCivitaiUrlSafe('https://civitai.com/models/1e3')).toBeNull();
    expect(parseCivitaiUrlSafe('https://civitai.com/models/0x10')).toBeNull();
    expect(parseCivitaiUrlSafe('https://civitai.com/models/%2012%20')).toBeNull();
    expect(parseCivitaiUrlSafe('https://civitai.com/models/12.0')).toBeNull();
    // Same guard on the query param: it must degrade to the model, not invent a version.
    expect(parseCivitaiUrlSafe('https://civitai.com/models/123?modelVersionId=1e3')).toEqual({
      type: 'model',
      modelId: 123,
    });
  });

  it('accepts host-relative input and scheme-less hosts', () => {
    expect(parseCivitaiUrlSafe('/models/123')).toEqual({ type: 'model', modelId: 123 });
    expect(parseCivitaiUrlSafe('civitai.com/models/123')).toEqual({ type: 'model', modelId: 123 });
    // No dot in the first segment, so this is a path and not a host called "models".
    expect(parseCivitaiUrlSafe('models/123')).toEqual({ type: 'model', modelId: 123 });
  });

  it('accepts our other hosts and rejects foreign ones', () => {
    expect(parseCivitaiUrlSafe('https://civitai.red/models/123')).toEqual({
      type: 'model',
      modelId: 123,
    });
    expect(parseCivitaiUrlSafe('https://www.civitai.com/models/123')).toEqual({
      type: 'model',
      modelId: 123,
    });
    expect(parseCivitaiUrlSafe('https://evil.example/models/123')).toBeNull();
    // The unanchored regexes elsewhere in the repo accept this; we must not.
    expect(parseCivitaiUrlSafe('https://evil.example/?x=civitai.com/models/123')).toBeNull();
    // These are what the (^|\.) anchor and the trailing $ actually stop. Without
    // them the anchors can be deleted with the whole suite still green, because
    // `evil.example` above is rejected by the domain body alone and proves nothing.
    expect(parseCivitaiUrlSafe('https://fakecivitai.com/models/123')).toBeNull();
    expect(parseCivitaiUrlSafe('https://evil-civitai.red/models/123')).toBeNull();
    expect(parseCivitaiUrlSafe('https://civitai.com.evil.io/models/123')).toBeNull();
  });

  it('rejects an id too large to be a safe integer', () => {
    // Covers Number.isSafeInteger; without it this returns modelId: 1e20.
    expect(parseCivitaiUrlSafe('https://civitai.com/models/99999999999999999999')).toBeNull();
  });

  it('accepts a runtime host passed by the caller', () => {
    expect(parseCivitaiUrlSafe('https://pr-4080.civitaic.com/models/123')).toBeNull();
    expect(
      parseCivitaiUrlSafe('https://pr-4080.civitaic.com/models/123', {
        hosts: ['pr-4080.civitaic.com'],
      })
    ).toEqual({ type: 'model', modelId: 123 });
  });

  it('rejects the CDN host, which is never an entity page', () => {
    expect(parseCivitaiUrlSafe('https://image.civitai.com/models/123')).toBeNull();
  });

  it('reads a tag page as a NAME, not an id', () => {
    // /tag/<name> is what the address bar holds. The name is what identifies it;
    // there is no id in this URL to fall back on.
    expect(parseCivitaiUrlSafe('https://civitai.com/tag/dragon')).toEqual({
      type: 'tag',
      tagname: 'dragon',
    });
    // Percent-escapes are decoded with the rest of the path, so a multi-word tag
    // arrives as the name the database holds rather than as 'blue%20hair'.
    expect(parseCivitaiUrlSafe('https://civitai.com/tag/blue%20hair')).toEqual({
      type: 'tag',
      tagname: 'blue hair',
    });
  });

  it('reads a single-tag feed link as an ID', () => {
    // What a tag chip in the feed links to.
    expect(parseCivitaiUrlSafe('https://civitai.com/images?tags=5499')).toEqual({
      type: 'tagId',
      tagId: 5499,
    });
  });

  it('refuses a feed link carrying more than one tag', () => {
    // 🔴 The dangerous direction: a hub source is ONE tag, so picking the first of
    // several would silently discard what the sender meant and add a source they
    // did not choose. Unrecognised is the honest answer.
    expect(parseCivitaiUrlSafe('https://civitai.com/images?tags=5499&tags=5133')).toBeNull();
  });

  it('refuses a feed link with no tag at all', () => {
    // The control for the two above: without it, a parser that returned a tag ref
    // for any /images link would pass them both.
    expect(parseCivitaiUrlSafe('https://civitai.com/images')).toBeNull();
    expect(parseCivitaiUrlSafe('https://civitai.com/images?tags=notanid')).toBeNull();
  });

  it('returns null for a bare id so the caller decides what it means', () => {
    expect(parseCivitaiUrlSafe('123')).toBeNull();
    expect(parseCivitaiUrlSafe('')).toBeNull();
    expect(parseCivitaiUrlSafe('   ')).toBeNull();
  });
});
