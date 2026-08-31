import { describe, expect, it } from 'vitest';
import { readdirSync, existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { MIGRATED_ROUTES, migratedRouteKey } from '~/shared/constants/migrated-moderator-routes';

/**
 * 🔴 SOURCE GATE — a preview smoke spec may not probe a `/moderator/*` path this app no longer serves.
 *
 * Redundant-looking, since the specs are tests already. It is not: they only run in
 * `preview / smoke-tests`, which is report-only, so #3573 left them failing on every PR for hours
 * with three merges going through. This fails on the machine of whoever performs the next migration.
 *
 * Route EXISTENCE only — a page that still resolves but stopped rendering its anchor is not covered,
 * and a path assembled from variables is invisible, so keep writing them literally.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');
const MODERATOR_PAGES = path.join(REPO_ROOT, 'src/pages/moderator');

/**
 * Wider than `playwright.preview.config.ts`'s `testMatch` on purpose: it also takes the `preview-*.ts`
 * helpers every spec imports, which are the natural home for a shared path constant.
 */
const PREVIEW_FILE = /^preview-.*\.ts$/;

/**
 * Opt-out for a probe that targets a migrated path on purpose. Must sit on the same line as the
 * literal, or it drifts off the thing it excuses.
 */
const DELIBERATE = '@migrated-route-probe';

/** Newlines preserved, or every reported line number is wrong. */
const stripBlockComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''));

/**
 * Not anchored to a quote, so `${PREVIEW_URL}/moderator/x` is seen; capture stops before `?`, so a
 * query string does not hide the whole literal.
 */
const PROBE = /\/moderator\/([a-zA-Z0-9\-_/]+)/g;

/** Drop a `//` line comment WITHOUT eating the `//` in `http://`. Same idiom as the writer ledger. */
const stripLineComment = (line: string) => line.replace(/(^|[^:])\/\/.*$/, '$1');

type Probe = { file: string; line: number; probePath: string; deliberate: boolean };

function previewFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) previewFiles(full, out);
    else if (PREVIEW_FILE.test(entry.name)) out.push(full);
  }
  return out.sort();
}

/** Lines carrying the marker alongside more than one probe — the marker cannot say which it means. */
const overloadedMarkers: string[] = [];

function probesIn(file: string): Probe[] {
  const found: Probe[] = [];
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  stripBlockComments(readFileSync(file, 'utf8'))
    .split('\n')
    .forEach((line, index) => {
      const marked = line.includes(DELIBERATE);
      const matches = [...stripLineComment(line).matchAll(PROBE)];
      if (marked && matches.length > 1) overloadedMarkers.push(`${rel}:${index + 1}`);
      for (const match of matches) {
        found.push({
          file: rel,
          line: index + 1,
          probePath: `/moderator/${match[1]}`,
          deliberate: marked && matches.length === 1,
        });
      }
    });
  return found;
}

/**
 * `[...slug].tsx` — the migration catchall — deliberately does not count as a page: answering every
 * path is what makes a stale probe look alive. A single dynamic segment (`[id].tsx`) does.
 */
function pageExists(sub: string): boolean {
  const segments = sub.split('/').filter(Boolean);
  if (!segments.length) return false;

  const dynamicIn = (dir: string, wantDir: boolean) => {
    if (!existsSync(dir)) return undefined;
    return readdirSync(dir).find((entry) => {
      const name = entry.replace(/\.tsx?$/, '');
      if (!name.startsWith('[') || name.startsWith('[...') || name.startsWith('[[')) return false;
      const isDir = statSync(path.join(dir, entry)).isDirectory();
      return wantDir ? isDir : !isDir && /\.tsx?$/.test(entry);
    });
  };

  let dir = MODERATOR_PAGES;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      const base = path.join(dir, segment);
      if (['.tsx', '.ts'].some((ext) => existsSync(base + ext))) return true;
      if (
        existsSync(base) &&
        statSync(base).isDirectory() &&
        ['index.tsx', 'index.ts'].some((f) => existsSync(path.join(base, f)))
      )
        return true;
      return dynamicIn(dir, false) !== undefined;
    }
    const next = path.join(dir, segment);
    if (existsSync(next) && statSync(next).isDirectory()) {
      dir = next;
      continue;
    }
    const dyn = dynamicIn(dir, true);
    if (!dyn) return false;
    dir = path.join(dir, dyn);
  }
  return false;
}

const files = previewFiles(TESTS_DIR);
const probes = files.flatMap(probesIn);
const enforced = probes.filter((p) => !p.deliberate);
const deliberate = probes.filter((p) => p.deliberate);

describe('preview smoke specs probe only moderator routes this app still serves', () => {
  /**
   * 🔴 Assert the ENFORCED partition, not the total: `it.each([])` registers zero tests and exits 0
   * (measured), so marking every line would empty both blocks below with nothing to show for it.
   */
  it('actually scanned the preview files, and something is still being enforced', () => {
    expect(files.map((f) => path.basename(f))).toEqual(
      expect.arrayContaining([
        'preview-moderation.spec.ts',
        'preview-auth-guard.spec.ts',
        'preview-auth.setup.ts',
      ])
    );
    expect(enforced.length).toBeGreaterThan(0);
  });

  // Pinned rather than counted: a marker appearing is the event that should need a reviewer.
  it('has exactly the deliberate migrated-route probes it is supposed to have', () => {
    expect(deliberate.map((p) => `${p.file}:${p.line} ${p.probePath}`).sort()).toEqual([
      'tests/preview-auth-guard.spec.ts:23 /moderator/reports',
      'tests/preview-moderation.spec.ts:98 /moderator/reports',
      'tests/preview-moderation.spec.ts:99 /moderator/images',
    ]);
  });

  it('never lets one marker excuse several paths on a line', () => {
    expect(
      overloadedMarkers,
      `A \`${DELIBERATE}\` line holds more than one /moderator path, so the marker cannot say which ` +
        'it excuses — and it would excuse all of them. Put the marked literal on its own line.'
    ).toEqual([]);
  });

  it.each(enforced)(
    '$file:$line $probePath has not migrated to the moderator app',
    ({ probePath }) => {
      const sub = probePath.slice('/moderator/'.length);
      const key = migratedRouteKey(sub);
      expect(
        key,
        `This path now 302s to ${
          MIGRATED_ROUTES[key ?? '']
        } on the standalone moderator app, so the probe measures a redirect rather than a page. ` +
          'Repoint it at a route that stayed, or mark the line ' +
          `\`${DELIBERATE}\` if asserting the hop IS the point.`
      ).toBeUndefined();
    }
  );

  it.each(enforced)('$file:$line $probePath resolves to a page in this app', ({ probePath }) => {
    const sub = probePath.slice('/moderator/'.length);
    expect(
      pageExists(sub),
      'No page under src/pages/moderator/ serves this path, so the catchall answers it. A probe ' +
        'against a deleted page fails in preview smoke, where nothing blocks on it.'
    ).toBe(true);
  });

  it.each(deliberate)(
    '$file:$line $probePath is marked deliberate and really has migrated',
    ({ probePath }) => {
      // The marker rots too: a path that comes BACK leaves a spec asserting a redirect that is gone.
      const sub = probePath.slice('/moderator/'.length);
      expect(
        migratedRouteKey(sub),
        `Marked \`${DELIBERATE}\` but this path is not in MIGRATED_ROUTES, so there is no hop to ` +
          'assert. Drop the marker.'
      ).toBeDefined();
    }
  );
});
