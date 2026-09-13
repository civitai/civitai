import { describe, expect, it } from 'vitest';
import { createFeedbackSchema, getFeedbackAreaSchema } from '~/server/schema/feedback.schema';
import {
  FEEDBACK_AREAS,
  FEEDBACK_FILTER_VALUE_MAX_LENGTH,
  FEEDBACK_IMAGE_MAX_COUNT,
  FEEDBACK_PATH_MAX_LENGTH,
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
  /** Length-bounded fields only — image ids are bounded by SHAPE, not length. */
  const id = (length: number) => 'a'.repeat(length);

  /**
   * Synthetic v4 uuids, NOT keys copied out of the production `Feedback` table.
   * `civitai/civitai` is public and a real id is a live object key in our store.
   * Shape is what is under test, and these carry the same shape: version nibble 4,
   * variant nibble 8/9/a/b, as `crypto.randomUUID()` emits.
   */
  const UUID_A = '11111111-2222-4333-8444-555555555555';
  const UUID_B = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
  const UUID_C = '00000000-0000-4000-a000-000000000000';

  describe('the bounds themselves', () => {
    // Pins the numbers this whole file is written against. If one of these moves,
    // the intent below has to be re-read rather than silently re-derived.
    it('is 3 images and 64-char session ids', () => {
      expect(FEEDBACK_IMAGE_MAX_COUNT).toBe(3);
      expect(FEEDBACK_SESSION_ID_MAX_LENGTH).toBe(64);
    });
  });

  describe('images', () => {
    it('carries the ids through instead of stripping them', () => {
      const parsed = parse({ images: [UUID_A, UUID_B] });
      expect(parsed.context?.images).toEqual([UUID_A, UUID_B]);
    });

    it('accepts exactly 3', () => {
      const parsed = parse({ images: [UUID_A, UUID_B, UUID_C] });
      expect(parsed.context?.images).toHaveLength(3);
    });

    it('rejects 4', () => {
      expect(() => parse({ images: [UUID_A, UUID_B, UUID_C, UUID_A] })).toThrow();
    });

    it('rejects an empty id', () => {
      expect(() => parse({ images: [''] })).toThrow();
    });

    it('rejects a non-string id', () => {
      expect(() => parse({ images: [42] })).toThrow();
    });

    it('accepts an omitted images field', () => {
      const parsed = parse({ path: '/images' });
      expect(parsed.context?.images).toBeUndefined();
    });
  });

  /**
   * 🔴 THE SHAPE IS A SECURITY GUARD, NOT TIDINESS, AND THIS IS THE REGRESSION BLOCK.
   *
   * Both mint paths produce `randomUUID()` — the presigned one
   * (`src/pages/api/v1/image-upload/index.ts`) and the relay's own server-side mint
   * (`uploadImageBufferToStore` in `src/utils/s3-utils.ts`) — so a legitimate id is
   * ALWAYS a uuid. The field used to be bounded by LENGTH ALONE
   * (`z.string().trim().min(1).max(100)`), which accepted any string a client cared to
   * send and wrote it verbatim into a JSONB column.
   *
   * The consumer is what makes that matter: the moderator queue renders these as
   * inline thumbnails, and its `getEdgeUrl` returns any `http`-prefixed argument
   * VERBATIM. An id spelled as an absolute URL therefore becomes
   * `<img src="https://attacker.example/x.png">` in a moderator's browser — an
   * outbound request giving the reporter a read receipt naming which moderator opened
   * their report and when.
   *
   * `apps/moderator/src/lib/feedback.ts`'s `IMAGE_KEY` regex already closes this on
   * the READ side. These cases close it at the source, so the guarantee does not
   * depend on one consumer remembering to filter. Every case below PARSED before this
   * change — they are red at `origin/main`, not invariant guards.
   */
  describe('images — ids that are not uuids (regression)', () => {
    const notUuids: Array<[string, string]> = [
      ['an absolute https URL', 'https://attacker.example/x.png'],
      ['an absolute http URL', 'http://attacker.example/x.png'],
      ['a protocol-relative URL', '//attacker.example/x.png'],
      ['a blob URL', 'blob:https://civitai.com/abcd'],
      // No colon, so it takes `getEdgeUrl`'s verbatim branch as a SAME-ORIGIN
      // relative src — a different, smaller hole than the ones above.
      ['a bare string starting with http', 'httpsomething'],
      ['a data URL', 'data:image/png;base64,AAAA'],
      ['a traversal', '../../etc/passwd'],
      ['a plausible-looking opaque key', 'cf-image-1'],
      ['a uuid with its hyphens stripped', '11111111222243338444555555555555'],
      ['a whitespace-padded uuid', ` ${UUID_A} `],
      ['a uuid with trailing path', `${UUID_A}/../other`],
    ];

    it.each(notUuids)('rejects %s', (_label, value) => {
      expect(() => parse({ images: [value] })).toThrow();
      expect(() => parse({ screenshotId: value })).toThrow();
    });

    // The positive control for the block above: the guard rejects those BECAUSE they
    // are not uuids, not because the field rejects everything.
    it('still accepts the shape both mint paths actually emit', () => {
      expect(parse({ images: [UUID_A], screenshotId: UUID_B }).context?.images).toEqual([UUID_A]);
    });
  });

  describe('screenshotId', () => {
    it('carries the id through instead of stripping it', () => {
      const parsed = parse({ screenshotId: UUID_A });
      expect(parsed.context?.screenshotId).toBe(UUID_A);
    });

    it('rejects an empty id', () => {
      expect(() => parse({ screenshotId: '' })).toThrow();
    });

    // Distinct fields, not one array: triage must be able to tell a rendered capture
    // of the reporter's own screen from a file they picked.
    it('is separate from images — both can travel on one submission', () => {
      const parsed = parse({ images: [UUID_A], screenshotId: UUID_B });
      expect(parsed.context?.images).toEqual([UUID_A]);
      expect(parsed.context?.screenshotId).toBe(UUID_B);
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
      const parsed = parse({ images: [UUID_A], notAField: 'x' } as Record<string, unknown>);
      expect(parsed.context).not.toHaveProperty('notAField');
      expect(parsed.context?.images).toEqual([UUID_A]);
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
  const areas = ['bitdex-image-feed', 'apps-marketplace', 'site-bug-report'];

  // Both halves hand-typed. Reading the expectation out of FEEDBACK_AREAS would make
  // this test follow any future edit instead of pinning the set.
  it('are exactly the three declared surfaces', () => {
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
    expect(feedbackAreaFlagKey('site-bug-report')).toBe('feedback-area-site-bug-report');
  });
});

/**
 * `context.path` — the route a report came from, and the one context field a caller
 * has to clip to by hand (`FeedbackDrawer`). The bound is exported for that reason:
 * a `max()` REJECTS rather than truncating, so a drifted copy does not produce a
 * shortened path, it 400s the whole submission on the surface that exists to collect
 * reports. These two assertions are the contract between the clip and the schema.
 */
describe('context.path', () => {
  const parsePath = (path: string) =>
    createFeedbackSchema.parse({
      area: 'site-bug-report' as const,
      message: 'something broke',
      context: { path },
    });

  it('is a 300-character ceiling', () => {
    expect(FEEDBACK_PATH_MAX_LENGTH).toBe(300);
  });

  it('accepts a path of exactly the bound, and rejects one character more', () => {
    expect(parsePath('/'.padEnd(FEEDBACK_PATH_MAX_LENGTH, 'a')).context?.path).toHaveLength(
      FEEDBACK_PATH_MAX_LENGTH
    );
    expect(() => parsePath('/'.padEnd(FEEDBACK_PATH_MAX_LENGTH + 1, 'a'))).toThrow();
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
