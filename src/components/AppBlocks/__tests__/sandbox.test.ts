import { describe, expect, it } from 'vitest';
import { effectiveSandboxIsOpaque, intersectSandbox } from '../sandbox';

/**
 * L-SANDBOX coverage. intersectSandbox derives the iframe `sandbox`
 * attribute from the manifest's declared tokens. The audit flagged that an
 * empty/garbage declaration fell open to a bare `allow-scripts` default in a
 * way that could silently widen; the fix makes the floor an explicit minimal
 * safe set and guarantees the result is never wider than what was declared.
 */
describe('intersectSandbox', () => {
  it('fails closed to the minimal safe set when no recognized tokens are declared', () => {
    // empty string, whitespace, undefined, and all-unrecognized declarations
    // must all collapse to exactly the minimal floor — never a wider set.
    for (const raw of [undefined, '', '   ', 'allow-top-navigation allow-same-origin']) {
      expect(intersectSandbox(raw, 'unverified')).toBe('allow-scripts');
    }
  });

  it('never grants allow-same-origin to an untrusted tier even if declared', () => {
    // allow-same-origin is not in the allowlist, so a manifest cannot
    // self-grant it; an unverified block gets only the minimal floor.
    expect(intersectSandbox('allow-same-origin', 'unverified')).toBe('allow-scripts');
  });

  it('adds allow-same-origin only for trusted tiers', () => {
    expect(intersectSandbox(undefined, 'verified').split(' ')).toContain('allow-same-origin');
    expect(intersectSandbox(undefined, 'internal').split(' ')).toContain('allow-same-origin');
    expect(intersectSandbox(undefined, 'unverified').split(' ')).not.toContain(
      'allow-same-origin'
    );
  });

  it('honors recognized declared tokens (union with the minimal floor)', () => {
    const out = intersectSandbox('allow-forms allow-popups', 'unverified').split(' ');
    expect(out).toContain('allow-scripts'); // minimal floor always present
    expect(out).toContain('allow-forms');
    expect(out).toContain('allow-popups');
  });

  it('strips unrecognized tokens but keeps recognized ones', () => {
    const out = intersectSandbox('allow-forms allow-top-navigation evil', 'unverified').split(' ');
    expect(out).toContain('allow-forms');
    expect(out).not.toContain('allow-top-navigation');
    expect(out).not.toContain('evil');
  });

  it('result is never wider than declared ∪ minimal ∪ (tier same-origin)', () => {
    // Property check: every output token is either the minimal floor, a
    // validly-declared token, or the tier-gated allow-same-origin.
    const declared = 'allow-forms allow-downloads';
    const out = intersectSandbox(declared, 'verified').split(' ');
    const allowed = new Set([
      'allow-scripts',
      'allow-forms',
      'allow-downloads',
      'allow-same-origin',
    ]);
    for (const t of out) expect(allowed.has(t)).toBe(true);
  });
});

/**
 * L-OPAQUE caller derivation. The host's postMessage transport must run in
 * opaque mode iff the EFFECTIVE iframe sandbox lacks `allow-same-origin` (i.e.
 * the frame runs at an opaque 'null' origin). Both callers (PageBlockHost +
 * IframeHost) derive `opaqueOrigin = effectiveSandboxIsOpaque(effectiveSandbox)`
 * from the SAME `intersectSandbox(...)` value they hand to the iframe
 * `sandbox` attribute, so transport mode can never drift from the actual frame
 * origin.
 */
describe('effectiveSandboxIsOpaque (transport-mode derivation)', () => {
  it('unverified tier → no allow-same-origin → opaque (true)', () => {
    const eff = intersectSandbox('allow-forms', 'unverified');
    expect(eff.split(/\s+/)).not.toContain('allow-same-origin');
    expect(effectiveSandboxIsOpaque(eff)).toBe(true);
  });

  it('internal tier → has allow-same-origin → NOT opaque (false, pinned path preserved)', () => {
    const eff = intersectSandbox('allow-forms', 'internal');
    expect(eff.split(/\s+/)).toContain('allow-same-origin');
    expect(effectiveSandboxIsOpaque(eff)).toBe(false);
  });

  it('verified tier → has allow-same-origin → NOT opaque (false)', () => {
    expect(effectiveSandboxIsOpaque(intersectSandbox(undefined, 'verified'))).toBe(false);
  });

  it('direct token checks', () => {
    expect(effectiveSandboxIsOpaque('allow-scripts')).toBe(true);
    expect(effectiveSandboxIsOpaque('allow-scripts allow-same-origin')).toBe(false);
    // word-boundary safe: a token that merely contains the substring is not a match
    expect(effectiveSandboxIsOpaque('allow-same-origin-ish')).toBe(true);
  });
});
