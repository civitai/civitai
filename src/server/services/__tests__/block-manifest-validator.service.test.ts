import { describe, expect, it } from 'vitest';
import { BlockManifestValidator } from '../block-manifest-validator.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const VALID_MANIFEST = {
  blockId: 'test-block',
  version: '1.0.0',
  name: 'Test Block',
  contentRating: 'g',
  renderMode: 'iframe',
  trustTier: 'unverified',
  scopes: ['models:read:self'],
  iframe: {
    src: 'https://blocks.civitai.com/test',
    minHeight: 200,
    maxHeight: null,
    resizable: true,
    sandbox: 'allow-scripts',
  },
};

// H-8: the validator gates iframe.src against the app's registered
// OauthClient.allowedOrigins. Tests that expect VALID_MANIFEST to pass must
// supply an AppContext whose allowedOrigins covers blocks.civitai.com — the
// bare-number form defaults allowedOrigins to [] and (correctly) rejects.
const APP_CTX = {
  allowedScopes: TokenScope.ModelsRead,
  allowedOrigins: ['https://blocks.civitai.com'],
};

describe('BlockManifestValidator', () => {
  it('accepts a fully valid manifest', () => {
    const result = BlockManifestValidator.validate(VALID_MANIFEST, APP_CTX);
    expect(result).toEqual({ valid: true });
  });

  it('rejects PascalCase scope strings', () => {
    const manifest = { ...VALID_MANIFEST, scopes: ['Models:Read:Self'] };
    const result = BlockManifestValidator.validate(manifest, TokenScope.ModelsRead);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('lowercase'))).toBe(true);
    }
  });

  it('rejects sandbox combining allow-same-origin with allow-scripts at unverified tier', () => {
    const manifest = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, sandbox: 'allow-scripts allow-same-origin' },
    };
    const result = BlockManifestValidator.validate(manifest, TokenScope.ModelsRead);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // either the token-allowlist rejection or the defense-in-depth combo check
      expect(
        result.errors.some((e) => e.includes('allow-same-origin') || e.includes('not allowed'))
      ).toBe(true);
    }
  });

  it('rejects sandbox containing allow-top-navigation', () => {
    const manifest = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, sandbox: 'allow-scripts allow-top-navigation' },
    };
    const result = BlockManifestValidator.validate(manifest, TokenScope.ModelsRead);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some(
          (e) => e.includes('allow-top-navigation') || e.includes('not allowed')
        )
      ).toBe(true);
    }
  });

  it('rejects allow-popups-to-escape-sandbox (boundary escape, allowlist miss)', () => {
    const manifest = {
      ...VALID_MANIFEST,
      iframe: {
        ...VALID_MANIFEST.iframe,
        sandbox: 'allow-scripts allow-popups-to-escape-sandbox',
      },
    };
    const result = BlockManifestValidator.validate(manifest, TokenScope.ModelsRead);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('allow-popups-to-escape-sandbox'))).toBe(true);
    }
  });

  it('accepts allow-modals on verified tier but not unverified', () => {
    const unverified = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, sandbox: 'allow-scripts allow-modals' },
    };
    expect(
      BlockManifestValidator.validate(unverified, APP_CTX).valid
    ).toBe(false);

    const verified = { ...unverified, trustTier: 'verified' };
    expect(BlockManifestValidator.validate(verified, APP_CTX).valid).toBe(true);
  });

  // M-POPUPS (audit medium): allow-popups is dropped from the unverified tier
  // so an approved-but-unverified block can't window.open() a phishing URL
  // from a visually-trusted .civit.ai subdomain. Still allowed for verified.
  it('M-POPUPS: rejects allow-popups on the unverified tier', () => {
    const unverified = {
      ...VALID_MANIFEST,
      trustTier: 'unverified',
      iframe: { ...VALID_MANIFEST.iframe, sandbox: 'allow-scripts allow-popups' },
    };
    const result = BlockManifestValidator.validate(unverified, TokenScope.ModelsRead);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some(
          (e) => e.includes('allow-popups') || e.includes('not allowed')
        )
      ).toBe(true);
    }
  });

  it('M-POPUPS: still accepts allow-popups on the verified tier', () => {
    const verified = {
      ...VALID_MANIFEST,
      trustTier: 'verified',
      iframe: { ...VALID_MANIFEST.iframe, sandbox: 'allow-scripts allow-popups' },
    };
    // Pass the full AppContext (with allowedOrigins) — the H-8 origin gate
    // otherwise rejects on "no allowedOrigins registered" before sandbox check.
    expect(
      BlockManifestValidator.validate(verified, {
        allowedScopes: TokenScope.ModelsRead,
        allowedOrigins: ['https://blocks.civitai.com'],
      }).valid
    ).toBe(true);
  });

  it('rejects iframe heights outside the [40, 4000] envelope', () => {
    const tiny = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, minHeight: 10 },
    };
    expect(BlockManifestValidator.validate(tiny, TokenScope.ModelsRead).valid).toBe(false);

    const huge = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, maxHeight: 100000 },
    };
    expect(BlockManifestValidator.validate(huge, TokenScope.ModelsRead).valid).toBe(false);

    const inverted = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, minHeight: 500, maxHeight: 200 },
    };
    const result = BlockManifestValidator.validate(inverted, TokenScope.ModelsRead);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('iframe.maxHeight must be ≥'))).toBe(true);
    }
  });

  it('rejects scopes the OAuth client does not allow', () => {
    const manifest = { ...VALID_MANIFEST, scopes: ['models:read:self', 'buzz:read:self'] };
    const result = BlockManifestValidator.validate(manifest, TokenScope.ModelsRead);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('exceed OAuth client'))).toBe(true);
    }
  });

  it('rejects inline render mode on the unverified tier', () => {
    const manifest = { ...VALID_MANIFEST, renderMode: 'inline', trustTier: 'unverified' };
    const result = BlockManifestValidator.validate(manifest, TokenScope.ModelsRead);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('INLINE_REQUIRES_VERIFIED_TIER');
    }
  });

  it('rejects iframe.src that is not https', () => {
    const manifest = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, src: 'http://blocks.civitai.com/test' },
    };
    const result = BlockManifestValidator.validate(manifest, TokenScope.ModelsRead);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('iframe.src'))).toBe(true);
    }
  });

  it.each([
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.0.0.1/x',
    'https://192.168.1.1/x',
    'https://169.254.169.254/x',
    'https://172.16.0.1/x',
    'https://metadata.google.internal/x',
    'https://service.local/x',
    'https://hosted.internal/x',
    'https://example/x', // no dot — reject
  ])('rejects private/internal iframe.src %s (SSRF gate)', (badSrc) => {
    const manifest = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, src: badSrc },
    };
    expect(BlockManifestValidator.validate(manifest, TokenScope.ModelsRead).valid).toBe(false);
  });

  it('rejects assetBundleUrl pointing at private/internal hosts', () => {
    const manifest = {
      ...VALID_MANIFEST,
      assetBundleUrl: 'https://169.254.169.254/bundle.zip',
    };
    const result = BlockManifestValidator.validate(manifest, TokenScope.ModelsRead);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('assetBundleUrl'))).toBe(true);
    }
  });

  it('accepts a public-DNS https iframe.src', () => {
    const manifest = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, src: 'https://blocks.civitai.com/test' },
    };
    expect(BlockManifestValidator.validate(manifest, APP_CTX).valid).toBe(true);
  });

  it('H-8: rejects iframe.src on an origin not in OauthClient.allowedOrigins', () => {
    const manifest = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, src: 'https://impostor.example.com/test' },
    };
    const result = BlockManifestValidator.validate(manifest, {
      allowedScopes: TokenScope.ModelsRead,
      allowedOrigins: ['https://blocks.civitai.com'],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('iframe.src rejected'))).toBe(true);
    }
  });

  it('H-8: accepts iframe.src on an allowedOrigin', () => {
    const manifest = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, src: 'https://blocks.civitai.com/test' },
    };
    expect(
      BlockManifestValidator.validate(manifest, {
        allowedScopes: TokenScope.ModelsRead,
        allowedOrigins: ['https://blocks.civitai.com'],
      }).valid
    ).toBe(true);
  });

  it('H-8: rejects iframe.src when app has no allowedOrigins', () => {
    const manifest = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, src: 'https://blocks.civitai.com/test' },
    };
    const result = BlockManifestValidator.validate(manifest, {
      allowedScopes: TokenScope.ModelsRead,
      allowedOrigins: [],
    });
    expect(result.valid).toBe(false);
  });

  it('M-5: rejects whitespace-only sandbox attribute', () => {
    const manifest = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, sandbox: '   ' },
    };
    const result = BlockManifestValidator.validate(manifest, TokenScope.ModelsRead);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('at least one token'))).toBe(true);
    }
  });

  it.each([
    'https://0x7f000001/x', // single hex IPv4
    'https://2130706433/x', // integer-form IPv4
  ])('B4: rejects dotless encoded IPv4 literal %s', (badSrc) => {
    const manifest = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, src: badSrc },
    };
    expect(BlockManifestValidator.validate(manifest, TokenScope.ModelsRead).valid).toBe(false);
  });

  it.each([
    'https://0x7f.0x0.0x0.0x1/x', // hex IPv4 literal
    'https://0177.0.0.1/x', // octal IPv4 literal
  ])('M-1: rejects encoded IP literals %s', (badSrc) => {
    const manifest = {
      ...VALID_MANIFEST,
      iframe: { ...VALID_MANIFEST.iframe, src: badSrc },
    };
    expect(BlockManifestValidator.validate(manifest, TokenScope.ModelsRead).valid).toBe(false);
  });

  // W10 — targets[].slotId validation (closes the pre-existing gap) + page field.
  describe('W10 targets[].slotId + page', () => {
    it('accepts a manifest with valid model-slot targets', () => {
      const manifest = {
        ...VALID_MANIFEST,
        targets: [{ slotId: 'model.sidebar_top' }, { slotId: 'model.below_images' }],
      };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it('rejects a target with an unknown slotId', () => {
      const manifest = {
        ...VALID_MANIFEST,
        targets: [{ slotId: 'model.does_not_exist' }],
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('not a known slot'))).toBe(true);
      }
    });

    it('rejects the page slot used as a target (page is declared via the page field)', () => {
      const manifest = {
        ...VALID_MANIFEST,
        targets: [{ slotId: 'app.page' }],
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('page slot'))).toBe(true);
      }
    });

    it('rejects a target missing slotId', () => {
      const manifest = { ...VALID_MANIFEST, targets: [{}] };
      expect(BlockManifestValidator.validate(manifest, APP_CTX).valid).toBe(false);
    });

    it('accepts a valid page descriptor', () => {
      const manifest = {
        ...VALID_MANIFEST,
        page: { path: '/', title: 'My App', icon: 'apps' },
      };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it('rejects page.path that does not start with /', () => {
      const manifest = { ...VALID_MANIFEST, page: { path: 'home', title: 'X' } };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('page.path must start with'))).toBe(true);
      }
    });

    it('rejects a page with no path', () => {
      const manifest = { ...VALID_MANIFEST, page: { title: 'X' } };
      expect(BlockManifestValidator.validate(manifest, APP_CTX).valid).toBe(false);
    });

    it('rejects a page with no title', () => {
      const manifest = { ...VALID_MANIFEST, page: { path: '/' } };
      expect(BlockManifestValidator.validate(manifest, APP_CTX).valid).toBe(false);
    });

    it('rejects a page declaration with no iframe block', () => {
      const { iframe: _iframe, ...noIframe } = VALID_MANIFEST;
      const manifest = {
        ...noIframe,
        renderMode: 'inline',
        trustTier: 'verified',
        page: { path: '/', title: 'X' },
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('must also declare an iframe'))).toBe(true);
      }
    });

    // W10 generation spend — optional page.buzzBudgetPerGen.
    it('accepts a page declaring a positive integer buzzBudgetPerGen', () => {
      const manifest = {
        ...VALID_MANIFEST,
        page: { path: '/', title: 'X', buzzBudgetPerGen: 200 },
      };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it('accepts a page that omits buzzBudgetPerGen (optional → platform default)', () => {
      const manifest = { ...VALID_MANIFEST, page: { path: '/', title: 'X' } };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it.each([
      [0, 'zero'],
      [-5, 'negative'],
      [12.5, 'non-integer'],
      ['200' as unknown as number, 'string'],
    ])('rejects a %s buzzBudgetPerGen (%s)', (value) => {
      const manifest = {
        ...VALID_MANIFEST,
        page: { path: '/', title: 'X', buzzBudgetPerGen: value },
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('buzzBudgetPerGen'))).toBe(true);
      }
    });

    // A value above the per-gen cap is NOT rejected at validation time — the
    // mint handler clamps it to BUZZ_BUDGET_CAP. The validator only enforces
    // shape (positive integer).
    it('accepts an above-cap buzzBudgetPerGen (clamped at mint, not rejected here)', () => {
      const manifest = {
        ...VALID_MANIFEST,
        page: { path: '/', title: 'X', buzzBudgetPerGen: 5000 },
      };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });
  });
});
