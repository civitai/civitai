import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Structural guard: `src/pages/**` must contain NO test files.
 *
 * THE HAZARD, and why it is worth a dedicated guard: a test file placed in the
 * pages tree breaks the PRODUCTION BUILD while every correctness gate stays
 * green. The chain, each link read out of Next 16's own source:
 *
 *  1. `next.config.mjs` sets no `pageExtensions`, so Next's default
 *     `['tsx','ts','jsx','js']` applies.
 *  2. Route discovery collects pages with `createValidFileMatcher(...).isPageFile`
 *     (`next/dist/server/lib/find-page-file.js`), whose entire body is
 *     `validExtensionFileRegex.test(filePath)` — a bare extension test. There is
 *     no exclusion for `*.test.*`, for `__tests__/`, or for anything else. So
 *     `src/pages/api/auth/__tests__/callback.client-ip.test.ts` is enumerated as
 *     the API route `/api/auth/__tests__/callback.client-ip.test`.
 *  3. `next build` writes `.next/types/validator.ts`
 *     (`next/dist/server/lib/router-utils/typegen.js`), which emits, for every
 *     discovered `.ts`/`.tsx` route, a constraint check that the module satisfies
 *     `ApiRouteConfig` (pages-router API routes) or `PagesPageConfig` (pages-router
 *     pages). BOTH require a `default` export. A test file has none.
 *
 * The observed failure:
 *
 *     Failed to type check.
 *     .next/types/validator.ts:3026:31
 *     Type error: Type 'typeof import(".../callback.client-ip.test")' does not
 *       satisfy the constraint 'ApiRouteConfig'.
 *       Property 'default' is missing in type '...' but required in type 'ApiRouteConfig'.
 *
 * 🔴 WHY NO EXISTING GATE CATCHES IT. `tsconfig.json` EXCLUDES
 * `src/**\/__tests__/**`, so `node scripts/typecheck.mjs` never type-checks these
 * files — but the same tsconfig INCLUDES `.next/types/**\/*.ts`, and the generated
 * validator drags each excluded file back into the program via `typeof import(...)`.
 * The validator only exists AFTER `next build`, so the standalone Typecheck task is
 * structurally blind to this class: it is not that the check is weak, it is that
 * the file it would have to read has not been generated yet. Unit tests, ESLint and
 * Prettier are all likewise blind — the file is perfectly valid TypeScript. The
 * only gate that runs `next build` is the preview pipeline, which is why this
 * surfaces as "Typecheck green, preview build red".
 *
 * 🔴 WHY THE GUARD COVERS ALL OF `src/pages/**`, NOT JUST `src/pages/api/**`.
 * `isPageFile` does not distinguish the two, and `generateValidatorFile` applies
 * `PagesPageConfig` — which requires `default` exactly as `ApiRouteConfig` does —
 * to every discovered pages-router page. So a `.test.tsx` under a page directory
 * fails the build in the same way, just via a different constraint name. Narrowing
 * this to `api` would leave half the tree open for no reason.
 *
 * WHERE THESE TESTS BELONG INSTEAD: `src/__tests__/pages/**`, which mirrors the
 * route tree without being inside it. The `unit` project's include is
 * `src/**\/*.test.ts` (vitest.config.mts), so a suite there is collected exactly as
 * it was before; only Next's view of the tree changes.
 *
 * WHAT THIS FILE DOES NOT PIN, stated so a green run is not read as more than it
 * is: it is a filename/location check. It says nothing about whether the suites
 * under `src/__tests__/pages/**` are any good, and it cannot see a non-test helper
 * module parked in the pages tree that also lacks a `default` export (that is a
 * real but different hazard, and one the build reports against the file itself
 * rather than against a `__tests__` path nobody expects to be a route).
 */

/** `src/__tests__/pages` -> repo root. */
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PAGES_DIR = path.join(REPO_ROOT, 'src', 'pages');
const NEXT_CONFIG = path.join(REPO_ROOT, 'next.config.mjs');

/**
 * Next's DEFAULT `pageExtensions`. Every file under `pages/` ending in one of
 * these is enumerated as a route. The assumption that the default applies is not
 * left implicit — it is asserted against `next.config.mjs` below, so that adding a
 * `pageExtensions` setting fails this file rather than silently invalidating it.
 */
const ROUTE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'] as const;

/** `foo.test.ts`, `foo.spec.tsx`, `foo.test.mts`, … */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Any path segment that is a `__tests__` / `__mocks__` directory. */
const TEST_DIR = /(?:^|\/)__(?:tests|mocks)__(?:\/|$)/;

/**
 * Every file under `root` that Next would enumerate as a route, as a
 * forward-slash path relative to `root`.
 *
 * Extension-filtered rather than "everything", so the counts this returns are
 * comparable to Next's own discovery numbers and so the negative control below
 * can prove a `.md`/`.json` neighbour is not collected.
 */
function walkRouteFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && ROUTE_EXTENSIONS.some((ext) => entry.name.endsWith(`.${ext}`))) {
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** The route files that are test files — i.e. the ones that break `next build`. */
function offendingFiles(root: string): string[] {
  return walkRouteFiles(root).filter((rel) => TEST_FILE.test(rel) || TEST_DIR.test(rel));
}

const routeFiles = walkRouteFiles(PAGES_DIR);

describe('src/pages holds no test files', () => {
  // ---------------------------------------------------------------------
  // Instrument validation FIRST. The verdict below is a ZERO, and a zero from a
  // walk wired to the wrong root — or one that silently threw — is
  // indistinguishable from a zero that means "clean". So the walk gets a
  // positive control on the real tree, and the detector gets a positive AND a
  // negative control on a synthetic tree, before the verdict is read.
  // ---------------------------------------------------------------------
  it('POSITIVE CONTROL: the walk actually reaches src/pages and finds the real routes', () => {
    // Anchors that cannot move without the app ceasing to work, so this control
    // is not a filename that rots. `_app.tsx` proves the page half of the tree is
    // reached; `api/auth/callback.ts` proves the api half is, and is the very
    // directory the two relocated suites came out of.
    expect(routeFiles).toContain('_app.tsx');
    expect(routeFiles).toContain('_document.tsx');
    expect(routeFiles).toContain('api/auth/callback.ts');
    expect(routeFiles).toContain('api/mod/retool/comment.ts');

    // And it reaches them in BULK, not just the four named above — a walk that
    // recursed one level would satisfy the anchors alone. Deliberately loose
    // floors (real values at the time of writing: 296 api, 250 non-api) so this
    // fails on a broken walk, not on ordinary churn.
    const api = routeFiles.filter((rel) => rel.startsWith('api/'));
    const pages = routeFiles.filter((rel) => !rel.startsWith('api/'));
    expect(api.length).toBeGreaterThan(200);
    expect(pages.length).toBeGreaterThan(150);
  });

  it('POSITIVE + NEGATIVE CONTROL: the detector finds planted test files and nothing else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-tree-guard-'));
    try {
      const write = (rel: string, body = '// file\n') => {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
      };

      // POSITIVE: every shape the guard must catch. Each of these, placed under
      // src/pages, is enumerated as a route and fails `next build`.
      const hazards = [
        'api/auth/__tests__/callback.client-ip.test.ts', // the exact shape that broke the build
        'api/mod/retool/__tests__/comment.client-ip.test.ts',
        'api/thing.test.ts', // a test file NOT in a __tests__ dir
        'api/thing.spec.ts', // the `spec` spelling
        'models/[id].test.tsx', // a PAGE, not an api route -> PagesPageConfig
        'api/legacy.test.js', // the non-TS extensions Next still routes
        'api/legacy.spec.jsx',
        'api/deep/__tests__/helpers.ts', // no `.test.` in the name, but still in a test dir
        'api/__mocks__/redis.ts', // a mock module is a route too
      ].sort();
      for (const rel of hazards) write(rel);

      // NEGATIVE: real routes, and non-route neighbours, must NOT be reported.
      // Without this the check above would pass for a detector that flags
      // everything — which would be permanently red on the real tree.
      const innocents = [
        'api/auth/callback.ts',
        'api/health.ts',
        '_app.tsx',
        'models/[id].tsx',
        'api/contest.ts', // contains "test" as a SUBSTRING — must not match
        'api/latest.ts',
        'api/protests/index.ts', // "test" inside a directory name
      ];
      for (const rel of innocents) write(rel);
      // Non-route extensions in a test dir: Next never enumerates these, so
      // flagging them would be a false positive.
      write('api/__tests__/fixture.json', '{}\n');
      write('api/__tests__/notes.md', 'not a route\n');
      write('api/snapshot.test.snap', 'not a route\n');

      const found = offendingFiles(dir);
      expect(found).toEqual(hazards);

      // Spelled out in the other direction, so a failure names the culprit.
      for (const rel of innocents) expect(found).not.toContain(rel);
      expect(found).not.toContain('api/__tests__/fixture.json');
      expect(found).not.toContain('api/__tests__/notes.md');
      expect(found).not.toContain('api/snapshot.test.snap');

      // The walk itself must collect the innocents — otherwise `found` being
      // clean of them would prove nothing about the filter, only that the walk
      // never saw them.
      const walked = walkRouteFiles(dir);
      for (const rel of innocents) expect(walked).toContain(rel);
      expect(walked).not.toContain('api/__tests__/fixture.json');
      expect(walked).not.toContain('api/snapshot.test.snap');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CONTROL: the route-extension list still matches what Next will use', () => {
    // This guard's extension list is only correct while Next's DEFAULT
    // pageExtensions applies. If someone sets `pageExtensions` in next.config.mjs
    // — which is the other, wider-blast-radius way to fix this class — the list
    // above has to be revisited rather than silently kept.
    const config = fs.readFileSync(NEXT_CONFIG, 'utf8');
    expect(
      /(^|\n)\s*pageExtensions\s*:/.test(config),
      'next.config.mjs now sets `pageExtensions`. Next no longer uses its default ' +
        "['tsx','ts','jsx','js'], so ROUTE_EXTENSIONS in this file must be updated to match — " +
        'otherwise this guard silently stops covering whichever extensions were added.'
    ).toBe(false);
  });

  // ---------------------------------------------------------------------
  // The verdict.
  // ---------------------------------------------------------------------
  it('no test file lives under src/pages/**', () => {
    expect(
      offendingFiles(PAGES_DIR),
      'These files sit in the Next pages tree, so `next build` enumerates them as routes and ' +
        'then fails type-checking them against ApiRouteConfig/PagesPageConfig — both of which ' +
        'require a `default` export that a test file does not have. Typecheck, unit tests, ' +
        'ESLint and Prettier are ALL blind to this (the generated validator only exists after ' +
        'a build), so the break shows up as a red preview build with every other gate green. ' +
        'Move them to src/__tests__/pages/** — the `unit` project include is src/**/*.test.ts, ' +
        'so they stay collected — and import the handler as `~/pages/api/...`.'
    ).toEqual([]);
  });
});
