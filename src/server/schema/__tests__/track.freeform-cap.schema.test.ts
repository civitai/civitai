import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addViewSchema,
  trackActionInputSchema,
  trackSearchSchema,
} from '~/server/schema/track.schema';

// The limits are pinned as literals, so a test cannot follow a constant that drifts.
const FILTERS_CAP = 65_536;
const DETAILS_CAP = 262_144;
const FILTERS_MESSAGE = 'exceeds 65536 serialized characters';
const DETAILS_MESSAGE = 'exceeds 262144 serialized characters';

const VIEW = { type: 'ModelView', entityType: 'Model', entityId: 1 } as const;
const SEARCH = { query: 'cat', index: 'models' };
const CANCEL = { type: 'Membership_Cancel', details: { reason: 'r', from: 'f' } } as const;

/** `{ note }` whose JSON is exactly `length` characters. */
const ofLength = (length: number) => ({ note: 'x'.repeat(length - '{"note":""}'.length) });

/** A `Membership_Cancel` action whose whole JSON is exactly `length` characters. */
const actionOfLength = (length: number) => {
  const base = { ...CANCEL, details: { ...CANCEL.details, note: '' } };
  return {
    ...base,
    details: { ...base.details, note: 'x'.repeat(length - JSON.stringify(base).length) },
  };
};

/**
 * A large search-style action: a long query and many short matched terms, well over the filters
 * cap and under the action cap.
 */
const largeProfanitySearch = () => {
  const matches = Array.from({ length: 12_000 }, (_, i) => `term${i % 1000}`);
  return {
    type: 'ProfanitySearch' as const,
    details: { query: 'q '.repeat(2_000).trim(), matches },
  };
};

const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : r.error?.issues.map((i) => i.message);

describe('free-form tracking payload caps', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds fixtures of exactly the length asked for', () => {
    for (const n of [FILTERS_CAP - 1, FILTERS_CAP, DETAILS_CAP + 1]) {
      expect(JSON.stringify(ofLength(n)).length).toBe(n);
      expect(JSON.stringify(actionOfLength(n)).length).toBe(n);
    }
  });

  it.each([
    [FILTERS_CAP - 1, []],
    [FILTERS_CAP, []],
    [FILTERS_CAP + 1, [FILTERS_MESSAGE]],
  ])('search filters of %i characters', (length, expected) => {
    expect(messages(trackSearchSchema.safeParse({ ...SEARCH, filters: ofLength(length) }))).toEqual(
      expected
    );
  });

  it.each([
    [DETAILS_CAP - 1, []],
    [DETAILS_CAP, []],
    [DETAILS_CAP + 1, [DETAILS_MESSAGE]],
  ])('view details of %i characters', (length, expected) => {
    expect(messages(addViewSchema.safeParse({ ...VIEW, details: ofLength(length) }))).toEqual(
      expected
    );
  });

  it.each([
    [DETAILS_CAP - 1, []],
    [DETAILS_CAP, []],
    [DETAILS_CAP + 1, [DETAILS_MESSAGE]],
  ])('a whole action of %i characters', (length, expected) => {
    expect(messages(trackActionInputSchema.safeParse(actionOfLength(length)))).toEqual(expected);
  });

  it('accepts a large action and large view details that are over the filters cap', () => {
    const action = largeProfanitySearch();
    const length = JSON.stringify(action).length;
    expect(length).toBeGreaterThan(FILTERS_CAP + FILTERS_CAP / 2);
    expect(length).toBeLessThan(DETAILS_CAP);
    expect(messages(trackActionInputSchema.safeParse(action))).toEqual([]);

    const details = { search: action.details };
    expect(JSON.stringify(details).length).toBeGreaterThan(FILTERS_CAP);
    expect(messages(addViewSchema.safeParse({ ...VIEW, details }))).toEqual([]);

    // The same payload as search filters is over that cap.
    expect(messages(trackSearchSchema.safeParse({ ...SEARCH, filters: details }))).toEqual([
      FILTERS_MESSAGE,
    ]);
  });

  it('accepts a safety-signal action over the filters cap', () => {
    const action = {
      type: 'CSAM_Help_Triggered' as const,
      details: { query: 'q '.repeat(40_000).trim() },
    };
    expect(JSON.stringify(action).length).toBeGreaterThan(FILTERS_CAP);
    expect(messages(trackActionInputSchema.safeParse(action))).toEqual([]);
  });

  it('refuses a payload with more entries than fit in the cap, even ones left out of the JSON', () => {
    const filters = Object.fromEntries(
      Array.from({ length: 40_000 }, (_, i) => [`k${i}`, undefined])
    );
    expect(JSON.stringify(filters).length).toBe(2);
    expect(messages(trackSearchSchema.safeParse({ ...SEARCH, filters }))).toEqual([
      FILTERS_MESSAGE,
    ]);
  });

  it('accepts an event with no free-form payload', () => {
    expect(addViewSchema.safeParse(VIEW).success).toBe(true);
    expect(trackSearchSchema.safeParse(SEARCH).success).toBe(true);
    expect(trackActionInputSchema.safeParse(CANCEL).success).toBe(true);
  });

  it('refuses a payload far over the cap without serializing it', () => {
    const filters = { tags: new Array(10_000).fill({ name: 'x'.repeat(1_000) }) };
    const stringify = JSON.stringify;
    let stringified = 0;
    vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof stringify>) => {
      const out = stringify(...args);
      stringified += out?.length ?? 0;
      return out;
    });
    const result = trackSearchSchema.safeParse({ ...SEARCH, filters });
    const view = addViewSchema.safeParse({ ...VIEW, details: { filters } });
    const action = trackActionInputSchema.safeParse({
      ...CANCEL,
      details: { ...CANCEL.details, filters },
    });
    vi.restoreAllMocks();
    expect(messages(result)).toEqual([FILTERS_MESSAGE]);
    expect(messages(view)).toEqual([DETAILS_MESSAGE]);
    expect(messages(action)).toEqual([DETAILS_MESSAGE]);
    // zod writes a few small strings of its own.
    expect(stringified).toBeLessThan(10_000);
  });
});
