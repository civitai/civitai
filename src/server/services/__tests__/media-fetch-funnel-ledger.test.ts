import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SEAM guard over the modules that consume `image-scan-url`'s guard identifiers.
 *
 * 🔴 READ WHAT THIS DOES AND DOES NOT ASSERT — an earlier docblock called it "the LEDGER of
 * every module that turns a caller-supplied string into a URL something will fetch" and said
 * it "fails when a new funnel appears un-gated". BOTH WERE FALSE, and false in the direction
 * that stops people looking. What it actually asserts is narrower on three axes:
 *
 *  1. **Guard CONSUMERS, not funnels.** The set it pins is "files whose text contains one of
 *     `GUARD_TOKENS`". A new funnel that never mentions those identifiers is INVISIBLE to it,
 *     so the set GROWING is not the event "a funnel appeared" — it is "a file mentioned the
 *     guard". An ungated new funnel does not grow the set at all.
 *  2. **A REFERENCE, not a call.** A file satisfies its row by carrying an `import`. Measured:
 *     deleting the badge guard's call while keeping its import leaves this suite GREEN and
 *     only the behavioural suite red. The behavioural suites are the real gate.
 *  3. **This guard family only.** `training.service.ts` is the fourth funnel in this PR and is
 *     deliberately NOT in the ledger, because it is guarded by `isPublicHttpsUrl` — a
 *     different identifier. Deleting `assertSafeMediaUrls` outright reddens no row here.
 *
 * 🔴 KNOWN UN-LEDGERED SERVER-SIDE FETCHES OF A CALLER-INFLUENCED URL, recorded so this file
 * cannot be read as an exhaustive inventory of the hazard class:
 *  - `src/server/utils/og-image-helpers.ts` — `fetch()` on a `getEdgeUrl(image.url, …)`,
 *    reached from the public `src/pages/api/og.tsx`. Whether every `Image.url` reaching it can
 *    be attacker-chosen is NOT established.
 *  - `src/server/services/chat.service.ts` — `unfurl(href)` on a URL parsed out of a user's
 *    chat message; `src/server/utils/safe-fetch.ts` names `unfurl.js` as unguarded.
 * Neither is in scope for this change. They are listed because a guard whose description is
 * wider than its body is worse than no guard.
 *
 * Why a seam guard at all: each funnel's own suite passes in ISOLATION, and that is exactly
 * how this class survived — `createImageIngestionRequest` was gated and audit-clean while
 * three siblings built the same fetchable URL the same way and were not, because no test was
 * scoped to the RELATIONSHIP.
 */

const SRC = join(__dirname, '..', '..', '..');

/** Every non-test .ts/.tsx under src/, as [repoRelativePath, contents]. */
function sourceFiles(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      // 🔴 Skip test files BY NAME, not only by `__tests__` directory. Measured: 179
      // `*.test.ts` files in this repo live OUTSIDE a `__tests__` dir, so a new suite at the
      // ordinary spelling `src/server/utils/image-scan-url.test.ts` would have joined the
      // guard-consumer set and reddened the set-equality row for no defect at all.
      if (/\.(test|spec|browser\.test)\.tsx?$/.test(entry)) continue;
      // Posix separators: every comparison below is written with `/`, so on Windows
      // `relative()`'s backslashes matched none of them and 12 of this file's 13 rows failed —
      // red for everyone locally, which masks a real failure instead of showing one. Same bug
      // the ad-SDK callback guard had.
      out.push([relative(SRC, full).split(sep).join('/'), readFileSync(full, 'utf8')]);
    }
  };
  walk(SRC);
  return out;
}

/** Drop `//` line comments so a comment that QUOTES a banned shape is not a match. */
const stripLineComments = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n');

const GUARD_TOKENS = /isAllowedImageScanUrl|isAllowedAvatarUrl|ImageIngestionUrlBlockedError/;

/**
 * The ledger. Each entry is a module that hands a caller-influenced URL to a fetcher, with
 * the fetcher named so the reason is legible.
 */
const GATED_FUNNELS: [string, string][] = [
  ['server/utils/image-scan-url.ts', 'the guard itself'],
  ['server/services/image.service.ts', 'ingestImage pre-check'],
  [
    'server/services/orchestrator/orchestrator.service.ts',
    'createImageIngestionRequest + getPerceptualHash',
  ],
  ['server/services/product-badge.service.ts', 'resizeBadgeImage → orchestrator convertImage'],
  ['server/services/video-dimensions.ts', 'probeVideoDimensions → orchestrator videoMetadata'],
  ['server/services/creator-shop.service.ts', 'validateArtwork → fetch() from the WEB pod'],
  ['server/controllers/user.controller.ts', 'verifyAvatar'],
  ['pages/api/media/ingest/[mediaId].ts', 'the ingest route maps the refusal to a status'],
];

describe('media-fetch funnel ledger', () => {
  const files = sourceFiles();

  it('reads the tree at all (positive control for the walk)', () => {
    // 🔴 Without this, every "zero matches" assertion below is indistinguishable from a
    // scanner wired to nothing. `isEdgeUrlPassthrough` has a known non-zero footprint.
    expect(files.length).toBeGreaterThan(500);
    const passthroughFiles = files.filter(([, body]) => body.includes('isEdgeUrlPassthrough'));
    expect(passthroughFiles.length).toBeGreaterThanOrEqual(3);
  });

  it.each(GATED_FUNNELS)('%s references the shared guard (%s)', (path) => {
    const entry = files.find(([p]) => p === path);
    expect(entry, `${path} is in the ledger but not on disk — update the ledger`).toBeDefined();
    expect(GUARD_TOKENS.test(entry![1])).toBe(true);
  });

  it('the guard-consumer set is EXACTLY the ledger — fails when it grows or shrinks', () => {
    const actual = files
      .filter(([, body]) => GUARD_TOKENS.test(body))
      .map(([p]) => p)
      .sort();
    const expected = GATED_FUNNELS.map(([p]) => p).sort();
    // A new guard CONSUMER is a deliberate act: add it here WITH a behavioural test, or find
    // out why it is reaching the guard. A missing one means a consumer dropped its reference.
    // ⚠ Not "a funnel appeared" — see axis 1 of the docblock. And this row can go red for a
    // NON-defect: any `src/**` file that merely NAMES a guard identifier in a comment joins
    // the set. If that happens, the fix is to add the path or reword the comment, NOT to
    // assume a gate was lost — the message this row used to carry said the latter.
    expect(actual).toEqual(expected);
  });

  it('no SERVER-SIDE module still open-codes the passthrough ternary against getEdgeUrl', () => {
    // The `url.startsWith('http') ? url : getEdgeUrl(url, …)` shape is the spelling all three
    // newly-gated sites shared, and it disagrees with getEdgeUrl's own predicate on
    // `http:/host` (one slash).
    //
    // 🔴 IT IS NOT "THE STRUCTURAL MARKER OF AN UNGATED FUNNEL" — this row used to say that
    // and it is false. A NEW funnel needs no ternary at all: `getEdgeUrl` forwards an absolute
    // URL unmodified by itself, so the shortest un-gated funnel is a bare
    // `fetch(getEdgeUrl(url))`. The regex is also spelling-bound — it requires a bare
    // identifier in the true branch, so `url.trim()`, `isEdgeUrlPassthrough(url) ? …` and
    // `startsWith('https')` all evade it. This row pins that the THREE HISTORICAL spellings do
    // not come back; it cannot discover a fourth funnel, and nothing here can.
    //
    // Scoped to the ternary PAIRED WITH getEdgeUrl on purpose: the bare `startsWith('http')`
    // idiom is used legitimately in 4 unrelated modules (html-sanitize-helpers, buzz.service,
    // block-manifest-validator, block-tokens) that prepend a scheme rather than resolve an
    // edge URL. A blanket ban would have to exempt those, and would then be a list nobody
    // maintains.
    //
    // 🔴 COVERAGE BOUND, stated rather than left silent. This check is SERVER-SIDE ONLY.
    // Two CLIENT components carry the identical idiom, prettier-wrapped across three lines:
    //   src/components/Comics/PanelModal.tsx:433
    //   src/components/IterativeEditor/IterativeImageEditor.tsx:744
    // They resolve a URL for display in the browser, so the fetch is the VIEWER's, not the
    // web pod's — a different hazard class (a credentialed same-origin browser fetch), which
    // is the subject of its own arc. They are excluded here, not overlooked; widening this to
    // `components/` would fail on them immediately and is the deliberate next step if that
    // class is taken on.
    //
    // ⚠ The regex spans NEWLINES (`\s*` matches them), which is what catches the wrapped
    // form. A line-oriented grep does NOT see those two — measured.
    const banned = /startsWith\(['"]http['"]\)\s*\?\s*[A-Za-z_$][\w$]*\s*:\s*getEdgeUrl/;
    const serverSide = files.filter(([p]) => p.startsWith('server/') || p.startsWith('pages/api/'));
    // Positive control for the SCOPE, not just the walk: the filter must retain a real corpus.
    expect(serverSide.length).toBeGreaterThan(100);

    const offenders = serverSide
      .filter(([, body]) => banned.test(stripLineComments(body)))
      .map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it('the client-side occurrences are still exactly the two the bound above names', () => {
    // Pins the EXCLUSION so it cannot quietly grow. If a third client site appears, this
    // fails and someone decides deliberately: gate it, or extend the documented bound.
    const banned = /startsWith\(['"]http['"]\)\s*\?\s*[A-Za-z_$][\w$]*\s*:\s*getEdgeUrl/;
    const clientOffenders = files
      .filter(([p]) => !p.startsWith('server/') && !p.startsWith('pages/api/'))
      .filter(([, body]) => banned.test(stripLineComments(body)))
      .map(([p]) => p)
      .sort();
    expect(clientOffenders).toEqual([
      'components/Comics/PanelModal.tsx',
      'components/IterativeEditor/IterativeImageEditor.tsx',
    ]);
  });

  it('the shared passthrough predicate is still ZERO-IMPORT', () => {
    // Its whole constraint: the server-side allowlist consumes it, and pulling `~/env/client`
    // (which throws on validation) into that graph breaks the suites that mock
    // `~/client-utils/edge-url` to keep it out of their worker.
    const entry = files.find(([p]) => p === 'shared/utils/edge-url-passthrough.ts');
    expect(entry).toBeDefined();
    expect(entry![1]).not.toMatch(/^\s*import\s/m);
  });
});
