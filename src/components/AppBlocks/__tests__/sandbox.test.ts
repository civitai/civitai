import { describe, expect, it } from 'vitest';
import {
  clampReviewSandbox,
  effectiveSandboxIsOpaque,
  intersectSandbox,
  type AppFrameOriginPolicy,
} from '../sandbox';

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
    expect(intersectSandbox(undefined, 'unverified').split(' ')).not.toContain('allow-same-origin');
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

  it('NEVER grants allow-popups-to-escape-sandbox, at ANY trust tier (#5209)', () => {
    // 🔴 PINS A DECISION, not an implementation detail. #5209 asked for
    // `navigate(path, 'new_tab')` to work; the tempting fix was to add this token
    // so the BLOCK could open its own tab. It was refused: a popup opened by the
    // frame inherits the opener's sandbox, so without this token it lands at an
    // opaque origin (logged out — worse than no link), and WITH it a third-party
    // block gets a browsing context free of the sandbox it was placed in. That is
    // a real escalation. The HOST opens the tab instead, from the unsandboxed
    // parent frame, where the destination is host-validated and the new context
    // inherits no sandbox at all.
    //
    // The pre-existing strip test above uses the fixture `'... allow-top-navigation
    // evil'`, so it never named THIS token — a future widening of
    // ALLOWED_SANDBOX_TOKENS would have gone unnoticed by every sandbox test.
    for (const tier of ['unverified', 'verified', 'internal', 'whatever-future-tier']) {
      const out = intersectSandbox(
        'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox',
        tier
      ).split(/\s+/);
      // Positive control in the same assertion: a sibling token from the SAME
      // declaration IS honoured, so a `toContain`-fails-open reading is excluded
      // and this is a measurement of the allowlist rather than of a broken input.
      expect(out, tier).toContain('allow-popups');
      expect(out, tier).not.toContain('allow-popups-to-escape-sandbox');
    }
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
 * MOD REVIEW SANDBOX (#2831) — clampReviewSandbox drops every mod-reaching
 * capability even if the pending manifest declares it, so a malicious review block
 * can't open a popup or trigger a download at the moderator's tab.
 */
describe('clampReviewSandbox (mod review render-only clamp)', () => {
  const MOD_REACHING = [
    'allow-popups',
    'allow-downloads',
    'allow-modals',
    'allow-pointer-lock',
    'allow-top-navigation',
    'allow-top-navigation-by-user-activation',
    'allow-popups-to-escape-sandbox',
  ];

  it('strips every mod-reaching token a malicious manifest declares — keeps only allow-scripts + allow-forms', () => {
    const declared =
      'allow-scripts allow-forms allow-popups allow-downloads allow-modals ' +
      'allow-pointer-lock allow-top-navigation allow-popups-to-escape-sandbox allow-same-origin';
    const out = clampReviewSandbox(declared).split(/\s+/);
    expect(out).toContain('allow-scripts');
    expect(out).toContain('allow-forms');
    for (const t of MOD_REACHING) expect(out).not.toContain(t);
    // NEVER allow-same-origin (the review host also forces the opaque origin).
    expect(out).not.toContain('allow-same-origin');
  });

  it('fails closed to the minimal allow-scripts floor for empty / all-stripped manifests', () => {
    for (const raw of [undefined, '', '   ', 'allow-popups allow-downloads allow-same-origin']) {
      expect(clampReviewSandbox(raw)).toBe('allow-scripts');
    }
  });

  it('the clamped string, run through intersectSandbox(unverified), stays opaque + render-only', () => {
    // Mirror the real wiring: ReviewBlockPreviewHost passes clampReviewSandbox()
    // and PageBlockHost re-runs intersectSandbox(…, 'unverified').
    const eff = intersectSandbox(
      clampReviewSandbox('allow-scripts allow-popups allow-downloads'),
      'unverified'
    );
    const tokens = eff.split(/\s+/);
    expect(tokens).toContain('allow-scripts');
    expect(tokens).not.toContain('allow-popups');
    expect(tokens).not.toContain('allow-downloads');
    expect(tokens).not.toContain('allow-same-origin');
    expect(effectiveSandboxIsOpaque(eff)).toBe(true); // opaque origin preserved
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

/**
 * Same-origin app frames (`mayGrantSameOrigin`, through `intersectSandbox`'s `frame`).
 *
 * The first case is the REGRESSION: an unverified app on its canonical published host,
 * with the viewer flag on, must run at a real origin (before this change it was always
 * opaque, so SharedWorker / localStorage / IndexedDB failed with origin 'null').
 *
 * The INVARIANT cases pin the boundary of the grant. For `unverified` they are guards
 * only: no such input got the token before the change either. For `verified`/`internal`
 * they are NEW BEHAVIOUR, red on the pre-change code: those tiers used to get the token
 * on any src, and now get it only on an app-frame host (when a policy exists).
 */
describe('intersectSandbox with a frame-origin policy', () => {
  // Pairwise-distinct roots, neither of them on the embedder's site (`example.org`).
  const APPS = 'apps-root.example';
  const PREVIEW = 'preview-root.example.net';
  const APP = 'my-app';
  const DEV = 'dev-0123456789abcdef';
  const SESSION = `s${'a'.repeat(61)}`;
  const policy = (over: Partial<AppFrameOriginPolicy> = {}): AppFrameOriginPolicy => ({
    appsDomain: APPS,
    previewDomain: PREVIEW,
    embedderHost: 'site.example.org',
    unverifiedEnabled: true,
    ...over,
  });
  const tokens = (
    src: string | undefined,
    trustTier: string,
    p: AppFrameOriginPolicy | null = policy(),
    extra: { reviewMode?: boolean; appLabel?: string; scopes?: string[] } = {}
  ) =>
    intersectSandbox('allow-forms', trustTier, {
      src,
      policy: p,
      appLabel: 'appLabel' in extra ? extra.appLabel : APP,
      scopes: extra.scopes,
      reviewMode: extra.reviewMode,
    }).split(/\s+/);

  it('REGRESSION: unverified + flag on + its own published host → allow-same-origin', () => {
    const out = tokens(`https://${APP}.${APPS}/`, 'unverified');
    expect(out).toContain('allow-same-origin');
    expect(out).toContain('allow-forms');
    expect(effectiveSandboxIsOpaque(out.join(' '))).toBe(false);
  });

  it('unverified + flag on: dev tunnel and App Assistant preview hosts get it too', () => {
    expect(tokens(`https://${DEV}.${APPS}/?dev=t`, 'unverified')).toContain('allow-same-origin');
    expect(tokens(`https://${SESSION}.${PREVIEW}/`, 'unverified')).toContain('allow-same-origin');
  });

  it('INVARIANT: unverified never gets it with the flag off, or with no policy', () => {
    const src = `https://${APP}.${APPS}/`;
    expect(tokens(src, 'unverified', policy({ unverifiedEnabled: false }))).not.toContain(
      'allow-same-origin'
    );
    expect(tokens(src, 'unverified', null)).not.toContain('allow-same-origin');
    // Control in the same test: the same src with the flag on does get it.
    expect(tokens(src, 'unverified')).toContain('allow-same-origin');
  });

  it('INVARIANT: unverified never gets it while declaring a shared-storage scope (GATE-2)', () => {
    const src = `https://${APP}.${APPS}/`;
    expect(
      tokens(src, 'unverified', policy(), { scopes: ['apps:storage', 'apps:storage:shared:read'] })
    ).not.toContain('allow-same-origin');
    // Control: other storage scopes do not block it.
    expect(
      tokens(src, 'unverified', policy(), { scopes: ['apps:storage', 'apps:storage:publish'] })
    ).toContain('allow-same-origin');
  });

  const NEVER: Array<[string, string]> = [
    ['the embedding site', 'https://site.example.org/apps/run/my-app'],
    ['a subdomain of the embedding site', `https://${APP}.site.example.org/`],
    ['another app’s published host', `https://other-app.${APPS}/`],
    ['its own label under the preview root', `https://${APP}.${PREVIEW}/`],
    ['a session label under the apps root', `https://${SESSION}.${APPS}/`],
    ['a dev label under the preview root', `https://${DEV}.${PREVIEW}/`],
    ['a malformed dev label', `https://dev-0123.${APPS}/`],
    ['plain http', `http://${APP}.${APPS}/`],
    ['an explicit port', `https://${APP}.${APPS}:8443/`],
    ['credentials in the URL', `https://u:p@${APP}.${APPS}/`],
    ['the root itself', `https://${APPS}/`],
    ['two labels deep', `https://a.${APP}.${APPS}/`],
    // `<app>x<root>`: dropping the dot from the suffix test would read the label as `<app>`.
    ['a lookalike without the dot', `https://${APP}x${APPS}/`],
    ['the root as a left-hand label', `https://${APPS}.evil.example/`],
    ['a trailing-dot host', `https://${APP}.${APPS}./`],
    ['an empty label (URL keeps a leading dot)', `https://.${APPS}/`],
    ['a relative src', '/apps/my-app/'],
    ['an unparseable src', 'not a url'],
    ['no src', ''],
  ];

  for (const [name, src] of NEVER) {
    it(`INVARIANT: never for ${name}, at any tier`, () => {
      for (const tier of ['unverified', 'verified', 'internal']) {
        expect(tokens(src, tier), `${tier} ${src}`).not.toContain('allow-same-origin');
      }
    });
  }

  it('INVARIANT: a review host is refused even when it is the app label', () => {
    const review = 'review-0123456789abcdef';
    for (const tier of ['unverified', 'verified', 'internal']) {
      expect(
        tokens(`https://${review}.${APPS}/`, tier, policy(), { appLabel: review })
      ).not.toContain('allow-same-origin');
    }
  });

  it('INVARIANT: with no app label, only dev tunnel and preview hosts qualify', () => {
    expect(
      tokens(`https://${APP}.${APPS}/`, 'unverified', policy(), { appLabel: undefined })
    ).not.toContain('allow-same-origin');
    expect(
      tokens(`https://${DEV}.${APPS}/`, 'unverified', policy(), { appLabel: undefined })
    ).toContain('allow-same-origin');
  });

  it('the default port is normalised away by URL, so :443 is the canonical host', () => {
    expect(new URL(`https://${APP}.${APPS}:443/`).port).toBe('');
    expect(tokens(`https://${APP}.${APPS}:443/`, 'unverified')).toContain('allow-same-origin');
  });

  it('INVARIANT: an unknown embedding host grants nothing, at any tier', () => {
    for (const tier of ['unverified', 'verified', 'internal']) {
      expect(tokens(`https://${APP}.${APPS}/`, tier, policy({ embedderHost: '' }))).not.toContain(
        'allow-same-origin'
      );
    }
  });

  it('INVARIANT: a root on the embedding site, or a parent of it, is ignored', () => {
    // The embedder's site is `example.org`: the site itself, a root under it, and a root
    // that is a parent of it are all refused, at every tier.
    for (const root of ['example.org', 'apps.example.org', 'site.example.org']) {
      const p = policy({ appsDomain: root, previewDomain: null });
      for (const tier of ['unverified', 'verified', 'internal']) {
        expect(tokens(`https://${APP}.${root}/`, tier, p), `${tier} ${root}`).not.toContain(
          'allow-same-origin'
        );
      }
    }
    // A bare TLD is never a root.
    expect(
      tokens(`https://${APP}.example/`, 'unverified', policy({ appsDomain: 'example' }))
    ).not.toContain('allow-same-origin');
  });

  it('INVARIANT: the embedding host is compared without its port', () => {
    // A dev or preview host header carries a port; the site check must still see the site.
    const p = policy({ appsDomain: 'apps.example.org', embedderHost: 'site.example.org:8443' });
    expect(tokens(`https://${APP}.apps.example.org/`, 'unverified', p)).not.toContain(
      'allow-same-origin'
    );
  });

  it('a mixed-case src or app label is the same host (URL lowercases the host)', () => {
    expect(tokens(`https://MY-APP.${APPS.toUpperCase()}/`, 'unverified')).toContain(
      'allow-same-origin'
    );
    expect(
      tokens(`https://${APP}.${APPS}/`, 'unverified', policy(), { appLabel: 'My-App' })
    ).toContain('allow-same-origin');
  });

  it('INVARIANT: a review mount never gets it, whatever the host or tier', () => {
    for (const tier of ['unverified', 'verified', 'internal']) {
      expect(tokens(`https://${APP}.${APPS}/`, tier, policy(), { reviewMode: true })).not.toContain(
        'allow-same-origin'
      );
    }
  });

  it('INVARIANT: verified/internal with a policy keep it only on their own frame host', () => {
    for (const tier of ['verified', 'internal']) {
      expect(tokens(`https://${APP}.${APPS}/`, tier)).toContain('allow-same-origin');
      expect(tokens('https://elsewhere.example.com/', tier)).not.toContain('allow-same-origin');
      // The trusted grant does not depend on the viewer flag, nor on the GATE-2 scope rule.
      expect(
        tokens(`https://${APP}.${APPS}/`, tier, policy({ unverifiedEnabled: false }), {
          scopes: ['apps:storage:shared:read'],
        })
      ).toContain('allow-same-origin');
    }
  });

  it('verified/internal with NO policy keep the token as before (no AppProvider above the host)', () => {
    for (const tier of ['verified', 'internal']) {
      expect(tokens('http://localhost:5173/', tier, null)).toContain('allow-same-origin');
    }
  });
});
