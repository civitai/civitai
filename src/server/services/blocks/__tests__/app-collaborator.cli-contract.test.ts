import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  addListingScreenshotSchema,
  removeListingScreenshotSchema,
  reorderListingScreenshotsSchema,
  setListingCoverSchema,
  setListingIconSchema,
  updateListingScreenshotCaptionSchema,
} from '~/server/schema/blocks/app-listing.schema';
import {
  beginListingRevisionSchema,
  getMyListingForAppSchema,
  submitListingRevisionSchema,
} from '~/server/schema/blocks/offsite-listing.schema';

/**
 * 🔴 THE CLI WIRE CONTRACT.
 *
 * The listing-media procs are CLI-reachable: `civitai login` mints a SCOPED OAuth token
 * (`UserRead | AppBlocksSubmit | AppBlocksDevTunnel`) and released CLI versions drive
 * `civitai app listing set-icon / set-cover / add-screenshot / rm-screenshot / reorder /
 * status` through the `listingMediaCliScope`-annotated procs.
 *
 * Widening a GATE is invisible to those clients — the request bytes are identical and
 * only the server's answer changes. Changing an INPUT SCHEMA is not: an added required
 * field, a tightened type or a renamed key breaks every already-released binary in the
 * field, and there is no way to make an old binary send the new shape.
 *
 * This suite pins the two halves of that contract:
 *   1. every media proc's input schema still ACCEPTS the exact payload a released CLI
 *      sends (a behavioural parse, not a shape description); and
 *   2. the set of `listingMediaCliScope`-annotated procs has not shrunk, so a proc
 *      cannot quietly lose its CLI reachability.
 */

const ROOT = process.cwd();
const ROUTER = readFileSync(join(ROOT, 'src/server/routers/app-listings.router.ts'), 'utf8');

describe('listing-media input schemas — unchanged for released CLI clients', () => {
  it('setIcon accepts { listingId, imageId }', () => {
    const parsed = setListingIconSchema.parse({ listingId: 'apl_1', imageId: 5 });
    expect(parsed).toMatchObject({ listingId: 'apl_1', imageId: 5 });
  });

  it('setCover accepts { listingId, imageId }', () => {
    expect(setListingCoverSchema.parse({ listingId: 'apl_1', imageId: 5 })).toMatchObject({
      listingId: 'apl_1',
      imageId: 5,
    });
  });

  it('addScreenshot accepts { listingId, imageId }', () => {
    expect(addListingScreenshotSchema.parse({ listingId: 'apl_1', imageId: 5 })).toMatchObject({
      listingId: 'apl_1',
      imageId: 5,
    });
  });

  it('removeScreenshot accepts { screenshotId }', () => {
    expect(removeListingScreenshotSchema.parse({ screenshotId: 'apls_1' })).toMatchObject({
      screenshotId: 'apls_1',
    });
  });

  it('reorderScreenshots accepts { listingId, orderedIds }', () => {
    // The field is `orderedIds` — asserted by PARSING a real payload rather than by
    // describing the shape from memory, which is exactly how this test caught an
    // author's wrong guess (`screenshotIds`) while it was being written.
    expect(
      reorderListingScreenshotsSchema.parse({ listingId: 'apl_1', orderedIds: ['apls_1'] })
    ).toMatchObject({ listingId: 'apl_1', orderedIds: ['apls_1'] });
  });

  it('updateScreenshotCaption accepts { screenshotId, caption }', () => {
    expect(
      updateListingScreenshotCaptionSchema.parse({ screenshotId: 'apls_1', caption: 'hi' })
    ).toMatchObject({ screenshotId: 'apls_1', caption: 'hi' });
  });

  it('getMyListingForApp accepts an appBlockId-only payload (the CLI’s shape)', () => {
    expect(getMyListingForAppSchema.parse({ appBlockId: 'ab_1' })).toMatchObject({
      appBlockId: 'ab_1',
    });
  });

  it('beginListingRevision accepts { listingId }', () => {
    expect(beginListingRevisionSchema.parse({ listingId: 'apl_1' })).toMatchObject({
      listingId: 'apl_1',
    });
  });

  it('submitListingRevision accepts { shadowId } with no changelog', () => {
    // `changelog` must stay OPTIONAL — a released CLI does not send it.
    expect(submitListingRevisionSchema.parse({ shadowId: 'apl_shadow' })).toMatchObject({
      shadowId: 'apl_shadow',
    });
  });

  it('🔴 NEGATIVE CONTROL: these schemas really do reject a wrong payload', () => {
    // Otherwise every `parse` above could be passing against a permissive `z.any()`
    // and would prove nothing about the contract.
    expect(() => setListingIconSchema.parse({ listingId: 'apl_1' })).toThrow();
    expect(() => removeListingScreenshotSchema.parse({})).toThrow();
    expect(() => submitListingRevisionSchema.parse({})).toThrow();
  });

  it('🔴 no collaborator field leaked into a CLI-facing schema', () => {
    // The temptation when widening a gate is to add "actingAs" / "collaboratorId" to
    // the input. That would be a wire-contract break. Access is derived SERVER-SIDE
    // from the session/token subject and never from the request body.
    for (const schema of [
      setListingIconSchema,
      setListingCoverSchema,
      addListingScreenshotSchema,
      removeListingScreenshotSchema,
      reorderListingScreenshotsSchema,
      updateListingScreenshotCaptionSchema,
      getMyListingForAppSchema,
      beginListingRevisionSchema,
      submitListingRevisionSchema,
    ]) {
      const keys = Object.keys((schema as unknown as { shape: Record<string, unknown> }).shape);
      expect(keys).not.toContain('actingAs');
      expect(keys).not.toContain('collaboratorId');
      expect(keys).not.toContain('onBehalfOf');
      expect(keys).not.toContain('appCollaboratorId');
    }
  });
});

describe('CLI scope annotations — the reachable set has not shrunk', () => {
  const annotations = ROUTER.match(/\.meta\(listingMediaCliScope\)/g) ?? [];

  it('POSITIVE CONTROL: the annotation really is found in the router source', () => {
    expect(ROUTER).toContain('const listingMediaCliScope');
    expect(annotations.length).toBeGreaterThan(0);
  });

  it('🔴 all 17 CLI-reachable owner-scoped listing procs remain annotated', () => {
    // An exact count, not a floor: losing one silently 403s every released CLI on that
    // command (an un-annotated proc implicitly requires TokenScope.Full, which the
    // scoped CLI token is not).
    //
    // 13 → 17 when `civitai app doctor` landed: `listMine` + `getAssets` (the problems
    // READS) and `updateListing` + `updateRevisionDraft` (the FIXES for
    // empty-description / empty-tagline / empty-category). The set stopped being
    // "listing MEDIA" at that point — the membership rule is written at the constant's
    // declaration in the router, and each proc states its own verdict at its own site.
    //
    // 🔴 THIS IS A COUNT OF DECLARATIONS, WHICH IS NOT A COUNT OF BEHAVIOUR. It fails
    // when the set grows or shrinks, and that is all it can do — a `.meta()` spelled on
    // the wrong proc satisfies it. The behavioural half is
    // `app-listings.router.cli-scope.test.ts`, which drives every one of these procs
    // through `enforceTokenScope` across the four credentials. Change both together.
    expect(annotations).toHaveLength(17);
  });

  it('the annotation still requires AppBlocksSubmit — the bit the CLI token carries', () => {
    expect(ROUTER).toContain(
      'const listingMediaCliScope = { requiredScope: TokenScope.AppBlocksSubmit } as const;'
    );
  });

  it('the new collaborator router does NOT annotate anything with a CLI scope', () => {
    // The CLI has no collaborator commands. An un-annotated proc implicitly requires
    // TokenScope.Full, which a session satisfies via enforceTokenScope's early return.
    const collabRouter = readFileSync(
      join(ROOT, 'src/server/routers/app-collaborators.router.ts'),
      'utf8'
    );
    expect(collabRouter).not.toContain('requiredScope');
  });
});
