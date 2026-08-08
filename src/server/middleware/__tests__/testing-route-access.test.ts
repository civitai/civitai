import { describe, expect, it } from 'vitest';
import { canAccessTestingRoute } from '~/server/middleware/testing-route-access';

// The exemption this covers exists so a preview environment can trigger a synthetic
// event-loop stall. The endpoint's job is to hard-lock an app server, so the guard is
// worth pinning case by case rather than trusting a reading of `endsWith`.

const STALL = '/api/testing/eventloop-stall';

describe('canAccessTestingRoute', () => {
  it('allows everything off production, as before', () => {
    for (const pathname of [STALL, '/api/testing/referrals', '/api/testing/anything']) {
      expect(
        canAccessTestingRoute({ pathname, hostname: 'localhost', isProduction: false }),
        pathname
      ).toBe(true);
    }
  });

  it('allows the stall endpoint on a preview host', () => {
    for (const hostname of ['pr-1.civitaic.com', 'pr-3752.civitaic.com', 'a.b.civitaic.com']) {
      expect(
        canAccessTestingRoute({ pathname: STALL, hostname, isProduction: true }),
        hostname
      ).toBe(true);
    }
  });

  it('🔴 refuses the stall endpoint on the production hostname', () => {
    for (const hostname of ['civitai.com', 'www.civitai.com', 'civitai.red']) {
      expect(
        canAccessTestingRoute({ pathname: STALL, hostname, isProduction: true }),
        hostname
      ).toBe(false);
    }
  });

  it('🔴 refuses hostnames that merely resemble a preview host', () => {
    // `civitaic.com` and `civitai.com` differ by one character, and the suffix match
    // has to be anchored on the dot or a lookalike registration would satisfy it.
    for (const hostname of [
      'evil-civitaic.com', // no separating dot
      'civitaic.com', // bare apex, not a preview subdomain
      'xcivitaic.com',
      'pr-1.civitaic.com.evil.com', // preview host as a prefix of someone else's domain
      'civitaic.com.evil.com',
      'pr-1.civitai.com', // the real domain, preview-shaped
    ]) {
      expect(
        canAccessTestingRoute({ pathname: STALL, hostname, isProduction: true }),
        hostname
      ).toBe(false);
    }
  });

  it('🔴 does NOT widen any other testing route on a preview host', () => {
    // The whole argument for touching this shared guard was that it opens exactly one
    // path. If this ever fails, the blast radius of the change is no longer what was
    // reviewed.
    for (const pathname of [
      '/api/testing/referrals',
      '/api/testing/gift-membership',
      '/api/testing/blue-buzz-paid-access',
      `${STALL}/extra`,
      '/api/testing/eventloop-stall-other',
      '/api/testing',
    ]) {
      expect(
        canAccessTestingRoute({ pathname, hostname: 'pr-1.civitaic.com', isProduction: true }),
        pathname
      ).toBe(false);
    }
  });
});
