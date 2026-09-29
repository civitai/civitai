import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SEAM guard: the LEDGER of every module that turns a caller-supplied string into a URL
 * something will fetch, and the assertion that each one goes through the ONE shared guard.
 *
 * 🔴 Why a ledger rather than another per-function test. Each funnel already has its own
 * suite, and every one of those passes in ISOLATION — which is exactly how this class of
 * defect survived: `createImageIngestionRequest` was gated and audit-clean while three
 * sibling funnels built the same fetchable URL the same way and were not, because no test
 * was scoped to the RELATIONSHIP. This pins the relationship: it fails when the consumer set
 * GROWS (a new funnel appears and must be gated deliberately) and when it SHRINKS (a guard
 * is removed).
 *
 * It is a STRUCTURAL check and says so: it proves a module references the guard, never that
 * it calls it on the right value. The behavioural half lives in the per-funnel suites.
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
      out.push([relative(SRC, full), readFileSync(full, 'utf8')]);
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
  ['server/services/orchestrator/orchestrator.service.ts', 'createImageIngestionRequest + getPerceptualHash'],
  ['server/services/product-badge.service.ts', 'resizeBadgeImage → orchestrator convertImage'],
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
    // A new consumer is a deliberate act: add it here WITH a behavioural test, or find out
    // why it is reaching the guard. A missing one means a funnel lost its gate.
    expect(actual).toEqual(expected);
  });

  it('no SERVER-SIDE module still open-codes the passthrough ternary against getEdgeUrl', () => {
    // The `url.startsWith('http') ? url : getEdgeUrl(url, …)` shape is the structural marker
    // of an UNGATED funnel — it was the spelling all three newly-gated sites shared, and it
    // disagrees with getEdgeUrl's own predicate on `http:/host` (one slash).
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
    const serverSide = files.filter(
      ([p]) => p.startsWith('server/') || p.startsWith('pages/api/')
    );
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
