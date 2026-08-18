import { describe, expect, it } from 'vitest';
import { buildAppsStoreFeedbackContext } from '~/components/Apps/appsStoreFeedbackContext';
import { APPS_STORE_DEFAULTS } from '~/components/Apps/appsStoreQueryParams';
import { createFeedbackSchema } from '~/server/schema/feedback.schema';
import { FEEDBACK_FILTER_VALUE_MAX_LENGTH } from '~/shared/constants/feedback.constants';

/**
 * The triage payload the `/apps` marketplace prompt attaches to a report.
 *
 * The load-bearing case is the LAST describe block. `context.filters` bounds every
 * value at `FEEDBACK_FILTER_VALUE_MAX_LENGTH` and a zod `max()` REJECTS rather than
 * truncates, so an unclipped search term does not arrive shortened — it fails the
 * whole submission. That is why the clip is a real guard and not tidiness, and why
 * these assertions drive the built context through `createFeedbackSchema` rather
 * than merely reading the returned string's length: a length assertion alone would
 * still pass if the schema's bound moved away from the constant the builder clips to.
 */
describe('buildAppsStoreFeedbackContext', () => {
  const filters = (over: Partial<typeof APPS_STORE_DEFAULTS> = {}) => ({
    ...APPS_STORE_DEFAULTS,
    ...over,
  });

  /** Round-trip through the real boundary schema — this is what "carried" means. */
  const throughSchema = (context: ReturnType<typeof buildAppsStoreFeedbackContext>) =>
    createFeedbackSchema.parse({
      area: 'apps-marketplace',
      message: 'the store looked wrong',
      context,
    }).context;

  it('reports the path and every store control', () => {
    const context = buildAppsStoreFeedbackContext({
      path: '/apps',
      filters: filters({
        kind: 'offsite',
        category: 'generation',
        sort: 'newest',
        query: 'upscale',
      }),
    });

    expect(context?.path).toBe('/apps');
    expect(context?.filters).toEqual({
      kind: 'offsite',
      category: 'generation',
      sort: 'newest',
      query: 'upscale',
    });
  });

  // Literal defaults, hand-typed rather than read back out of APPS_STORE_DEFAULTS, so
  // a change to the store's defaults surfaces here instead of being followed silently.
  it('reports the DEFAULT view rather than an empty object', () => {
    const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters() });
    expect(context?.filters).toEqual({
      kind: 'all',
      category: 'none',
      sort: 'top-rated',
      query: '',
    });
  });

  it("says 'none' for no category instead of dropping the key", () => {
    const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters() });
    expect(context?.filters).toHaveProperty('category');
    expect(context?.filters?.category).toBe('none');
  });

  // SSR: the builder runs during the server render too, where there is no `window`.
  it('carries an absent path without failing the boundary schema', () => {
    const context = buildAppsStoreFeedbackContext({ filters: filters() });
    expect(context?.path).toBeUndefined();
    expect(throughSchema(context)?.filters?.kind).toBe('all');
  });

  describe('the search term is CLIPPED to the schema bound, not passed through', () => {
    it('pins the bound this file is written against', () => {
      expect(FEEDBACK_FILTER_VALUE_MAX_LENGTH).toBe(200);
    });

    it('leaves a term inside the bound untouched', () => {
      const query = 'q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH);
      const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters({ query }) });
      expect(context?.filters?.query).toBe(query);
      expect(throughSchema(context)?.filters?.query).toBe(query);
    });

    /**
     * THE REGRESSION CASE. Without the clip this parse THROWS, and the reporter gets
     * a validation error instead of a filed report. Asserted through the schema, at
     * one character over the bound and again far over it.
     */
    it('clips a term one character past the bound so the submission still parses', () => {
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query: 'q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH + 1) }),
      });
      expect(context?.filters?.query).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH);
      expect(() => throughSchema(context)).not.toThrow();
      expect(throughSchema(context)?.filters?.query).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH);
    });

    it('clips a pathologically long term the same way', () => {
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query: 'x'.repeat(20_000) }),
      });
      expect(context?.filters?.query).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH);
      expect(() => throughSchema(context)).not.toThrow();
    });

    /**
     * 🔴 THE SURROGATE CASE. Every fixture above is ASCII, and a fixture that cannot
     * contain a surrogate pair cannot observe a surrogate bug — which is exactly why
     * this shipped.
     *
     * `slice` cuts on UTF-16 CODE UNITS, not characters. An astral-plane character
     * (any emoji) is a pair of units, so a clip point that lands between them leaves
     * a LONE HIGH SURROGATE as the last unit. That string is a legal JS value and
     * passes `z.string().max()` untouched, so the schema round-trip below cannot see
     * it either — it breaks one layer further down, where the context is written to
     * the `Feedback.context` JSON column: `JSON.stringify` emits a bare `\ud83d`
     * escape, which Postgres rejects (`Unicode low surrogate must follow a high
     * surrogate`) and Prisma's serde layer rejects before that. So the clip added to
     * keep a long search term from failing the submission ends up failing the
     * submission itself, on the one surface that exists to accept reports.
     *
     * Asserted as a STATE (`isWellFormed`, plus a real UTF-8 encode round-trip)
     * rather than by looking for an escape sequence in the output: a well-formed
     * string is the property the downstream write actually needs, and a lone
     * surrogate is the only way to lose it.
     */
    const EMOJI = '\u{1F600}'; // U+1F600, two UTF-16 units: \uD83D \uDE00

    /** Encoding to UTF-8 and back is lossless iff the string has no lone surrogate. */
    const survivesUtf8 = (value: string) =>
      new TextDecoder().decode(new TextEncoder().encode(value)) === value;

    it('does not leave a lone surrogate when the bound falls inside an emoji', () => {
      // 199 ASCII + one emoji = 201 units, so unit 200 is the emoji's HIGH surrogate.
      const query = 'q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH - 1) + EMOJI;
      expect(query).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH + 1);

      const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters({ query }) });
      const clipped = context?.filters?.query as string;

      expect(clipped.isWellFormed()).toBe(true);
      expect(survivesUtf8(clipped)).toBe(true);
      // Exactly the orphaned unit is dropped — the whole pair, and nothing more.
      expect(clipped).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH - 1);
      expect(clipped).toBe('q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH - 1));
      expect(throughSchema(context)?.filters?.query).toBe(clipped);
    });

    it('does not leave a lone surrogate for a term that is mostly emoji', () => {
      // One ASCII char shifts every pair onto an odd offset, so the clip at 200 lands
      // mid-pair. (A term of ONLY emoji does not break at this bound: 200 is even, so
      // the cut falls exactly on a pair boundary — which is why the fixture is mixed.)
      const query = 'q' + EMOJI.repeat(150);
      const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters({ query }) });
      const clipped = context?.filters?.query as string;

      expect(clipped.isWellFormed()).toBe(true);
      expect(survivesUtf8(clipped)).toBe(true);
      expect(clipped).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH - 1);
      expect(clipped.endsWith(EMOJI)).toBe(true);
      expect(throughSchema(context)?.filters?.query).toBe(clipped);
    });

    /**
     * The control for the two above: when the clip point does NOT fall inside a pair,
     * nothing extra may be trimmed. Without it, a guard that simply dropped the last
     * unit of every clipped term would pass both cases above.
     */
    it('trims nothing extra when the bound falls on a character boundary', () => {
      const query = 'q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH) + EMOJI;
      const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters({ query }) });

      expect(context?.filters?.query).toBe('q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH));
      expect(context?.filters?.query).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH);
    });

    /** And an emoji comfortably inside the bound is not touched at all. */
    it('leaves an emoji inside the bound intact', () => {
      const query = `upscale ${EMOJI}`;
      const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters({ query }) });

      expect(context?.filters?.query).toBe(query);
      expect(throughSchema(context)?.filters?.query).toBe(query);
    });

    /**
     * The control for the two cases above: an UNCLIPPED value of the same shape is
     * genuinely rejected. Without this, "does not throw" would be indistinguishable
     * from a schema that has no bound at all.
     */
    it('and the unclipped value really is rejected (negative control)', () => {
      expect(() =>
        createFeedbackSchema.parse({
          area: 'apps-marketplace',
          message: 'the store looked wrong',
          context: { filters: { query: 'q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH + 1) } },
        })
      ).toThrow();
    });
  });
});
