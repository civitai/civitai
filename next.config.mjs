// @ts-check
import { withAxiom } from '@civitai/next-axiom';
import bundlAnalyzer from '@next/bundle-analyzer';
import CircularDependencyPlugin from 'circular-dependency-plugin';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const packageJson = require('./package.json');

const isProd = process.env.NODE_ENV === 'production';
const isDev = process.env.NODE_ENV === 'development';
const analyze = process.env.ANALYZE === 'true';
const includeCircularDependencyPlugin = process.env.CIRCULAR_DEPENDENCY_PLUGIN === 'true';

const withBundleAnalyzer = bundlAnalyzer({
  enabled: analyze,
});

/**
 * Runtime files of every installed `@swc/helpers`, force-included into the standalone output.
 *
 * WHY. `output: 'standalone'` ships the subset @vercel/nft traced, not `node_modules`. nft
 * resolves a bare specifier under the `require`/`default` conditions; Node (>= 22.10)
 * additionally honours `module-sync` for a CJS `require`. When a package's `exports` map points
 * those two at different files, the build traces one and the running process asks for the other.
 *
 * Next's own `dist/shared/lib/constants.js` does
 * `require('@swc/helpers/_/_interop_require_default')`, reached from the generated `server.js`
 * via `next` -> `config.js` -> `constants.js` — i.e. before any application code. On
 * @swc/helpers 0.5.15 (next 16.3.0) that subpath exported only `{ import, default }` and both
 * resolvers landed on `cjs/_interop_require_default.cjs`. 0.5.17+ added `module-sync` ->
 * `esm/_interop_require_default.js`, and next 16.3.1 bumped its dependency to 0.5.23 — so the
 * image shipped `cjs/` only and every pod crash-looped on
 * `MODULE_NOT_FOUND .../@swc/helpers/esm/_interop_require_default.js` (civitai#4075) with the
 * build, the unit suite, typecheck, ESLint and the compiled-branch gate all green.
 *
 * BOTH condition branches of EVERY copy, not the one file missing today: which helper Next
 * requires, and which branch each resolver picks, are upstream details that move. ~950 KB per
 * copy (426 files across the two copies installed today). Version- and hash-agnostic globs —
 * `@swc+helpers@*` covers whatever the next bump resolves to, and the flat form covers a hoisted
 * (non-pnpm) layout. A non-matching glob is a silent no-op, which is exactly why this is NOT the
 * guard: the guard is
 * `scripts/ci/assert-standalone-boot-graph.mjs`, run against the runtime filesystem in the
 * Dockerfile's runner stage, which fails the build if this ever stops landing the files.
 *
 * ATTACHED TO EXISTING ROUTE KEYS ON PURPOSE. This is a process-wide boot dependency, not a
 * route's, and `copyTracedFiles` unions every entry's traced set into the single
 * `.next/standalone` node_modules — so any one entry carrying it is enough. A `'**'` key does
 * match every route (keys are picomatch'd with `contains: true`), but it would make all 572
 * entries read/parse/rewrite their `.nft.json` concurrently — 826 MB of JSON in one
 * `Promise.all` — on a build already tuned against OOM. These keys are API routes: always
 * present, never statically prerendered (an entry in `staticPages` has its includes skipped),
 * and already include-keyed, so they cost no additional entry. Three of them for redundancy: if
 * one route is ever renamed or removed the files still ship, and if all three go the boot gate
 * turns the build red rather than letting a broken image out.
 */
const swcHelpersRuntimeFiles = [
  './node_modules/@swc/helpers/esm/**/*',
  './node_modules/@swc/helpers/cjs/**/*',
  './node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/esm/**/*',
  './node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/cjs/**/*',
];

/**
 * Don't be scared of the generics here.
 * All they do is to give us autocompletion when using this.
 *
 * @template {import('next').NextConfig} T
 * @param {T} config - A generic parameter that flows through to the return type
 * @constraint {{import('next').NextConfig}}
 */
function defineNextConfig(config) {
  return withBundleAnalyzer(config);
}

export default defineNextConfig(
  withAxiom({
    env: {
      version: packageJson.version,
      // The client login helpers need the hub origin. Reuse AUTH_JWT_ISSUER (the server's single hub-URL source)
      // by exposing it to the client bundle as NEXT_PUBLIC_AUTH_HUB_URL — so there's no separate var to set. An
      // explicit NEXT_PUBLIC_AUTH_HUB_URL still wins if provided. (AUTH_JWT_ISSUER is public: the JWT `iss` /
      // JWKS origin.)
      NEXT_PUBLIC_AUTH_HUB_URL: process.env.NEXT_PUBLIC_AUTH_HUB_URL ?? process.env.AUTH_JWT_ISSUER,
    },
    // webpack: (config, options) => {
    //   if (isDev && !options.isServer) {
    //     config.plugins.push(
    //       new CircularDependencyPlugin({
    //         exclude: /node_modules|\.d\.ts/, // Ignore types and external modules
    //         failOnError: true, // Fail build on cycle
    //         allowAsyncCycles: false, // Disallow lazy cycles (recommended)
    //         cwd: process.cwd(), // Base path for clearer output
    //         // `onStart` is called before the cycle detection starts
    //         // onStart({ compilation }) {
    //         //   console.log('start detecting webpack modules cycles');
    //         // },
    //         // `onDetected` is called for each module that is cyclical
    //         onDetected({ module: webpackModuleRecord, paths, compilation }) {
    //           // `paths` will be an Array of the relative module paths that make up the cycle
    //           // `module` will be the module record generated by webpack that caused the cycle
    //           compilation.errors.push(new Error(paths.join(' -> ')));
    //         },
    //         // `onEnd` is called before the cycle detection ends
    //         // onEnd({ compilation }) {
    //         //   console.log('end detecting webpack modules cycles');
    //         // },
    //       })
    //     );
    //   }

    //   return config;
    // },
    // Turbopack is the default bundler as of Next 16. The OpenTelemetry packages
    // that produced the `require-in-the-middle` webpack warnings are listed in
    // `serverExternalPackages` below, so Turbopack externalizes them and never
    // emits those warnings — an empty config just acknowledges we're on Turbopack
    // and silences Next's "webpack config with no turbopack config" build error.
    // root spans C:work so the pnpm link: to the local form-graph checkout is
    // inside Turbopack's readable tree (it refuses files outside the root)
    turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
    // Per-branch build dir. Turbopack's dev filesystem cache (~8GB) is invalidated
    // wholesale by an in-place branch switch, so the dev daemon points each branch at
    // its own dir and keeps them warm instead of purging. Unset -> stock `.next`.
    distDir: process.env.NEXT_DIST_DIR || '.next',
    allowedDevOrigins: ['civitai-dev.green', 'civitai-dev.blue', 'civitai-dev.red'],
    // Retained for the `next build --webpack` fallback path; ignored under Turbopack.
    webpack: (config) => {
      config.ignoreWarnings = [
        { module: /require-in-the-middle/ },
        { module: /@opentelemetry\/instrumentation/ },
      ];
      return config;
    },
    reactStrictMode: true,
    // Source maps for prod CPU-profile de-minification.
    //
    // Under Turbopack (our prod bundler, Next 16), the ONLY source-map lever is the
    // experimental `turbopackSourceMaps` flag, whose build-time default IS
    // `productionBrowserSourceMaps`. So setting this `true` turns on map emission for
    // BOTH client (`.next/static/**/*.js.map`) and server (`.next/server/**/*.js.map`)
    // chunks. Turbopack ignores `experimental.serverSourceMaps` (webpack-only) — that
    // flag below only matters for the `next build --webpack` fallback path.
    //
    // Maps are inert at runtime: the Node server never loads a `.js.map` unless an
    // inspector / error-stack resolver reads it, so there is NO
    //  request-path perf cost.
    // They are NOT served to browsers for server chunks (those live in `.next/server`,
    // which is not a static-served directory). Cost is build time + image size only.
    //
    // IMPORTANT: `output:'standalone'` traces required files via @vercel/nft, which
    // follows `import`/`require`/`fs` — it does NOT trace sibling `.js.map` files, so
    // the server maps are emitted to `.next/server` but DROPPED from `.next/standalone`.
    // The runtime image does NOT ship these maps (the RUNNER stage copies only
    // standalone + static). The build instead publishes them as a separate
    // `civitai-web-maps:<tag>` artifact (Dockerfile `maps` target + the pipeline),
    // fetched on demand by `scripts/resolve-cpuprofile.mjs --image <tag>` to
    // de-minify a captured profile — keeping the runtime image lean.
    productionBrowserSourceMaps: true,
    // Next.js i18n docs: https://nextjs.org/docs/advanced-features/i18n-routing
    i18n: {
      locales: ['en'],
      defaultLocale: 'en',
    },
    generateEtags: false,
    compress: false,
    images: {
      remotePatterns: [
        { hostname: 's3.us-west-1.wasabisys.com' },
        { hostname: 'model-share.s3.us-west-1.wasabisys.com' },
        { hostname: 'civitai-prod.s3.us-west-1.wasabisys.com' },
        { hostname: 'civitai-dev.s3.us-west-1.wasabisys.com' },
        { hostname: 'image.civitai.com' },
      ],
      // domains: [
      //   's3.us-west-1.wasabisys.com',
      //   'model-share.s3.us-west-1.wasabisys.com',
      //   'civitai-prod.s3.us-west-1.wasabisys.com',
      //   'civitai-dev.s3.us-west-1.wasabisys.com',
      //   'image.civitai.com',
      // ],
    },
    compiler:
      process.env.NODE_ENV === 'production'
        ? {
            reactRemoveProperties: { properties: ['^data-testid$'] },
            // removeConsole: true,
          }
        : {},
    transpilePackages: [
      // pnpm link: to the local checkout during the data-graph port — Turbopack
      // won't resolve the out-of-root symlink without transpiling it
      'form-graph',
      'superjson',
      '@civitai/db-schema',
      '@civitai/db',
      '@civitai/db-queries',
      '@civitai/shared',
      '@civitai/buzz',
      '@civitai/redis',
      '@civitai/clickhouse',
      '@civitai/axiom',
      '@civitai/flipt',
      '@civitai/telemetry',
      '@civitai/auth',
      '@civitai/notifications',
      '@civitai/moderation',
    ],
    // Renamed from experimental.serverComponentsExternalPackages → top-level serverExternalPackages in Next 15
    serverExternalPackages: [
      'redis',
      '@redis/client',
      '@redis/bloom',
      '@redis/json',
      '@redis/search',
      '@redis/time-series',
      '@opentelemetry/sdk-node',
      '@opentelemetry/instrumentation',
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-redis',
      '@prisma/instrumentation',
      // Bundling this gives the app layer its own copy of the Prisma runtime while
      // `dbRead`/`dbWrite` (reached through the transpiled `@civitai/db-schema`) hold a
      // second one. `$queryRaw` identifies its template argument with `instanceof Sql`,
      // so a `Prisma.join()` built by the other copy fails that check and is bound as a
      // plain value -> `operator does not exist: integer = jsonb`.
      '@prisma/client',
      // NOTE: the logs-pipeline packages (@opentelemetry/api, /api-logs, /sdk-logs,
      // /exporter-logs-otlp-proto) are deliberately NOT externalized here. Adding them
      // fails the image build, so it needs to be its own change with a full build as its
      // gate. The logs bridge does not depend on it: it binds to the Logs API lazily, so
      // a second bundled module copy is survivable, and `no_provider` on its skip counter
      // is the runtime signal if one ever appears.
      '@pyroscope/nodejs',
      '@datadog/pprof',
    ],
    // Several entry points read markdown from src/static-content at runtime via fs
    // (dynamic string paths that @vercel/nft can't trace). With output:'standalone'
    // the build only ships traced files, so without these explicit includes the
    // markdown is missing in the deployed image and every read hits ENOENT ->
    // 500/404 (works locally because the full source tree is present). Top-level as
    // of Next 15 (lived under `experimental` on Next 14). Keyed by each read site.
    outputFileTracingIncludes: {
      '/safety': ['./src/static-content/**/*'],
      '/region-blocked': ['./src/static-content/**/*'],
      '/content/[[...slug]]': ['./src/static-content/**/*'],
      '/api/trpc/[trpc]': ['./src/static-content/**/*', ...swcHelpersRuntimeFiles],
      '/api/v1/content/[[...slug]]': ['./src/static-content/**/*', ...swcHelpersRuntimeFiles],
      // /api/og uses next/og's `ImageResponse`, which on the nodejs runtime
      // lazily require()s `next/dist/compiled/@vercel/og/index.node.js` (plus its
      // resvg/yoga WASM + fonts). @vercel/nft cannot follow that dynamic require,
      // so with output:'standalone' the file is DROPPED from the image and every
      // origin (cache-miss) /api/og render throws `Cannot find module ...
      // index.node.js` -> 500. This became the dominant app-500 source (~1.9/s)
      // after the Next 16.2.7 upgrade; Cloudflare edge-caching of OG images masks
      // it for popular entities. Force-include the whole compiled @vercel/og dir
      // (entry + WASM + fonts) for this route. Two version-agnostic globs (no
      // hardcoded next@<hash>): the symlinked path, plus the real pnpm path with a
      // `next@*` wildcard in case globby doesn't follow the node_modules/next
      // symlink. Whichever matches copies the files; a non-matching glob is a no-op.
      '/api/og': [
        './node_modules/next/dist/compiled/@vercel/og/**/*',
        './node_modules/.pnpm/next@*/node_modules/next/dist/compiled/@vercel/og/**/*',
        ...swcHelpersRuntimeFiles,
      ],
    },
    experimental: {
      // scrollRestoration: true,
      cpus: 8,
      serverSourceMaps: true,
      // instrumentationHook removed in Next 15 — instrumentation.ts is enabled by default now
      largePageDataBytes: 512 * 100000,
      // Nested async chunking for the SERVER build. Next's own defaults table
      // (node_modules/next/dist/docs/01-app/03-api-reference/08-turbopack.md) has
      // `turbopackClientSideNestedAsyncChunking` defaulting to TRUE in build mode but
      // `turbopackServerSideNestedAsyncChunking` defaulting to FALSE in *both* dev and
      // build — so the server build never got the async-chunk dedup the client build has,
      // and every async chunk group re-emits its whole module graph.
      //
      // Trade: ~72% fewer emitted server chunks and roughly half the server chunk bytes,
      // in exchange for ~+8% CI build time and ~+33% peak builder RSS. Measurements live
      // in the PR rather than here, so they don't rot when Next's chunker changes.
      //
      // Off because the builder's memory ceiling is now enforced and that ~+33% peak RSS is
      // what puts the release build over it. Re-enable only with a measured peak-RSS margin.
      //
      // SECOND REASON THIS FLAG MATTERS, and the reason to revisit it: the emitted server
      // chunk COUNT is what drives the intermittent `Two or more assets with different
      // content were emitted to the same output path` build failure. Turbopack names a
      // server chunk `<namespace>_<7-char-hash>._.js`, and that hash's first character is
      // bounded in practice to {0,1,2} — so the usable space is ~2 x 38^6, not 38^7, and
      // the failure is an ordinary birthday collision between two UNRELATED chunks. It is
      // deterministic for a given module graph (so a rebuild of the same commit fails
      // again), and it moves to a different pair whenever the graph changes at all — which
      // is why bisecting finds a commit but never a responsible file.
      //
      // Turning this flag ON is the only lever here that attacks the mechanism, because
      // P(collision) grows with the SQUARE of the chunk count. Measured on one tree:
      // 24,552 server chunks with the flag off vs 7,122 with it on (-71%).
      // 🔴 DO NOT FLIP IT ANYWAY — measured on 16.3.1, it does not fit the builder's
      // memory ceiling. Two blockers were on record here. The first cleared: the flag is
      // BROKEN on Next 16.3.0 (19 `__turbopack_context__.a is not a function` PostCSS
      // errors) and compiles from 16.3.1 onward, which the repo is now on. The second
      // closed the option: a same-commit A/B on 16.3.1 measured +43.0% peak `next-build`
      // RSS / +30.3% build-container peak — LARGER than the ~+33% quoted above, not
      // smaller. Projected onto the worst observed production build that lands at
      // 37-39 GiB against the enforced 40 GiB limit, which is the exact band where the
      // release build OOMKilled three times when this flag was last on (#3807).
      // Dropping source maps to pay for it is also closed: it works, but server `.js.map`
      // has three consumers including the hard `scripts/assert-compiled-branches.mjs`
      // gate, and `turbopackSourceMaps` cannot be split client/server.
      // Full evidence: claudedocs/turbopack-chunk-hash-collision-2026-08-18.md
      // (§Option 1 is closed). The live fix is upstream, not this flag.
      turbopackServerSideNestedAsyncChunking: false,
      // Not the same as omitting it: Next 16.3.0 defaults this to true, and turbopack-build
      // derives `dependencyTracking` from it, so the flag governs what turbo-tasks retains in
      // memory and not just what lands on disk.
      turbopackFileSystemCacheForBuild: false,
      // NB: `lodash-es`, `@tabler/icons-react` and `@headlessui/react` are already in Next's
      // built-in default list (config.js merges ours into it) — kept here only as intent.
      //
      // 🔴 Do NOT add a package that creates React context — `@mantine/core`, `@mantine/modals`,
      // `@mantine/notifications`. This rewrites barrel imports into deep per-component imports,
      // which can put the provider and its consumers on DIFFERENT module instances: the provider
      // is in the tree, but consumers read a context object created by another copy. Adding
      // `@mantine/core` here 500'd every Mantine-heavy route in preview with "MantineProvider was
      // not found in component tree" (PR #3802). Nothing local catches it — typecheck, lint and
      // both vitest projects stayed green; only a real build renders the provider.
      optimizePackageImports: [
        '@civitai/client',
        './src/libs/form',
        'lodash-es',
        '@tabler/icons-react',
        '@headlessui/react',
      ],
    },
    headers: async () => {
      // Add X-Robots-Tag header to all pages matching /sitemap.xml and /sitemap-models.xml /sitemap-articles.xml, etc
      const headers = [
        {
          source: '/sitemap(-\\w+)?.xml',
          headers: [
            { key: 'X-Robots-Tag', value: 'noindex' },
            { key: 'Content-Type', value: 'application/xml' },
            { key: 'Cache-Control', value: 'public, max-age=86400, must-revalidate' },
          ],
        },
      ];

      if (process.env.NODE_ENV !== 'production') {
        headers.push({
          source: '/:path*',
          headers: [
            {
              key: 'X-Robots-Tag',
              value: 'noindex',
            },
          ],
        });
      }

      // Allow Kinguin checkout iframe on gift cards page - NO X-Frame-Options header
      // Minimal CSP that only restricts frame-src to allow Kinguin
      headers.push({
        source: '/gift-cards',
        headers: [
          {
            key: 'Content-Security-Policy',
            value:
              "frame-src 'self' https://www.kinguin.net https://sandbox.kinguin.net https://gateway.kinguin.net https://*.kinguin.net;",
          },
          // NOTE: Intentionally NO X-Frame-Options header as per Kinguin's documentation
          // NOTE: Only setting frame-src, letting other resources use browser defaults
        ],
      });

      // Apply X-Frame-Options to all pages EXCEPT gift-cards
      headers.push({
        source: '/((?!gift-cards).*)',
        headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
      });

      return headers;
    },
    poweredByHeader: false,
    redirects: async () => {
      // Note: the .red-host support-portal bounce is implemented as a
      // Cloudflare Redirect Rule on the civitai.red zone. Config lives at
      // ops/cloudflare/civitai-red-redirects.json. A host-conditional rule
      // here would be pruned to nothing at build time anyway since
      // SERVER_DOMAIN_* env vars aren't exposed as Docker build ARGs.
      return [
        {
          // `/apps/my-submissions` merged into `/apps/mine` — one author table over every
          // app you own or hold a seat on, with each app's submission history nested in
          // its row. The page component is DELETED, not emptied: a stub whose only job is
          // to redirect is dead code that reads as a live route.
          //
          // 🔴 `statusCode: 301`, not `permanent: true`. Next maps `permanent` to **308**,
          // which preserves the request METHOD — correct in general, but this is a GET-only
          // author page whose inbound links are bookmarks, notification URLs and search
          // results, and 301 is the status those consumers cache and rewrite on. The two
          // options are mutually exclusive in Next's schema, so this is `statusCode` alone.
          source: '/apps/my-submissions',
          destination: '/apps/mine',
          statusCode: 301,
        },
        {
          source: '/api/download/training-data/:modelVersionId',
          destination: '/api/download/models/:modelVersionId?type=Training%20Data',
          permanent: true,
        },
        {
          source: '/github/:path*',
          destination: 'https://github.com/civitai/civitai/:path*',
          permanent: true,
        },
        {
          source: '/discord',
          destination: 'https://discord.gg/civitai',
          permanent: true,
        },
        {
          source: '/twitter',
          destination: 'https://twitter.com/HelloCivitai',
          permanent: true,
        },
        {
          source: '/reddit',
          destination: 'https://reddit.com/r/civitai',
          permanent: true,
        },
        {
          source: '/instagram',
          destination: 'https://www.instagram.com/hellocivitai/',
          permanent: true,
        },
        {
          source: '/tiktok',
          destination: 'https://www.tiktok.com/@hellocivitai',
          permanent: true,
        },
        {
          source: '/youtube',
          destination: 'https://www.youtube.com/@civitai',
          permanent: true,
        },
        {
          source: '/twitch',
          destination: 'https://www.twitch.tv/civitai',
          permanent: true,
        },
        {
          source: '/ideas',
          destination: 'https://github.com/civitai/civitai/discussions/categories/ideas',
          permanent: true,
        },
        {
          source: '/v/civitai-link-intro',
          destination: 'https://youtu.be/EHUjiDgh-MI',
          permanent: false,
        },
        {
          source: '/v/civitai-link-installation',
          destination: 'https://youtu.be/fs-Zs-fvxb0',
          permanent: false,
        },
        {
          source: '/v/ally-parting-message',
          destination: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          permanent: false,
        },
        {
          source: '/gallery/:path*',
          destination: '/images/:path*',
          permanent: true,
        },
        {
          source: '/canny/bugs',
          destination:
            'https://civitai-team.myfreshworks.com/login/auth/civitai?client_id=451979510707337272&redirect_uri=https%3A%2F%2Fcivitai.freshdesk.com%2Ffreshid%2Fcustomer_authorize_callback%3Fhd%3Dsupport.civitai.com',
          permanent: true,
        },
        {
          source: '/bugs',
          destination:
            'https://civitai-team.myfreshworks.com/login/auth/civitai?client_id=451979510707337272&redirect_uri=https%3A%2F%2Fcivitai.freshdesk.com%2Ffreshid%2Fcustomer_authorize_callback%3Fhd%3Dsupport.civitai.com',
          permanent: true,
        },
        {
          source: '/support-portal',
          destination:
            'https://civitai-team.myfreshworks.com/login/auth/civitai?client_id=451979510707337272&redirect_uri=https%3A%2F%2Fcivitai.freshdesk.com%2Ffreshid%2Fcustomer_authorize_callback%3Fhd%3Dsupport.civitai.com',
          permanent: true,
        },
        {
          source: '/leaderboard',
          destination: '/leaderboard/overall',
          permanent: true,
        },
        {
          source: '/forms/bounty-refund',
          destination: 'https://forms.clickup.com/8459928/f/825mr-8331/R30FGV9JFHLF527GGN',
          permanent: true,
        },
        {
          source: '/air/confirm',
          destination: '/studio/confirm',
          permanent: true,
        },
        {
          source: '/education',
          destination: 'https://education.civitai.com',
          permanent: true,
        },
        {
          source: '/cosmetic-shop',
          destination: '/shop',
          permanent: true,
        },
        {
          source: '/shop/cosmetic-shop',
          destination: '/shop',
          permanent: true,
        },
        {
          source: '/projectodyssey_season2',
          destination: '/collections/6503138',
          permanent: true,
        },
        {
          source: '/creators-program',
          destination: '/creator-program',
          permanent: true,
        },
        {
          source: '/research/rater',
          destination: '/games/knights-of-new-order',
          permanent: true,
        },
        {
          // Reserved-name redirect: the legacy 'civitai' user account moved to
          // 'CivitaiOfficial'. Handled here (not in middleware) so it runs at
          // framework/edge level before any middleware, with no JS execution
          // per request.
          source: '/user/civitai',
          destination: '/user/CivitaiOfficial',
          permanent: true,
        },
      ];
    },
    output: 'standalone',
  })
);
