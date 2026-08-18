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
