import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Regression guard for the `/api/og` outage that started 2026-08-08.
 *
 * WHAT BROKE. Next 16.3.0 hardened the built-in image optimizer by applying a
 * process-global libvips operation block the first time it initializes `sharp`:
 *
 *     _sharp.block({ operation: ['VipsForeignLoad'] })
 *     _sharp.unblock({ operation: ['VipsForeignLoadHeif', 'VipsForeignLoadJpeg',
 *                                  'VipsForeignLoadNsgif', 'VipsForeignLoadPng',
 *                                  'VipsForeignLoadTiff', 'VipsForeignLoadWebp'] })
 *
 * Every raster loader is re-enabled; the SVG loader is not. But `next/og`
 * rasterizes satori's SVG output through that same `sharp` instance
 * (`sharp(svgBuffer).resize(w).png().toBuffer()`), so once anything touches the
 * image optimizer, EVERY `ImageResponse` in the process throws
 * `Input buffer contains unsupported image format` — and `/api/og` returns 500
 * for the rest of that pod's life. Upstream: vercel/next.js#96301 introduced it,
 * vercel/next.js#96681 fixes it by adding `'VipsForeignLoadSvg'` to the unblock
 * list. We carried that one-line fix as a pnpm patch while we were on 16.3.0.
 * 16.3.1 is the first release that CONTAINS the fix — it ships the loader entry
 * upstream — so the patch became inert on that bump and has been deleted. What
 * these cases guard now is a FUTURE Next regressing the entry again.
 *
 * 🔴 Note for whoever reads this next: "the installed file has one occurrence of
 * `'VipsForeignLoadSvg'`" does NOT tell you whether upstream or a patch put it
 * there — the count is identical either way. That ambiguity is how the inert
 * patch survived a bump (pnpm no-ops an already-applied patch with rc=0 and no
 * warning). Attribute it by diffing the installed file against the published
 * tarball; on 16.3.1 they are byte-identical.
 *
 * WHY THIS TEST IS SHAPED THE WAY IT IS. 🔴 The ordering is the whole test.
 * Rendering an `ImageResponse` in a fresh process SUCCEEDS even on a broken
 * build — the block has not been applied yet. Any test that renders first is
 * green through the outage. So `initializeNextImageOptimizerSharp()` below is
 * not setup noise: it is the step that reproduces the bug, and it deliberately
 * calls Next's OWN `getSharp()` rather than re-implementing the block list, so
 * the test tracks whatever Next actually ships instead of a stale copy.
 *
 * The first case is the positive control for the harness: it renders BEFORE the
 * optimizer is touched. If it ever fails, the harness itself is broken and the
 * second case's verdict means nothing. The second case is the regression guard.
 *
 * WHERE THE GATING HAPPENS. This whole file runs in the `Unit tests` job, which
 * is `continue-on-error: true` — it reports, it does not block. The third case
 * below is the one cheap enough to also run in a job that fails the build (no
 * database, no sharp, no browser, no Next module graph — just a file read), so
 * the assertion itself lives in `scripts/ci/assert-next-svg-patch-applied.mjs`
 * and the `Package unit tests` job runs it directly. Do not re-inline the check
 * here: the copy that gates is the one that would go stale unnoticed.
 *
 * Watched red/green (2026-08-09, Next 16.3.0):
 *   - patch REMOVED and reinstalled: case 1 PASSES (harness fine), case 2 FAILS
 *     with "Input buffer contains unsupported image format" — the verbatim
 *     production error — and case 3 FAILS naming the missing loader.
 *   - patch APPLIED: all three pass.
 *
 * Re-watched 2026-08-10 after case 3 moved into the script, against the script
 * as shipped — a mutation that kills a different case than the intended one is
 * a green for the wrong reason, so each of these was checked for WHICH case
 * went red and WHY:
 *   - patch key deleted from `pnpm.patchedDependencies` + reinstalled: the
 *     script exits 1 reporting both copies, and case 3 fails with that text
 *     verbatim in the AssertionError (1 failed, 2 skipped under `-t`).
 *   - ESM copy broken while the CJS copy stays correct: exits 1, reporting the
 *     ESM copy only. This is what proves the second patch hunk is actually
 *     covered rather than shadowed by the CJS check.
 *   - ESM copy absent (the shape of the production standalone image): exits 0,
 *     reports 1 copy read and the ESM copy as skipped.
 *   - both copies absent: exits 1 rather than passing vacuously on zero reads.
 *
 * Re-watched 2026-08-18 on stock 16.3.1 with the patch DELETED — the mutations
 * above that reinstall or delete a patch no longer reproduce, since there is no
 * Next patch to remove, so the guard was driven against node_modules directly:
 *   - installed copies byte-identical (sha256) to the published next-16.3.1
 *     tarball, and the guard exits 0 reporting `copies read: 2`, both ok. The
 *     hash equality is the part that attributes the loader entry to upstream;
 *     the guard's own green cannot, since it counts rather than attributes.
 *   - `'VipsForeignLoadSvg',` stripped from BOTH installed copies, leaving the
 *     `unblock({ operation: [...] })` call structurally intact so the SVG branch
 *     is reached rather than the no-unblock-call fallback: exits 1 reporting
 *     both copies "does NOT unblock VipsForeignLoadSvg", `copies read: 2`.
 *     Restored from a `cp -a` backup (never `git checkout` — node_modules is
 *     untracked) and re-confirmed green.
 *   - both copies moved aside: exits 1 with "this check proved nothing",
 *     `copies read: 0` — still no vacuous pass.
 *
 * SCOPE / WHAT THIS DOES NOT COVER. This runs in-process, so it does not cover
 * packaging failures under `output: 'standalone'` (the OTHER way `/api/og` has
 * broken — see the `outputFileTracingIncludes['/api/og']` entry in
 * next.config.mjs and #2509). `tests/preview-og.spec.ts` covers that over HTTP
 * against the built preview image.
 */

const PNG_MAGIC = '89504e470d0a1a0a';

// The FallbackCard path — the handler's no-entity branch. `dbRead.model.findFirst`
// resolving null makes fetchModelData return null, which renders FallbackCard
// inside the main `try` (NOT via the catch). Chosen deliberately: it is the only
// /api/og render path with no database, no network and no fixtures, so this test
// exercises the renderer and nothing else.
vi.mock('~/server/db/client', () => ({
  dbRead: {
    model: { findFirst: vi.fn().mockResolvedValue(null) },
    modelMetric: { findUnique: vi.fn().mockResolvedValue(null) },
    image: { findFirst: vi.fn().mockResolvedValue(null) },
  },
  dbWrite: {},
  dbKV: {},
}));

import handler from '~/pages/api/og';

type CapturedRes = NextApiResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: unknown;
};

function makeRes(): CapturedRes {
  const res = { _status: 200, _headers: {}, _body: undefined } as unknown as CapturedRes;
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  }) as any;
  res.setHeader = vi.fn((k: string, v: string) => {
    res._headers[k.toLowerCase()] = v;
    return res;
  }) as any;
  res.send = vi.fn((body: unknown) => {
    res._body = body;
    return res;
  }) as any;
  res.json = vi.fn((body: unknown) => {
    res._body = body;
    return res;
  }) as any;
  res.end = vi.fn(() => res) as any;
  return res;
}

function makeReq(query: Record<string, string>): NextApiRequest {
  return { method: 'GET', query, headers: {} } as unknown as NextApiRequest;
}

async function renderOg(query: Record<string, string>) {
  const res = makeRes();
  await handler(makeReq(query), res);
  return res;
}

/**
 * Do exactly what the running Next server does on the first `/_next/image`
 * cache miss: initialize the image optimizer's `sharp`, which applies the
 * process-global libvips block. Imported from Next's own module on purpose —
 * a hand-copied block list here would keep passing after Next changed it.
 */
async function initializeNextImageOptimizerSharp() {
  const { getSharp } = await import('next/dist/server/image-optimizer.js');
  // (concurrency, operationCache) — both nullable; the server passes its config
  // values, and neither affects the block/unblock this test is about.
  const sharp = getSharp(undefined, undefined);
  // Positive control on the setup step itself: a no-op `getSharp` (wrong export,
  // renamed module, silently caught failure) would make the guard below vacuous.
  expect(typeof sharp).toBe('function');
  return sharp;
}

// The handler swallows the real reason: its outer catch logs, and its inner catch
// is bare, so a 500 body says only "Failed to generate OG image". Capturing the
// log makes the RED run name the actual defect
// ("Input buffer contains unsupported image format") instead of just "500 != 200".
let ogErrorLogs: unknown[][] = [];
beforeEach(() => {
  ogErrorLogs = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).startsWith('OG image generation failed')) ogErrorLogs.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function expectPngResponse(res: CapturedRes) {
  // Assert the render never fell into the catch first: this is what carries the
  // real error text into the failure output.
  expect(ogErrorLogs.map((a) => String(a[1]))).toEqual([]);
  expect(res._status).toBe(200);
  expect(res._headers['content-type']).toBe('image/png');
  expect(Buffer.isBuffer(res._body)).toBe(true);
  const body = res._body as Buffer;
  expect(body.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
  // A 1200x630 card is tens of KB; anything under 1 KB is a truncated/blank encode.
  expect(body.byteLength).toBeGreaterThan(1024);
}

describe('/api/og — renders a PNG after the Next image optimizer initializes sharp', () => {
  it('positive control: renders a PNG in a pristine process (optimizer untouched)', async () => {
    expectPngResponse(await renderOg({ type: 'model', id: '999999999' }));
  });

  it('still renders a PNG once the image optimizer has applied its sharp block', async () => {
    await initializeNextImageOptimizerSharp();

    // The bug: this render throws "Input buffer contains unsupported image
    // format" inside next/og, the handler's inner catch also throws for the same
    // reason, and the endpoint returns 500 for every request from here on.
    expectPngResponse(await renderOg({ type: 'model', id: '999999999' }));
  });

  it('the image optimizer un-blocks the SVG loader that next/og depends on', () => {
    // Structural companion to the behavioural guard above: assert the actual
    // remedy is present in the artifact we install, so a failure says WHY rather
    // than only that a render broke. It reads Next's shipped source rather than
    // our patch file, so re-installing without the patch fails here too.
    //
    // The assertion itself lives in the script rather than here, and this case
    // shells out to it, for two reasons. One rule, one place: this file is in the
    // report-only `Unit tests` job, and the same check also has to run in a
    // BLOCKING job — two copies of the regex would drift, and the copy that
    // gates is the one that would go stale unnoticed. And running it as a
    // subprocess means this case exercises the exact command CI runs, exit code
    // included, rather than something merely equivalent to it.
    const script = join(process.cwd(), 'scripts/ci/assert-next-svg-patch-applied.mjs');
    // Positive control on the plumbing: from a wrong cwd the spawn below fails
    // for a reason that has nothing to do with the loader, and the point of this
    // case is that a failure names the loader.
    expect(existsSync(script), `guard script not found at ${script}`).toBe(true);

    // `spawnSync`, not `execFileSync`: on a non-zero exit the latter throws an
    // Error whose message is only "Command failed: node <path>" and keeps stderr
    // on a property vitest never prints. The whole point of this case is that a
    // RED run names the missing loader, so the script's own output has to reach
    // the assertion message.
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    expect(run.status, output).toBe(0);
    // Never let a silent no-op pass for a green: the script prints how many
    // copies of image-optimizer.js it actually read, and zero is a vacuous OK.
    expect(output).toMatch(/copies of image-optimizer\.js read: [1-9]/);
    expect(output).toContain('VipsForeignLoadSvg');
  });
});
