import { describe, expect, it } from 'vitest';
import {
  ECO,
  baseModelRecords,
  getBaseModelLicense,
  getBaseModelsByEcosystemId,
  licenses as sharedLicenses,
} from '@civitai/shared/basemodel.constants';
import { baseModelLicenses } from '~/server/common/constants';
import type { BaseModel } from '@civitai/shared/basemodel.constants';

// The 2 Aug 2026 revision the on-site weights carry. A moving ref here would let
// MiniMax rewrite the terms we point creators at, which is what section III.1's
// "provide a copy" exists to prevent.
const PERMALINK =
  'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE';

// Section IV.2 names the string verbatim: "You shall prominently display
// "MiniMax H3" on the user interface". Not the on-site display name
// ("Hailuo H3 by MiniMax"), and not III.3(a)'s encouraged "Powered by" form.
const REQUIRED_ATTRIBUTION = 'MiniMax H3';

// Throws rather than returning undefined so a removed record fails as a named
// error everywhere, instead of a TypeError in whichever test dereferences first.
function h3Record() {
  const record = baseModelRecords.find((r) => r.ecosystemId === ECO.MiniMaxH3);
  if (!record) throw new Error('no base-model record registered for ECO.MiniMaxH3');
  return record;
}

const serverLicense = () => baseModelLicenses[h3Record().name as BaseModel];

describe('MiniMax H3 licence registration', () => {
  it('registers the licence in the copy that enforces, under the live base-model name', () => {
    // `BaseModel` is `string`, so a drifted key compiles fine and goes silently
    // inert. Deriving the key from the record is what catches that.
    const license = serverLicense();
    expect(license, `no licence bound for base model '${h3Record().name}'`).toBeDefined();
    expect(license!.name).toBe('MiniMax H3 Community License Agreement');
  });

  it('resolves through the chain the generator actually walks', () => {
    const license = getBaseModelsByEcosystemId(ECO.MiniMaxH3)
      .map((baseModel) => getBaseModelLicense(baseModel.id))
      .find((found) => !!found?.attribution);
    expect(license?.attribution).toBe(REQUIRED_ATTRIBUTION);
  });

  // Hand-listing the fields would let a policy flag added to one copy alone pass
  // unnoticed, which is the drift this test exists to catch. `id` is the shared
  // copy's join key and has no counterpart in the map keyed by display name.
  it('keeps the two unsynced copies saying the same thing', () => {
    const shared = sharedLicenses.find((l) => l.id === h3Record().licenseId);
    expect(shared, `no shared licence record for id ${h3Record().licenseId}`).toBeDefined();
    const { id: _id, ...sharedFields } = shared!;
    expect(sharedFields).toEqual(serverLicense());
  });

  it('points at a pinned revision of the licence text', () => {
    expect(serverLicense()!.url).toBe(PERMALINK);
  });

  it('names the excluded territories the agreement defines', () => {
    const notice = serverLicense()!.notice ?? '';
    for (const territory of [
      'European Union',
      'United Kingdom',
      'Republic of Korea',
      'United States of America',
    ]) {
      expect(notice, `notice omits ${territory}`).toContain(territory);
    }
  });

  // Both were considered and deliberately rejected: the agreement permits
  // commercial use below its revenue threshold, and does not bar mature
  // derivatives. Either flag appearing here would block creators.
  it('imposes no commercial or mature restriction', () => {
    const server = serverLicense()!;
    expect(server.nonCommercial).toBeUndefined();
    expect(server.disableMature).toBeUndefined();
    expect(server.restrictedNsfwLevels).toBeUndefined();
    expect(server.requiresSameLicense).toBeUndefined();
  });
});

describe('attribution is not a dumping ground', () => {
  // `poweredBy` holds a 300-character liability disclaimer for the three Flux
  // licences, so anything iterating it renders that under the generator's CTA.
  // `attribution` exists to mean one thing only; this is the whitelist, not a
  // spot-check, because the cost of a wrong entry is paid on every ecosystem.
  it('is set only where a licence demands in-product naming', () => {
    const carrying = sharedLicenses.filter((l) => !!l.attribution).map((l) => l.name);
    expect(carrying).toEqual(['MiniMax H3 Community License Agreement']);
  });

  // Same whitelist over the other copy, which the shared one cannot see.
  it('is set on no other base model in the enforcing copy', () => {
    const carrying = Object.entries(baseModelLicenses)
      .filter(([, license]) => !!license?.attribution)
      .map(([baseModel]) => baseModel);
    expect(carrying).toEqual([h3Record().name]);
  });

  // The disclaimer that motivated the split is 300 characters.
  it('holds a short attribution string, never a disclaimer', () => {
    for (const license of sharedLicenses.filter((l) => !!l.attribution)) {
      expect(license.attribution!.length, `${license.name} attribution is too long`).toBeLessThan(
        60
      );
    }
  });
});
