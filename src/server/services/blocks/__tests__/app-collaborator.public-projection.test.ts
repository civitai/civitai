import { describe, expect, it } from 'vitest';

import { projectListingDetail } from '~/server/services/blocks/app-listing.service';
import type { HydratedListing } from '~/server/services/blocks/app-listing.service';

/**
 * App Listing COLLABORATORS — the PUBLIC BYLINE projection.
 *
 * Two independent things are pinned here:
 *   1. CONSENT — only accepted+displayed collaborators reach the DTO. (The
 *      accepted/displayed filtering itself lives in `listDisplayedCollaboratorUserIds`
 *      and is pinned in `app-access.service.test.ts`; this file pins that the DTO
 *      carries exactly what it is handed and adds nothing.)
 *   2. 🔴 THE ALLOWLIST — the chip is exactly `{id, username, image}` and NO EXTRA KEY
 *      CAN APPEAR, even when the input row carries more. That is the property that
 *      keeps an accidental widening of an upstream `select` from leaking PII through
 *      an anon-capable read.
 */

/** A minimal hydrated row — only what `projectListingDetail` reads. */
function row(over: Partial<HydratedListing> = {}): HydratedListing {
  return {
    id: 'apl_1',
    serialId: 1,
    kind: 'onsite',
    slug: 'my-app',
    name: 'My App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'g',
    externalUrl: null,
    connectClientId: null,
    appBlockId: 'ab_1',
    icon: null,
    cover: null,
    user: { id: 7, username: 'owner', image: null },
    metric: null,
    // `updatedAt` is a NOT-NULL Prisma column on every real row; the detail
    // projection reads it for the header's "Updated:" meta line. Fixed value so
    // the projection's ISO output is deterministic.
    updatedAt: new Date('2026-03-04T05:06:07.000Z'),
    appBlock: { manifest: {}, currentVersionDeployedAt: new Date() },
    screenshots: [],
    ...over,
  } as unknown as HydratedListing;
}

describe('projectListingDetail — the collaborator byline', () => {
  it('with NO collaborators the field is an empty array (never undefined)', () => {
    // A `undefined` here would make every consumer write `?? []` and one of them
    // eventually would not.
    expect(projectListingDetail(row()).collaborators).toEqual([]);
  });

  it('projects the supplied collaborators in order', () => {
    const detail = projectListingDetail(row(), [
      { id: 20, username: 'editor-a', image: 'a.png' },
      { id: 21, username: 'editor-b', image: null },
    ]);
    expect(detail.collaborators).toEqual([
      { id: 20, username: 'editor-a', image: 'a.png' },
      { id: 21, username: 'editor-b', image: null },
    ]);
  });

  it('🔴 THE ALLOWLIST: exactly {id, username, image} — no extra key can appear', () => {
    // Feed a REALISTIC over-wide user row (the shape a careless `select: true` upstream
    // would produce), not a textbook fixture. A projection that spread its input would
    // pass this key set straight through.
    const overWide = {
      id: 20,
      username: 'editor',
      image: null,
      email: 'secret@example.com',
      bannedAt: new Date(),
      isModerator: true,
      settings: { anything: 1 },
      muted: true,
    } as unknown as { id: number; username: string | null; image: string | null };

    const detail = projectListingDetail(row(), [overWide]);
    expect(detail.collaborators).toHaveLength(1);
    expect(Object.keys(detail.collaborators[0]).sort()).toEqual(['id', 'image', 'username']);
    // Named explicitly so the failure message says WHICH field leaked.
    expect(detail.collaborators[0]).not.toHaveProperty('email');
    expect(detail.collaborators[0]).not.toHaveProperty('bannedAt');
    expect(detail.collaborators[0]).not.toHaveProperty('isModerator');
  });

  it('POSITIVE CONTROL: the over-wide fixture really does carry the extra keys', () => {
    // Otherwise the assertion above is a fact about the fixture, not about the code.
    const overWide = { id: 20, username: 'e', image: null, email: 'x@y.z' };
    expect(Object.keys(overWide)).toContain('email');
  });

  it('the `creator` chip uses the SAME allowlist (the two must not diverge)', () => {
    const detail = projectListingDetail(
      row({
        user: {
          id: 7,
          username: 'owner',
          image: null,
          email: 'owner@example.com',
        } as unknown as HydratedListing['user'],
      })
    );
    expect(Object.keys(detail.creator!).sort()).toEqual(['id', 'image', 'username']);
  });

  it('a null username survives as null rather than being invented', () => {
    const detail = projectListingDetail(row(), [{ id: 20, username: null, image: null }]);
    expect(detail.collaborators[0].username).toBeNull();
  });
});
