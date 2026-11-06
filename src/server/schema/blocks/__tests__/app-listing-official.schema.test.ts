import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  submitExternalListingSchema,
  updateListingPatchSchema,
  updateListingSchema,
  updateRevisionDraftSchema,
} from '~/server/schema/blocks/offsite-listing.schema';
import { setListingOfficialSchema } from '~/server/schema/blocks/offsite-moderation.schema';
import { withoutUndocumentedRestFields } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * The "Official" flag is MODERATOR-SET. These pin the author side of that boundary: no author
 * input schema accepts the key (zod strips it), so the only writer is the moderator mutation.
 *
 * The "author inputs" cases are INVARIANT GUARDS: zod already stripped unknown keys before
 * this feature, so they are green on the pre-change tree. They fail the day someone adds
 * `isOfficial` to an author schema, which is the regression they exist for.
 */

const SUBMIT = {
  slug: 'my-ext-app',
  name: 'My Ext App',
  connectClientId: 'occ_123',
  scopeJustifications: {},
};

describe('author inputs cannot set isOfficial', () => {
  it('updateListing: the key is stripped from a patch that also changes something else', () => {
    const parsed = updateListingSchema.parse({
      listingId: 'apl_1',
      patch: { name: 'Renamed', isOfficial: true },
    });
    expect(parsed.patch).toEqual({ name: 'Renamed' });
    expect('isOfficial' in parsed.patch).toBe(false);
  });

  it('updateListing: a patch carrying ONLY isOfficial is rejected (it changes nothing)', () => {
    expect(updateListingPatchSchema.safeParse({ isOfficial: true }).success).toBe(false);
    // Positive control: the same shape with a real field is accepted.
    expect(updateListingPatchSchema.safeParse({ name: 'x' }).success).toBe(true);
  });

  it('updateRevisionDraft: the key is stripped', () => {
    const parsed = updateRevisionDraftSchema.parse({
      shadowId: 'apl_shadow',
      patch: { tagline: 'hi', isOfficial: true },
    });
    expect(parsed.patch).toEqual({ tagline: 'hi' });
  });

  it('submitExternalListing: the key is stripped', () => {
    const parsed = submitExternalListingSchema.parse({ ...SUBMIT, isOfficial: true });
    expect('isOfficial' in parsed).toBe(false);
    // Positive control: a field the schema does know survives the same parse.
    expect(parsed.name).toBe('My Ext App');
  });
});

describe('the moderator input', () => {
  it('requires a boolean flag and a listing id', () => {
    expect(setListingOfficialSchema.parse({ appListingId: 'apl_1', isOfficial: true })).toEqual({
      appListingId: 'apl_1',
      isOfficial: true,
    });
    expect(setListingOfficialSchema.safeParse({ appListingId: 'apl_1' }).success).toBe(false);
    expect(
      setListingOfficialSchema.safeParse({ appListingId: 'apl_1', isOfficial: 'yes' }).success
    ).toBe(false);
    expect(setListingOfficialSchema.safeParse({ appListingId: '', isOfficial: true }).success).toBe(
      false
    );
  });
});

describe('the public REST contract is unchanged', () => {
  it('withoutUndocumentedRestFields drops isOfficial AND restrictedAudience, keeps the rest', () => {
    const dto = { id: 'apl_1', isBeta: true, isOfficial: true, restrictedAudience: null };
    expect(withoutUndocumentedRestFields(dto)).toEqual({ id: 'apl_1', isBeta: true });
  });
});

/**
 * 🔴 INVARIANT GUARD, not regression coverage: green on the pre-change tree too,
 * because the field did not exist there. It pins that the column stays OUT of the generated
 * Prisma client — the property that makes the deploy safe before the manual migration, and
 * that keeps every author write (all Prisma-delegate writes) structurally unable to set it.
 */
describe('isOfficial stays out of the Prisma client', () => {
  it('the generated AppListing scalar enum has no isOfficial', () => {
    expect(Object.keys(Prisma.AppListingScalarFieldEnum)).not.toContain('isOfficial');
    // Positive control: the enum is the real one (a field we know is present).
    expect(Object.keys(Prisma.AppListingScalarFieldEnum)).toContain('slug');
  });
});
