import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import {
  clampRequestBrowsingLevels,
  clampToDomainCap,
  domainBrowsingLevelCap,
  requestDomainBrowsingLevelCap,
} from '~/server/utils/browsing-level';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { sponsoredBrowsingLevel } from '~/shared/utils/promotion';

const EVERYTHING = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX;

describe('domainBrowsingLevelCap', () => {
  it('holds signed-out viewers to PG, SFW-domain viewers to PG/PG-13, and caps no one else', () => {
    expect(domainBrowsingLevelCap({ isAuthorized: false, canViewNsfw: true })).toBe(
      publicBrowsingLevelsFlag
    );
    // The default audience on the SFW domain: signed out there is PG, not PG/PG-13.
    expect(domainBrowsingLevelCap({ isAuthorized: false, canViewNsfw: false })).toBe(
      publicBrowsingLevelsFlag
    );
    expect(domainBrowsingLevelCap({ isAuthorized: true, canViewNsfw: false })).toBe(
      sfwBrowsingLevelsFlag
    );
    expect(domainBrowsingLevelCap({ isAuthorized: true, canViewNsfw: true })).toBeUndefined();
  });
});

describe('requestDomainBrowsingLevelCap', () => {
  type CapCtx = Parameters<typeof requestDomainBrowsingLevelCap>[0];
  const signedInMature = (headers: Record<string, string>) =>
    ({
      user: { id: 1 },
      features: { canViewNsfw: true },
      req: { headers },
    } as unknown as CapCtx);

  it('caps a request with no Host at PG, even signed in where mature content is allowed', () => {
    expect(requestDomainBrowsingLevelCap(signedInMature({}))).toBe(publicBrowsingLevelsFlag);
    expect(
      requestDomainBrowsingLevelCap({ ...signedInMature({}), req: undefined } as unknown as CapCtx)
    ).toBe(publicBrowsingLevelsFlag);
  });

  it('caps a verified crawler with no Host at PG', () => {
    const crawler = {
      user: undefined,
      features: { canViewNsfw: true },
      req: { headers: { [VERIFIED_BOT_HEADER]: 'googlebot' } },
    } as unknown as CapCtx;
    expect(requestDomainBrowsingLevelCap(crawler)).toBe(publicBrowsingLevelsFlag);
  });

  it('caps nothing for the same viewer once the request names its host', () => {
    expect(requestDomainBrowsingLevelCap(signedInMature({ host: 'civitai.red' }))).toBeUndefined();
  });
});

describe('clampToDomainCap', () => {
  it('keeps what the cap allows, and gives the cap for nothing in common or nothing asked', () => {
    expect(clampToDomainCap(NsfwLevel.PG | NsfwLevel.R, sfwBrowsingLevelsFlag)).toBe(NsfwLevel.PG);
    expect(clampToDomainCap(NsfwLevel.R, sfwBrowsingLevelsFlag)).toBe(sfwBrowsingLevelsFlag);
    expect(clampToDomainCap(undefined, publicBrowsingLevelsFlag)).toBe(publicBrowsingLevelsFlag);
  });
});

/**
 * The sponsored gallery post is fetched at `preCapBrowsingLevel`, a field the
 * client sets. It is safe only because `applyDomainFeature` clamps it through
 * `clampRequestBrowsingLevels`; this pins what that yields for each audience.
 */
describe('a sponsored post asked for at every level', () => {
  const served = (isAuthorized: boolean, canViewNsfw: boolean) => {
    // What the client sends: the gallery-capped level, and everything before it.
    const input = { browsingLevel: NsfwLevel.PG, preCapBrowsingLevel: EVERYTHING };
    const cap = domainBrowsingLevelCap({ isAuthorized, canViewNsfw });
    if (cap !== undefined) clampRequestBrowsingLevels(input, cap);
    return sponsoredBrowsingLevel({ ...input, servingLevel: EVERYTHING });
  };

  it('is PG for a signed-out viewer, on either domain', () => {
    expect(served(false, true)).toBe(publicBrowsingLevelsFlag);
    expect(served(false, false)).toBe(publicBrowsingLevelsFlag);
  });

  it('is PG/PG-13 for a signed-in viewer on the SFW domain', () => {
    expect(served(true, false)).toBe(sfwBrowsingLevelsFlag);
  });

  it('is everything the run may be served at on a mature domain', () => {
    expect(served(true, true)).toBe(EVERYTHING);
  });
});
