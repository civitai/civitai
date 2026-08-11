import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 REVISION NON-CLOBBER — why `displayed` lives on the collaborator row and not on
 * `AppListing`.
 *
 * `applyApprovedRevision` (offsite-listing.service.ts) copies a shadow's contents onto
 * its live parent when a moderator approves a revision. It is KIND-AWARE:
 *   - ONSITE  branch: copies ONLY `iconId` / `coverId`.
 *   - OFFSITE branch: ALSO copies name / tagline / description / category /
 *     contentRating / externalUrl / connect* .
 *
 * The product decision is that the display-author flag applies IMMEDIATELY, with no mod
 * review. Had it been stored as an `AppListing` column, the offsite branch would
 * overwrite it from the shadow on the next approved revision — an immediate-apply
 * setting that silently reverts. Storing it on `AppCollaborator` puts it outside BOTH
 * branches' copy sets, which makes immediate-apply correct BY CONSTRUCTION.
 *
 * This suite pins that structurally, against the real source, so the guarantee survives
 * someone widening a copy set later. It is a RELATIONSHIP guard: the behavioural half
 * (that a toggle actually persists) lives in `app-collaborator.service.test.ts`.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src/server/services/blocks/offsite-listing.service.ts');
const SOURCE = readFileSync(SRC, 'utf8');

/** Slice out `applyApprovedRevision`'s body: from its declaration to the next top-level fn. */
function applyApprovedRevisionBody(): string {
  const start = SOURCE.indexOf('async function applyApprovedRevision(');
  expect(start, 'applyApprovedRevision must exist — has it been renamed?').toBeGreaterThan(-1);
  const after = SOURCE.indexOf('\nexport async function rejectExternalRequest', start);
  expect(after, 'the slice end marker must exist').toBeGreaterThan(start);
  return SOURCE.slice(start, after);
}

const BODY = applyApprovedRevisionBody();

describe('applyApprovedRevision — the copy sets', () => {
  it('POSITIVE CONTROL: the slice really contains both branches', () => {
    // A slice that silently matched nothing would make every "does not contain"
    // assertion below vacuously true — the classic reassuring zero.
    expect(BODY.length).toBeGreaterThan(500);
    expect(BODY).toContain("parent.kind === 'onsite'");
    // The offsite branch's marker scalars.
    expect(BODY).toContain('name: shadow.name');
    expect(BODY).toContain('tagline: shadow.tagline');
    expect(BODY).toContain('iconId: shadow.iconId');
  });

  it('🔴 NEITHER branch copies `userId` — a revision cannot change ownership', () => {
    expect(BODY).not.toContain('userId: shadow.userId');
    expect(BODY).not.toMatch(/data:\s*\{[^}]*\buserId\b/s);
  });

  it('🔴 NEITHER branch touches `AppCollaborator` — seats survive an approve', () => {
    expect(BODY).not.toContain('appCollaborator');
  });

  it('🔴 NEITHER branch touches `displayed` — the byline opt-in survives an approve', () => {
    // THE assertion this file exists for. If `displayed` ever appears in this function,
    // the flag has been moved onto the listing and immediate-apply is no longer safe.
    expect(BODY).not.toContain('displayed');
  });

  it('the ONSITE branch copies ASSETS ONLY (the scalars stay manifest-governed)', () => {
    const onsiteStart = BODY.indexOf("parent.kind === 'onsite'");
    const elseAt = BODY.indexOf('} else {', onsiteStart);
    const onsite = BODY.slice(onsiteStart, elseAt);
    expect(onsite).toContain('iconId: shadow.iconId');
    expect(onsite).toContain('coverId: shadow.coverId');
    expect(onsite).not.toContain('name: shadow.name');
    expect(onsite).not.toContain('displayed');
    expect(onsite).not.toContain('appCollaborator');
  });

  it('the OFFSITE branch copies the full scalar set — but still nothing collaborator-shaped', () => {
    const elseAt = BODY.indexOf('} else {');
    const offsite = BODY.slice(elseAt);
    // Prove the branch is the wide one (so "not displayed" below is meaningful).
    expect(offsite).toContain('name: shadow.name');
    expect(offsite).toContain('description: shadow.description');
    expect(offsite).toContain('category: shadow.category');
    // 🔴 …and yet still carries neither.
    expect(offsite).not.toContain('displayed');
    expect(offsite).not.toContain('appCollaborator');
    expect(offsite).not.toContain('userId: shadow.userId');
  });

  it('NEGATIVE CONTROL: the scan CAN find a token in this body', () => {
    // Proves the "not.toContain" assertions above are answering about real content
    // rather than about an empty string.
    expect(BODY).toContain('appListingScreenshot');
    expect(BODY).not.toContain('aTokenThatIsDefinitelyNotInThisFunction');
  });
});

describe('beginListingRevision — the shadow clone set', () => {
  it('🔴 clones with the PARENT OWNER’s userId, not the editing user’s', () => {
    // Load-bearing for collaborators: the shadow is owner-owned, which is why
    // `submitListingRevision`'s bare `shadow.userId !== userId` refused an editor and
    // had to be widened with the seat check.
    const start = SOURCE.indexOf('export async function beginListingRevision(');
    const end = SOURCE.indexOf('export type SubmitListingRevisionResult', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = SOURCE.slice(start, end);
    expect(body).toContain('userId: parent.userId');
  });

  it('a shadow carries NO appBlockId — which is why listing access must walk to the parent', () => {
    const start = SOURCE.indexOf('export async function beginListingRevision(');
    const end = SOURCE.indexOf('export type SubmitListingRevisionResult', start);
    const body = SOURCE.slice(start, end);
    expect(body).toContain('appBlockId: null');
  });
});
