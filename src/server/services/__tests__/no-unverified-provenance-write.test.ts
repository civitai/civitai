import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Convention guard: nothing writes `Image.meta` without stripping provenance.
 *
 * `meta.extra.sourceImageIds` is the one field in that blob a viewer is asked to
 * trust, and every write path takes client-authored meta. The protection is a
 * `sanitizeProvenance` call at each sink, which is exactly the kind of thing a
 * later edit drops silently — the unit tests around the function itself would
 * all still pass. So the wiring is pinned here instead.
 *
 * If this fails because you added a sink: call `sanitizeProvenance` in it, or add
 * it to `DERIVED_FROM_ROW` with a note saying why its meta can't carry a claim.
 */

const SRC = path.resolve(__dirname, '../../..');

/** Write sites whose meta is read back off the row rather than supplied by a caller. */
const DERIVED_FROM_ROW = [
  // image.service.ts `updateImageResources`-style rewrite: spreads the stored
  // meta and replaces `resources`, so no new claim can enter.
  'meta: { ...meta, resources: metaResources }',
];

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

/**
 * A prisma image write that sets `meta`. Matched by text rather than by parsing:
 * the point is to notice a NEW sink, and a crude matcher that over-reports is the
 * right failure direction.
 */
const WRITE_SITE =
  /\bimage\.(?:create(?:Many(?:AndReturn)?)?|update(?:Many)?|upsert)\s*\(|\bconnectOrCreate\s*:|\$(?:execute|query)(?:Raw|RawUnsafe)[\s\S]{0,300}?(?:UPDATE|INSERT INTO)\s+"Image"/gi;
const FUNCTION_START =
  /\n(?:export )?(?:async )?function |\n(?:export )?const \w+ = |\n {2}\w+\s*\(/g;
const AFTER = 1200;

/**
 * How many sinks the scan is expected to find at all — the count, not just
 * "at least one", because a pattern that silently stops matching a whole SHAPE
 * (nested writes, raw SQL) leaves a guard that passes by seeing nothing.
 *
 * Set below the current count on purpose. If you legitimately REMOVE a sink —
 * folding two write paths into one — lower this deliberately; it is a floor on
 * the scan's reach, not a census.
 */
const MIN_KNOWN_SINKS = 6;

/**
 * From the top of the enclosing function to a bit past the write. The sanitize
 * usually runs a few lines ABOVE the call — assigned to a local that the write
 * then uses — so a window that only looks forward reports every real sink.
 */
function scopeAround(source: string, at: number) {
  let start = 0;
  for (const boundary of source.matchAll(FUNCTION_START)) {
    if (boundary.index >= at) break;
    start = boundary.index;
  }
  return source.slice(start, at + AFTER);
}

/**
 * Blanks commented-out lines, keeping length so reported line numbers stay true.
 * A commented sink is not a sink — the repo has a dead raw-SQL `UPDATE "Image"`
 * that the scan would otherwise report forever.
 */
function withoutCommentedCode(source: string) {
  return source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');
}

/** Every `Image.meta` write the scan can see, sanitized or not. */
function findWriteSites() {
  const sites: { at: string; sanitized: boolean }[] = [];

  // `src/pages` as well as `src/server`: several image writes live under the API
  // routes. None sets `meta` today, and a guard that never looks there would not
  // notice the first one that does.
  for (const root of ['server', 'pages']) {
    for (const file of walk(path.join(SRC, root))) {
      const source = withoutCommentedCode(fs.readFileSync(file, 'utf8'));
      for (const match of source.matchAll(WRITE_SITE)) {
        // `meta: true` is a SELECT, not a write — it shows up in the `select`
        // block of the query that follows an unrelated raw UPDATE.
        if (!/\bmeta\s*[:=](?!\s*true\b)/.test(source.slice(match.index, match.index + AFTER)))
          continue;

        const window = scopeAround(source, match.index);
        const line = source.slice(0, match.index).split('\n').length;
        sites.push({
          at: `${path.relative(SRC, file).replace(/\\/g, '/')}:${line}`,
          sanitized:
            /sanitizeProvenance/.test(window) ||
            DERIVED_FROM_ROW.some((allowed) => window.includes(allowed)),
        });
      }
    }
  }

  return sites;
}

describe('Image.meta writes cannot carry an unverified provenance claim', () => {
  it('every write site that sets meta strips the claim first', () => {
    expect(
      findWriteSites()
        .filter((site) => !site.sanitized)
        .map((site) => site.at)
    ).toEqual([]);
  });

  it('still sees every shape of sink it covers (positive control)', () => {
    const sites = findWriteSites();

    // A count, not an existence check. The first version of this guard passed
    // while blind to the nested `connectOrCreate` sink that the same commit had
    // just fixed: one known site was enough to satisfy it. If this drops, the
    // pattern has stopped matching a whole shape.
    expect(sites.length).toBeGreaterThanOrEqual(MIN_KNOWN_SINKS);
    expect(sites.map((site) => site.at)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('services/image.service.ts'),
        expect.stringContaining('services/post.service.ts'),
        // Nested creates under another model — the shape the first version of
        // this scan was blind to, which is how the collection cover-image sink
        // went unnoticed by two review passes.
        expect.stringContaining('services/user-profile.service.ts'),
        expect.stringContaining('services/collection.service.ts'),
      ])
    );
  });
});
