import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  readListingIconBySlugForRender,
  type ListingIconReadClient,
} from '~/server/services/blocks/app-listing-icon.service';

/**
 * The render-safe listing-icon reader used by `/apps/run/<slug>`.
 *
 * 🔴 THE BEHAVIOUR UNDER TEST IS "THIS CAN NEVER TAKE THE PAGE DOWN". The run page is
 * the APP LAUNCH path and `createServerSideProps` has no try/catch above it, so a
 * rejection out of this function is an SSR 500 on the page that runs the app. Every
 * failure case below therefore asserts a RESOLVED `null`, not a thrown error — and the
 * throwing fake is the only way to exercise that branch without a database that is
 * actually unwell.
 */

/**
 * The CANONICAL logging mock, rather than a direct per-file mock of the logging client.
 * `no-direct-shared-module-mock.test.ts` fails a new direct one, and the reason is real:
 * under `isolate: false` a per-file factory runs once per WORKER, so its spy accumulates
 * calls across every file sharing that worker — the `expected "X" to be called 2 times`
 * class. `loggingMock` gives a stable identity plus reset. See
 * docs/testing/shared-module-mocks.md.
 *
 * ⚠️ AND DO NOT SPELL THE FORBIDDEN CALL IN PROSE HERE. That guard is a REGEX over the
 * raw file, with no comment stripping, so a comment quoting the exact
 * `vi.mock('<the logging specifier>', …)` form it forbids trips it just as a real call
 * would — and the failure names this file for a mock it does not contain, which is a
 * confusing five minutes. Describe the shape; do not write it out.
 */
const logToAxiom = loggingMock.logToAxiom;

/** A client whose single read returns `row`. */
function clientReturning(
  row: { icon: { url: string | null } | null } | null
): ListingIconReadClient {
  return { appListing: { findUnique: vi.fn(async () => row) } };
}

/** A client whose single read rejects — the outage / missing-table / timeout shape. */
function clientThrowing(err: unknown): ListingIconReadClient {
  return {
    appListing: {
      findUnique: vi.fn(async () => {
        throw err;
      }),
    },
  };
}

beforeEach(() => {
  logToAxiom.mockClear();
});

describe('readListingIconBySlugForRender', () => {
  it('projects the icon through the SHARED store projection, so the chrome and the store agree', async () => {
    const url = await readListingIconBySlugForRender(
      'my-app',
      clientReturning({ icon: { url: 'abc-123' } })
    );

    // 🔴 ASSERTED AS A CDN URL DERIVED FROM THE ROW, NOT AS A LITERAL. Pinning the exact
    // string would pin `getEdgeUrl`'s output format — a different module's contract — and
    // would go red on an unrelated CDN change. What this function owes its caller is that
    // it returns the row's image transformed by the shared `listingIconUrl` projection
    // (the SAME one the store card uses, which is what stops the chrome and the store
    // showing different pictures for one app), not that the projection has a given shape.
    expect(url, 'a listing WITH an icon must resolve to a URL').not.toBeNull();
    expect(url).toContain('abc-123');
  });

  // The three "nothing to show" shapes. They are deliberately indistinguishable to the
  // caller: no consumer can act on the difference, and every one renders the same
  // generic-icon fallback.
  it.each([
    ['no such listing', null],
    ['a listing with no icon assigned', { icon: null }],
    ['an icon row whose url is null', { icon: { url: null } }],
  ])('returns null for %s', async (_label, row) => {
    expect(await readListingIconBySlugForRender('my-app', clientReturning(row))).toBeNull();
  });

  it('returns null for an empty slug WITHOUT issuing a query', async () => {
    const db = clientReturning({ icon: { url: 'abc-123' } });
    expect(await readListingIconBySlugForRender('', db)).toBeNull();
    // The early return is the point: `slug` is `@unique`, and a lookup on '' is a
    // guaranteed-empty round trip on the launch path.
    expect(db.appListing.findUnique).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE LOAD-BEARING CASE. `42P01` (undefined table) and `P2022` (missing column) are
   * the codes an `app_listings` schema problem actually raises, and a statement timeout
   * or connection reset arrives the same way. All must degrade, none may propagate.
   */
  it.each([
    ['a missing table', Object.assign(new Error('relation does not exist'), { code: '42P01' })],
    ['a missing column', Object.assign(new Error('column does not exist'), { code: 'P2022' })],
    ['a statement timeout', Object.assign(new Error('canceling statement'), { code: '57014' })],
    ['a non-Error rejection', 'connection reset'],
  ])('degrades to null on %s rather than propagating', async (_label, err) => {
    await expect(readListingIconBySlugForRender('my-app', clientThrowing(err))).resolves.toBeNull();
  });

  it('LOGS the degraded read, so an app_listings outage is findable rather than silent', async () => {
    await readListingIconBySlugForRender(
      'my-app',
      clientThrowing(Object.assign(new Error('boom'), { code: '42P01' }))
    );

    expect(
      logToAxiom,
      'a failed icon read was swallowed with no log. Without one, an app_listings outage ' +
        'presents ONLY as icons that quietly stopped appearing in the chrome, with nothing ' +
        'anywhere to attribute it.'
    ).toHaveBeenCalledTimes(1);
    const [event] = logToAxiom.mock.calls[0] as unknown as [Record<string, unknown>];
    // Its OWN event name, not the beta reader's: a shared name would make a media
    // problem indistinguishable from a beta-column problem in the one place someone
    // looks.
    expect(event.name).toBe('app-listing-icon-read-degraded');
    expect(event.code).toBe('42P01');
    expect(event.message).toBe('boom');
  });

  /**
   * `logToAxiom` returns a promise that can REJECT. An unhandled rejection out of a
   * fail-open path would defeat the entire point of failing open, so the `.catch()` on
   * the log call is functional rather than decorative — this is the test that proves it.
   */
  it('survives the LOGGER itself rejecting — the fail-open path stays fail-open', async () => {
    logToAxiom.mockImplementationOnce(() => Promise.reject(new Error('axiom down')));
    await expect(
      readListingIconBySlugForRender('my-app', clientThrowing(new Error('boom')))
    ).resolves.toBeNull();
  });

  it('reads by slug — the key the run page already holds, so no extra identifier is needed', async () => {
    const db = clientReturning({ icon: { url: 'abc-123' } });
    await readListingIconBySlugForRender('my-app', db);
    expect(db.appListing.findUnique).toHaveBeenCalledWith({
      where: { slug: 'my-app' },
      select: { icon: { select: { url: true } } },
    });
  });
});
