import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The module imports `./db`, which demands both connection variables at module scope. The syntax half
 * touches neither; the live half is driven through this fake, which answers only the two id probes.
 */
const rows = vi.hoisted(() => ({
  model: null as { id: number } | null,
  version: null as { id: number; modelId: number } | null,
}));

const probe = (table: string) => {
  const chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst: async () => (table === 'Model' ? rows.model : rows.version) ?? undefined,
  };
  return chain;
};

vi.mock('../db', () => ({
  dbRead: { selectFrom: (table: string) => probe(table) },
  dbWrite: {},
}));

const { parseEnumArray, resolveModelRef, resolveModelRefLive } = await import(
  '../model-lookup.service'
);

beforeEach(() => {
  rows.model = null;
  rows.version = null;
});

describe('resolveModelRef', () => {
  it('leaves a bare id undecided', () => {
    expect(resolveModelRef('1234')).toEqual({ kind: 'bare', id: 1234 });
    expect(resolveModelRef('  1234  ')).toEqual({ kind: 'bare', id: 1234 });
  });

  it('takes a model URL, slug and all', () => {
    expect(resolveModelRef('https://civitai.com/models/1234/some-model-name')).toEqual({
      kind: 'model',
      modelId: 1234,
      versionId: null,
    });
  });

  it('keeps the version a pasted address bar carries', () => {
    expect(resolveModelRef('https://civitai.com/models/1234?modelVersionId=5678')).toEqual({
      kind: 'model',
      modelId: 1234,
      versionId: 5678,
    });
    expect(
      resolveModelRef('https://civitai.red/models/1234/name?foo=1&modelVersionId=5678')
    ).toEqual({ kind: 'model', modelId: 1234, versionId: 5678 });
  });

  /**
   * 🔴 `/model-versions/5678` is a real main-app route — it redirects to the model page, so a moderator
   * investigating a version genuinely holds one. It also contains a digit run after a `/model…`
   * segment, so a model rule applied first reads it as MODEL 5678: a real, unrelated row presented as
   * the thing that was pasted. Same shape as the `/posts/` bug Image Lookup shipped.
   */
  it('reads a model-version URL as a version, not as model 5678', () => {
    expect(resolveModelRef('https://civitai.com/model-versions/5678')).toEqual({
      kind: 'version',
      versionId: 5678,
    });
  });

  it('refuses an id past int4 rather than passing it to the query', () => {
    expect(resolveModelRef('12341234')).toEqual({ kind: 'bare', id: 12341234 });
    expect(resolveModelRef('99999999999')).toBeNull();
    expect(resolveModelRef('/model-versions/99999999999')).toBeNull();
  });

  // The model is still the thing being asked about, so an over-long version id must not take it down.
  it('drops an out-of-range pinned version but keeps the model', () => {
    expect(resolveModelRef('/models/1234?modelVersionId=99999999999')).toEqual({
      kind: 'model',
      modelId: 1234,
      versionId: null,
    });
  });

  it('is null for anything with no id in it', () => {
    expect(resolveModelRef('')).toBeNull();
    expect(resolveModelRef('   ')).toBeNull();
    expect(resolveModelRef('some-model-name')).toBeNull();
    expect(resolveModelRef('https://civitai.com/user/someone')).toBeNull();
  });

  // A post or image URL also ends in digits; without the `/models/` segment being required, each would
  // resolve as an unrelated model.
  it('does not read a post or image URL as a model id', () => {
    expect(resolveModelRef('https://civitai.com/posts/1234')).toBeNull();
    expect(resolveModelRef('https://civitai.com/images/1234')).toBeNull();
  });
});

/**
 * `Model.id` and `ModelVersion.id` come from separate sequences whose ranges overlap across most of
 * their length, so a bare number is genuinely ambiguous and nothing in the string says which it is.
 */
describe('resolveModelRefLive', () => {
  it('reads a bare id that is only a model as a model', async () => {
    rows.model = { id: 1234 };

    await expect(resolveModelRefLive('1234')).resolves.toEqual({
      modelId: 1234,
      versionId: null,
      resolvedFromVersion: null,
      alsoAVersion: null,
    });
  });

  it('falls back to the VERSION when a bare id is not a model', async () => {
    rows.version = { id: 3367012, modelId: 2971194 };

    await expect(resolveModelRefLive('3367012')).resolves.toEqual({
      modelId: 2971194,
      versionId: 3367012,
      resolvedFromVersion: 3367012,
      alsoAVersion: null,
    });
  });

  /**
   * 🔴 The ambiguous case, and the one that was silently wrong: the id is valid as both. The model
   * wins — that is the common intent — but `alsoAVersion` is what lets the page offer the other
   * reading instead of answering a question the moderator may not have asked.
   */
  it('reports the other reading when a bare id is BOTH', async () => {
    rows.model = { id: 1234 };
    rows.version = { id: 1234, modelId: 999 };

    await expect(resolveModelRefLive('1234')).resolves.toEqual({
      modelId: 1234,
      versionId: null,
      resolvedFromVersion: null,
      alsoAVersion: 1234,
    });
  });

  it('resolves a version URL to its model with the version pinned', async () => {
    rows.model = { id: 5678 };
    rows.version = { id: 5678, modelId: 999 };

    await expect(resolveModelRefLive('/model-versions/5678')).resolves.toEqual({
      modelId: 999,
      versionId: 5678,
      resolvedFromVersion: 5678,
      alsoAVersion: null,
    });
  });

  // A term that NAMES a version must never fall back to the model reading, even though that id is also
  // a live model — ruling that fallback out is what `?mv=` exists for.
  it('is not-found for a version URL naming no version, even when the id is a model', async () => {
    rows.model = { id: 5678 };

    await expect(resolveModelRefLive('/model-versions/5678')).resolves.toBeNull();
  });

  it('leaves a bare id that is neither to render as not-found', async () => {
    await expect(resolveModelRefLive('4242')).resolves.toEqual({
      modelId: 4242,
      versionId: null,
      resolvedFromVersion: null,
      alsoAVersion: null,
    });
  });

  it('never probes for a model URL', async () => {
    rows.version = { id: 1234, modelId: 999 };

    await expect(resolveModelRefLive('https://civitai.com/models/1234')).resolves.toEqual({
      modelId: 1234,
      versionId: null,
      resolvedFromVersion: null,
      alsoAVersion: null,
    });
  });
});

/**
 * The shape this normalises is what a page 500s on, and only at render: node-postgres parses `text[]`
 * and `int[]` but not an array of a user-defined enum, so `CommercialUse[]` arrives as the literal
 * `{Image,RentCivit}` while the generated types promise an array. Typecheck and lint both pass.
 */
describe('parseEnumArray', () => {
  it('parses the literal Postgres hands back for an enum array', () => {
    expect(parseEnumArray('{Image,RentCivit}')).toEqual(['Image', 'RentCivit']);
    expect(parseEnumArray('{Image}')).toEqual(['Image']);
  });

  it('reads an empty array as empty, not as one empty entry', () => {
    expect(parseEnumArray('{}')).toEqual([]);
  });

  // If a parser is ever registered for these types the column starts arriving already parsed, and this
  // must keep working rather than stringifying an array into one entry.
  it('passes an already-parsed array through', () => {
    expect(parseEnumArray(['Image', 'Sell'])).toEqual(['Image', 'Sell']);
  });

  it('is empty for null rather than throwing', () => {
    expect(parseEnumArray(null)).toEqual([]);
    expect(parseEnumArray(undefined)).toEqual([]);
  });
});
