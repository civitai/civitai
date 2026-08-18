import { describe, expect, it } from 'vitest';
import { createFeedbackSchema, getFeedbackAreaSchema } from '~/server/schema/feedback.schema';
import {
  FEEDBACK_AREAS,
  FEEDBACK_FILTER_VALUE_MAX_LENGTH,
  FEEDBACK_IMAGE_ID_MAX_LENGTH,
  FEEDBACK_IMAGE_MAX_COUNT,
  FEEDBACK_SESSION_ID_MAX_LENGTH,
  feedbackAreaFlagKey,
} from '~/shared/constants/feedback.constants';

/**
 * Boundary contract for `createFeedbackSchema.context` — the three fields added for
 * image attachments, the Faro session id, and the opt-in DOM capture.
 *
 * WHY THIS FILE IS THE LOAD-BEARING ONE. `feedbackContextSchema` is a `z.object`,
 * and a `z.object` STRIPS keys it does not declare. So a client that sends
 * `context.images` against a schema that never declared it does not get an error —
 * it gets a successful submission with the images silently gone. The round-trip
 * assertions below are what distinguish "declared and carried" from "declared in a
 * TypeScript type and dropped at the wire".
 *
 * Every expectation here is a LITERAL, not a value read back out of the schema. The
 * constants are asserted against literals too (first block), so widening a bound
 * shows up as a failing test rather than as a test that quietly follows the change.
 */
describe('feedback schema — context bounds', () => {
  const base = { area: 'bitdex-image-feed' as const, message: 'something looked wrong' };
  const parse = (context: Record<string, unknown>) =>
    createFeedbackSchema.parse({ ...base, context });
  const id = (length: number) => 'a'.repeat(length);

  describe('the bounds themselves', () => {
    // Pins the numbers this whole file is written against. If one of these moves,
    // the intent below has to be re-read rather than silently re-derived.
    it('is 3 images, 100-char ids, 64-char session ids', () => {
      expect(FEEDBACK_IMAGE_MAX_COUNT).toBe(3);
      expect(FEEDBACK_IMAGE_ID_MAX_LENGTH).toBe(100);
      expect(FEEDBACK_SESSION_ID_MAX_LENGTH).toBe(64);
    });
  });

  describe('images', () => {
    it('carries the ids through instead of stripping them', () => {
      const parsed = parse({ images: ['cf-image-1', 'cf-image-2'] });
      expect(parsed.context?.images).toEqual(['cf-image-1', 'cf-image-2']);
    });

    it('accepts exactly 3', () => {
      const parsed = parse({ images: ['a', 'b', 'c'] });
      expect(parsed.context?.images).toHaveLength(3);
    });

    it('rejects 4', () => {
      expect(() => parse({ images: ['a', 'b', 'c', 'd'] })).toThrow();
    });

    it('accepts an id of exactly 100 characters', () => {
      const parsed = parse({ images: [id(100)] });
      expect(parsed.context?.images?.[0]).toHaveLength(100);
    });

    it('rejects an id of 101 characters', () => {
      expect(() => parse({ images: [id(101)] })).toThrow();
    });

    it('rejects an empty id', () => {
      expect(() => parse({ images: [''] })).toThrow();
    });

    it('rejects a whitespace-only id (it trims to empty)', () => {
      expect(() => parse({ images: ['   '] })).toThrow();
    });

    it('rejects a non-string id', () => {
      expect(() => parse({ images: [42] })).toThrow();
    });

    it('accepts an omitted images field', () => {
      const parsed = parse({ path: '/images' });
      expect(parsed.context?.images).toBeUndefined();
    });
  });

  describe('screenshotId', () => {
    it('carries the id through instead of stripping it', () => {
      const parsed = parse({ screenshotId: 'cf-screenshot-1' });
      expect(parsed.context?.screenshotId).toBe('cf-screenshot-1');
    });

    it('accepts exactly 100 characters', () => {
      const parsed = parse({ screenshotId: id(100) });
      expect(parsed.context?.screenshotId).toHaveLength(100);
    });

    it('rejects 101 characters', () => {
      expect(() => parse({ screenshotId: id(101) })).toThrow();
    });

    it('rejects an empty id', () => {
      expect(() => parse({ screenshotId: '' })).toThrow();
    });

    // Distinct fields, not one array: triage must be able to tell a rendered capture
    // of the reporter's own screen from a file they picked.
    it('is separate from images — both can travel on one submission', () => {
      const parsed = parse({ images: ['attached-1'], screenshotId: 'captured-1' });
      expect(parsed.context?.images).toEqual(['attached-1']);
      expect(parsed.context?.screenshotId).toBe('captured-1');
    });
  });

  describe('sessionId', () => {
    it('carries the id through instead of stripping it', () => {
      const parsed = parse({ sessionId: 'faro-session-abc' });
      expect(parsed.context?.sessionId).toBe('faro-session-abc');
    });

    it('accepts exactly 64 characters', () => {
      const parsed = parse({ sessionId: id(64) });
      expect(parsed.context?.sessionId).toHaveLength(64);
    });

    it('rejects 65 characters', () => {
      expect(() => parse({ sessionId: id(65) })).toThrow();
    });

    // The dev/test/preview case, and every production session where Faro did not
    // start. It must parse — a missing session id can never block a submission.
    it('accepts an omitted sessionId', () => {
      const parsed = createFeedbackSchema.parse({ ...base, context: { path: '/images' } });
      expect(parsed.context?.sessionId).toBeUndefined();
      expect(parsed.message).toBe('something looked wrong');
    });

    it('accepts a submission with no context at all', () => {
      const parsed = createFeedbackSchema.parse(base);
      expect(parsed.context).toBeUndefined();
    });
  });

  describe('unknown keys', () => {
    // This is the behaviour that makes every round-trip assertion above meaningful:
    // an undeclared key is DROPPED, not rejected, so "the field arrived" is only
    // ever provable by reading it back.
    it('are stripped silently rather than rejected', () => {
      const parsed = parse({ images: ['a'], notAField: 'x' } as Record<string, unknown>);
      expect(parsed.context).not.toHaveProperty('notAField');
      expect(parsed.context?.images).toEqual(['a']);
    });
  });

  describe('pre-existing context fields (invariant guard — not regression coverage)', () => {
    // These already passed before this change. They are here so a future edit to the
    // context schema cannot drop them while the new fields keep the file green.
    it('still carries path, reportedSource, pagesLoaded and filters', () => {
      const parsed = parse({
        path: '/images',
        reportedSource: 'bitdex',
        reportedPageSources: ['bitdex', 'meili'],
        pagesLoaded: 3,
        filters: { sort: 'Newest', period: 'Day' },
      });
      expect(parsed.context?.path).toBe('/images');
      expect(parsed.context?.reportedSource).toBe('bitdex');
      expect(parsed.context?.pagesLoaded).toBe(3);
      expect(parsed.context?.filters).toEqual({ sort: 'Newest', period: 'Day' });
    });

    it('still rejects a message past 2000 characters', () => {
      expect(() => createFeedbackSchema.parse({ ...base, message: 'x'.repeat(2001) })).toThrow();
    });
  });
});

/**
 * The AREA enum is the boundary that decides whether a new feedback surface exists at
 * all. `feedbackAreaSchema` is `z.enum(FEEDBACK_AREAS)`, so an area missing from that
 * constant is not a stripped field — it is a REJECTED submission on both procedures,
 * and the surface is dead in a way no amount of Flipt configuration can revive.
 *
 * Areas are plain strings (no Prisma enum, no migration), which is exactly why this
 * needs a test: nothing else in the stack would notice the omission until a user's
 * report bounced.
 */
describe('feedback areas', () => {
  const areas = ['bitdex-image-feed', 'apps-marketplace'];

  // Both halves hand-typed. Reading the expectation out of FEEDBACK_AREAS would make
  // this test follow any future edit instead of pinning the set.
  it('are exactly the two declared surfaces', () => {
    expect([...FEEDBACK_AREAS]).toEqual(areas);
  });

  it.each(areas)('accepts %s on the submit schema', (area) => {
    const parsed = createFeedbackSchema.parse({ area, message: 'something looked wrong' });
    expect(parsed.area).toBe(area);
  });

  it.each(areas)('accepts %s on the getArea schema', (area) => {
    expect(getFeedbackAreaSchema.parse({ area }).area).toBe(area);
  });

  it('rejects an area that is not declared', () => {
    expect(() =>
      createFeedbackSchema.parse({ area: 'apps-markteplace', message: 'typo in the slug' })
    ).toThrow();
    expect(() => getFeedbackAreaSchema.parse({ area: 'models-feed' })).toThrow();
  });

  /**
   * The flag key is DERIVED from the slug, so it is never written down anywhere in the
   * app — but it IS written down by hand in flipt-state's `features.yaml`. These two
   * literals are that contract. A mismatch fails as "the area is off for everybody",
   * silently, because an unknown flag resolves false.
   */
  it('derive their Flipt flag keys from the slug', () => {
    expect(feedbackAreaFlagKey('bitdex-image-feed')).toBe('feedback-area-bitdex-image-feed');
    expect(feedbackAreaFlagKey('apps-marketplace')).toBe('feedback-area-apps-marketplace');
  });
});

/**
 * `context.filters` — the generic per-view bag, and the one place `/apps` reports
 * user-typed text (its search box). The bound is exported so a caller can clip to it;
 * these pin that the exported number IS the enforced one.
 */
describe('feedback schema — filter value bounds', () => {
  const parseFilters = (filters: Record<string, unknown>) =>
    createFeedbackSchema.parse({
      area: 'apps-marketplace' as const,
      message: 'the store looked wrong',
      context: { filters },
    });

  it('is a 200-character ceiling per value', () => {
    expect(FEEDBACK_FILTER_VALUE_MAX_LENGTH).toBe(200);
  });

  it('carries the marketplace view through instead of stripping it', () => {
    const parsed = parseFilters({ kind: 'offsite', category: 'generation', sort: 'newest' });
    expect(parsed.context?.filters).toEqual({
      kind: 'offsite',
      category: 'generation',
      sort: 'newest',
    });
  });

  it('accepts a value of exactly 200 characters', () => {
    const parsed = parseFilters({ query: 'q'.repeat(200) });
    expect(parsed.context?.filters?.query).toHaveLength(200);
  });

  // REJECTS, does not truncate — the reason the caller has to clip.
  it('rejects a value of 201 characters rather than clipping it', () => {
    expect(() => parseFilters({ query: 'q'.repeat(201) })).toThrow();
  });
});
