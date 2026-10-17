import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFastPathAssumptions } from '../trpc-server/fast-path.mjs';

/**
 * The standalone tRPC server refuses to start when the build breaks an assumption that lets it skip
 * Next's router for `/api/trpc/*`. Driven against synthetic `.next` trees (a real build takes
 * minutes). Each broken case asserts ITS OWN message, so a case cannot pass because a different
 * check fired; the healthy tree is the positive control that every check can also pass.
 */

const nextConfig = {
  compress: false,
  basePath: '',
  i18n: { locales: ['en'], defaultLocale: 'en' },
  experimental: {},
};

// The proxy matchers a real (i18n) build emits for '/((?!api|...).*)' and '/api/trpc/:path*'.
// Both carry a locale slot: Next matches them against the locale-prefixed path.
const PAGE_MATCHER =
  '^(?:\\/(_next\\/data\\/[^/]{1,}))?(?:\\/((?!_next\\/)[^/.]{1,}))(?:\\/((?!api|_next|favicon.ico|region-blocked|fonts|sounds|robots.txt|site.webmanifest).*))(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$';
const TRPC_MATCHER =
  '^(?:\\/(_next\\/data\\/[^/]{1,}))?(?:\\/((?!_next\\/)[^/.]{1,}))\\/api\\/trpc(?:\\/((?:[^\\/#\\?]+?)(?:\\/(?:[^\\/#\\?]+?))*))?(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$';

// Shapes copied from a real build's manifests (routes-manifest, pages-manifest,
// functions-config-manifest), trimmed to what the checks read.
function healthyTree() {
  return {
    routes: {
      headers: [
        {
          source: '/:nextInternalLocale(en)/((?!gift-cards).*)',
          regex: '^(?:/(en))(?:/((?!gift-cards).*))(?:/)?$',
          headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
        },
      ],
      redirects: [
        {
          source: '/:path+/',
          regex: '^(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))/$',
          destination: '/:path+',
          internal: true,
        },
        { source: '/en/leaderboard', regex: '^/en/leaderboard(?:/)?$', destination: '/x' },
      ],
      rewrites: {
        beforeFiles: [],
        afterFiles: [
          {
            source: '/:nextInternalLocale(en)/_axiom/logs',
            regex: '^(?:/(en))/_axiom/logs(?:/)?$',
            destination: 'https://example.invalid/logs',
          },
        ],
        fallback: [],
      },
      onMatchHeaders: [],
    },
    pages: { '/api/trpc/[trpc]': 'pages/api/trpc/[trpc].js', '/api/health': 'pages/api/health.js' },
    functions: {
      functions: {
        '/_middleware': {
          runtime: 'nodejs',
          matchers: [
            { regexp: PAGE_MATCHER, originalSource: '/((?!api|_next|...).*)' },
            { regexp: TRPC_MATCHER, originalSource: '/api/trpc/:path*' },
          ],
        },
      },
    },
  };
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function writeTree(tree: ReturnType<typeof healthyTree>, { withEntries = true } = {}) {
  const distDir = mkdtempSync(path.join(tmpdir(), 'trpc-server-assumptions-'));
  dirs.push(distDir);
  mkdirSync(path.join(distDir, 'server', 'pages', 'api', 'trpc'), { recursive: true });
  writeFileSync(path.join(distDir, 'routes-manifest.json'), JSON.stringify(tree.routes));
  writeFileSync(path.join(distDir, 'server', 'pages-manifest.json'), JSON.stringify(tree.pages));
  writeFileSync(
    path.join(distDir, 'server', 'functions-config-manifest.json'),
    JSON.stringify(tree.functions)
  );
  if (withEntries) {
    writeFileSync(path.join(distDir, 'server', 'pages', 'api', 'trpc', '[trpc].js'), '');
    writeFileSync(path.join(distDir, 'server', 'middleware.js'), '');
  }
  return distDir;
}

const check =
  (distDir: string, config: Record<string, unknown> = nextConfig) =>
  () =>
    assertFastPathAssumptions({ distDir, nextConfig: config });

describe('assertFastPathAssumptions', () => {
  it('accepts a build shaped like ours (positive control)', () => {
    expect(check(writeTree(healthyTree()))).not.toThrow();
  });

  it('refuses compression, a basePath or trustHostHeader', () => {
    const dir = writeTree(healthyTree());
    expect(check(dir, { ...nextConfig, compress: true })).toThrow(/compress is not false/);
    expect(check(dir, { ...nextConfig, basePath: '/app' })).toThrow(/has a basePath/);
    expect(check(dir, { ...nextConfig, experimental: { trustHostHeader: true } })).toThrow(
      /trustHostHeader is on/
    );
  });

  it('refuses a redirect or rewrite that matches a tRPC path, with the locale prefix too', () => {
    const redirect = healthyTree();
    redirect.routes.redirects.push({
      source: '/:nextInternalLocale(en)/api/trpc/:path*',
      regex: '^(?:/(en))/api/trpc(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))?(?:/)?$',
      destination: '/elsewhere',
    });
    expect(check(writeTree(redirect))).toThrow(/a next.config redirect .* matches \/en\/api\/trpc/);

    const rewrite = healthyTree();
    rewrite.routes.rewrites.beforeFiles.push({
      source: '/api/trpc/:path*',
      regex: '^/api/trpc(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))?(?:/)?$',
      destination: '/api/other',
    });
    expect(check(writeTree(rewrite))).toThrow(/a next.config rewrite .* matches \/api\/trpc/);
  });

  it('refuses onMatchHeaders and domain locales, which it does not replicate', () => {
    const tree = healthyTree();
    (tree.routes.onMatchHeaders as unknown[]).push({ source: '/x', headers: [] });
    expect(check(writeTree(tree))).toThrow(/onMatchHeaders/);
    expect(
      check(writeTree(healthyTree()), {
        ...nextConfig,
        i18n: { ...nextConfig.i18n, domains: [{ domain: 'x.example', defaultLocale: 'en' }] },
      })
    ).toThrow(/domain locales/);
  });

  it('refuses a second page under /api/trpc', () => {
    const tree = healthyTree();
    (tree.pages as Record<string, string>)['/api/trpc/special'] = 'pages/api/trpc/special.js';
    expect(check(writeTree(tree))).toThrow(/the only page under \/api\/trpc/);
  });

  it('refuses a proxy whose matchers skip tRPC paths', () => {
    const tree = healthyTree();
    // Only the page matcher: it matches the BARE tRPC path by accident (its locale slot takes
    // `/api`), which is exactly the false pass the check must not fall for.
    tree.functions.functions['/_middleware'].matchers = [
      { regexp: PAGE_MATCHER, originalSource: '/((?!api|_next|...).*)' },
    ];
    expect(new RegExp(PAGE_MATCHER).test('/api/trpc/model.getById')).toBe(true);
    expect(check(writeTree(tree))).toThrow(/proxy's matchers do not match \/en\/api\/trpc/);
  });

  it('refuses a conditional proxy matcher for tRPC paths', () => {
    const tree = healthyTree();
    Object.assign(tree.functions.functions['/_middleware'].matchers[1], {
      has: [{ type: 'header', key: 'x-something' }],
    });
    expect(check(writeTree(tree))).toThrow(/is conditional/);
  });

  it('refuses a build missing the compiled route or proxy', () => {
    expect(check(writeTree(healthyTree(), { withEntries: false }))).toThrow(
      /missing server\/pages\/api\/trpc\/\[trpc\]\.js[\s\S]*missing server\/middleware\.js/
    );
  });
});
