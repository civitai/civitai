import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * OUTPUT coverage for the PASS-THROUGH arm (`kind:'step'` with a bare `$type`).
 *
 * 🔴 THE PROPERTY UNDER TEST IS A NEGATIVE ONE, AND IT IS THE WHOLE POINT. The
 * arm forwards an arbitrary orchestrator output to the block, so the question is
 * not "does the output arrive" but "can an image url arrive by a route the
 * publish path and the per-viewer gated read do not see". Every assertion below
 * is either (a) the blobs landed on `imageUrls` / `AppWorkflow.images` — the one
 * channel those two already own — or (b) they did NOT land in `stepOutputs`.
 */

// Deterministic edge-url so the gated assertions are stable and the real CF util
// (which pulls env) stays out. Mirrors `block-gated-images.service.test.ts`.
vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: (url: string, opts?: { width?: number }) => `edge:${url}@${opts?.width}`,
}));
const getAllHiddenForUser = vi.fn(async () => ({
  hiddenUsers: [] as Array<{ id: number }>,
  blockedUsers: [] as Array<{ id: number }>,
  blockedByUsers: [] as Array<{ id: number }>,
  hiddenTags: [] as Array<{ id: number; hidden: boolean }>,
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: (...a: unknown[]) => getAllHiddenForUser(...(a as [])),
}));
vi.mock('~/server/services/blocks/block-image-upload.service', () => ({
  BLOCK_PUBLISHED_APP_ID_META_KEY: 'blockPublishedAppId',
}));

import { BLOCK_STEP_NAME, projectAppWorkflow, snapshotFromWorkflow } from '../workflow.service';
import { splitPassThroughStepOutput } from '../steps';
import { getBlockGatedImagesByIds } from '../block-gated-images.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A `$type` the step registry does not know and `workflow.service` does not
 * extract natively — i.e. reachable ONLY through the pass-through arm. A REAL
 * one from `WorkflowStepTemplate.discriminator.mapping` (50 entries, measured
 * 2026-09-17), not a plausible-looking invention.
 */
const PASS_THROUGH_TYPE = 'imageBackgroundRemoval';

const BLOB_URL = 'https://blobs.example/pass-through-1.webp';

function workflowWithPassThroughStep(output: unknown, name: string = BLOCK_STEP_NAME) {
  return {
    id: 'wf_pt_1',
    status: 'succeeded',
    createdAt: '2026-09-17T00:00:00Z',
    cost: { total: 7 },
    // `name` is the gate: the extractors key on the SERVER-STAMPED step name, so
    // every fixture here carries the real one and the negative cases below pass
    // a different one rather than a different `$type`.
    steps: [{ $type: PASS_THROUGH_TYPE, name, output }],
  };
}

describe('splitPassThroughStepOutput', () => {
  it('lifts blobs out and leaves everything else verbatim', () => {
    const { media, rest } = splitPassThroughStepOutput({
      blobs: [{ url: BLOB_URL, available: true, width: 10, height: 20, nsfwLevel: 'pg' }],
      text: 'a reply',
      nested: { a: [1, 2] },
    });
    expect(media).toEqual([{ url: BLOB_URL, width: 10, height: 20, nsfwLevel: 'pg' }]);
    // 🔴 THE EMPTIED ARRAY IS KEPT, the blob elements are removed from it. The
    // walk lifts PER ELEMENT, so a non-blob sibling — or a blob nested inside
    // one — survives; an all-or-nothing rule discarded them with the array.
    expect(rest).toEqual({ blobs: [], text: 'a reply', nested: { a: [1, 2] } });
  });

  // 🔴 THE STRIP IS UNCONDITIONAL. A blob that the availability filter DROPPED
  // must not survive in `rest` — filtering and stripping on the same predicate is
  // how a blocked url reaches a block through the back door.
  it('strips a blob key that produced NO media', () => {
    const { media, rest } = splitPassThroughStepOutput({
      blobs: [{ url: BLOB_URL, available: false }],
      note: 'kept',
    });
    expect(media).toEqual([]);
    expect(rest).toEqual({ blobs: [], note: 'kept' });
    expect(JSON.stringify(rest)).not.toContain(BLOB_URL);
  });

  // 🔴 THE PREDICATE IS KEY-AGNOSTIC, WHICH IS THE POINT — so two representative
  // names prove it and nineteen would not prove more. The first draft of this
  // splitter enumerated four key NAMES; measured 2026-09-17 against every
  // `*Output` schema in `WorkflowStepTemplate.discriminator.mapping`, the live
  // catalog carries blobs under NINETEEN: `blob`, `blobs`, `image`, `images`,
  // `video`, `audioBlob`, `svg`, `frames`, `tempBlobs`, `draftCache`,
  // `additionalVideos`, `model`, `fbxModel`, `thumbnail`, `riggedModel`,
  // `riggedFbxModel`, `animatedModel`, `animatedFbxModel`, `basicAnimations`.
  // The other fifteen would each have ridden out as a raw url inside the
  // forwarded output. That measurement is why the key list is gone; it is
  // recorded here rather than re-encoded as 38 test bodies that all exercise one
  // branch and pin nothing.
  it.each(['audioBlob', 'frames'])('lifts media out of the `%s` property', (key) => {
    const { media, rest } = splitPassThroughStepOutput({
      [key]: [{ url: BLOB_URL, available: true }],
      keep: 1,
    });
    expect(media).toHaveLength(1);
    expect(rest).toEqual({ [key]: [], keep: 1 });
  });

  it.each(['audioBlob', 'frames'])('strips `%s` even when it produced nothing', (key) => {
    const { media, rest } = splitPassThroughStepOutput({
      [key]: { url: BLOB_URL, available: false },
      keep: 1,
    });
    expect(media).toEqual([]);
    expect(JSON.stringify(rest)).not.toContain(BLOB_URL);
  });

  // 🔴 A MIXED LIST — the shape that made the first `every` spelling LEAK. One
  // element without a `url` key (a blocked or not-yet-available blob: the
  // orchestrator's `Blob.url` is optional) disqualified the whole array, left the
  // key unstripped, and forwarded every sibling's raw url through `rest`.
  it('lifts the blob elements of a PARTLY blob-shaped list and keeps the rest', () => {
    const { media, rest } = splitPassThroughStepOutput({
      frames: [{ url: BLOB_URL, available: true }, { note: 'not a blob' }],
      keep: 1,
    });
    expect(media).toEqual([{ url: BLOB_URL, width: null, height: null, nsfwLevel: null }]);
    expect(rest).toEqual({ frames: [{ note: 'not a blob' }], keep: 1 });
    expect(JSON.stringify(rest)).not.toContain(BLOB_URL);
  });

  // 🔴 THE INTERACTION NEITHER RULE'S OWN TESTS COVERED: a blob-shaped element
  // BESIDE an object that CONTAINS a blob. An all-or-nothing array rule lifted
  // the first and discarded the second from BOTH sides — never published, never
  // forwarded, a silent media LOSS on the arm the app paid for.
  it('lifts a blob NESTED inside a non-blob sibling of a blob element', () => {
    const { media, rest } = splitPassThroughStepOutput({
      items: [
        { url: `${BLOB_URL}#a`, available: true },
        { label: 'wrapper', inner: { url: `${BLOB_URL}#b`, available: true } },
      ],
    });
    expect(media.map((m) => m.url)).toEqual([`${BLOB_URL}#a`, `${BLOB_URL}#b`]);
    expect(rest).toEqual({ items: [{ label: 'wrapper' }] });
  });

  it('lifts a TOP-LEVEL blob LIST, forwarding nothing', () => {
    const { media, rest } = splitPassThroughStepOutput([
      { url: BLOB_URL, available: true },
      // 🔴 `id`, NOT a bare `{available:false}`. Without an identity field this
      // element is not blob-shaped at all, so the test would pass under a
      // predicate that had never been widened — it would pin nothing it looks
      // like it pins.
      { id: 'b2', available: false },
    ]);
    expect(media).toHaveLength(1);
    expect(rest).toEqual([]);
  });

  it('forwards a plain array that carries no blobs', () => {
    const { media, rest } = splitPassThroughStepOutput([{ note: 'x' }, 1, 'two']);
    expect(media).toEqual([]);
    expect(rest).toEqual([{ note: 'x' }, 1, 'two']);
  });

  // 🔴 SOME STEP TYPES *ARE* A BLOB — `transcode`'s whole output is one. Without
  // the top-level case its url is the entire forwarded object.
  it('treats a top-level blob-shaped output as media, forwarding nothing', () => {
    const { media, rest } = splitPassThroughStepOutput({
      id: 'b',
      available: true,
      url: BLOB_URL,
      tier: 'managed',
    });
    expect(media).toEqual([{ url: BLOB_URL, width: null, height: null, nsfwLevel: null }]);
    expect(rest).toEqual({});
  });

  // The predicate is a SHAPE test, so it must not strip a value that merely
  // shares a NAME with a media property. This is the false-positive control.
  it('does NOT strip a same-named property that is not blob-shaped', () => {
    const { media, rest } = splitPassThroughStepOutput({
      model: 'gpt-4o-mini',
      images: 3,
      video: { durationSeconds: 5 },
    });
    expect(media).toEqual([]);
    expect(rest).toEqual({ model: 'gpt-4o-mini', images: 3, video: { durationSeconds: 5 } });
  });

  // 🔴 BOTH HALVES OF THE SHAPE, NOT JUST `url`. Dropping the `available` test
  // widens the predicate to every object that merely HAS a url — a provider
  // reference, a citation, a callback — and silently removes it from the output
  // the arm promises to forward verbatim. This is the control for that mutant;
  // without it, relaxing the predicate is invisible.
  it('does NOT strip an object that has a url but no `available`', () => {
    const source = { url: 'https://docs.example/ref', title: 'a citation' };
    const { media, rest } = splitPassThroughStepOutput({ source });
    expect(media).toEqual([]);
    expect(rest).toEqual({ source });
  });

  // 🔴 THE SAME CONTROL AT THE TOP-LEVEL CALL SITE, which is a SECOND use of the
  // predicate and needs its own. Weakening it there replaces the ENTIRE output of
  // any reply carrying a top-level `url` — a permalink, a callback ref — with
  // `{}` on the arm whose contract is "forward verbatim".
  it('does NOT treat a top-level object with a url but no `available` as media', () => {
    const output = { url: 'https://docs.example/ref', text: 'an answer' };
    const { media, rest } = splitPassThroughStepOutput(output);
    expect(media).toEqual([]);
    expect(rest).toEqual(output);
  });

  // 🔴 THE TWO REAL NESTED SHAPES IN THE LIVE CATALOG, both on ALLOWED types. A
  // depth-1 walk shipped and was then measured: `polyGen.basicAnimations` is a
  // plain object holding SIX `Model3DBlob`s and `training.epochs[]` carries a
  // `model` plus a `samples[]` of media. Every one of those urls was forwarded
  // raw — reachable by the app, invisible to the publish path and to the
  // per-viewer gated read.
  it('reaches blobs nested inside a plain object (polyGen.basicAnimations)', () => {
    const { media, rest } = splitPassThroughStepOutput({
      model: { url: `${BLOB_URL}#m`, available: true },
      basicAnimations: {
        walkingModel: { url: `${BLOB_URL}#w`, available: true },
        runningModel: { url: `${BLOB_URL}#r`, available: true },
      },
    });
    expect(media.map((m) => m.url)).toEqual([`${BLOB_URL}#m`, `${BLOB_URL}#w`, `${BLOB_URL}#r`]);
    expect(JSON.stringify(rest)).not.toContain(BLOB_URL);
  });

  it('reaches blobs nested inside an array of objects (training.epochs[])', () => {
    const { media, rest } = splitPassThroughStepOutput({
      epochs: [
        { epochNumber: 1, model: { url: `${BLOB_URL}#1`, available: true } },
        { epochNumber: 2, samples: [{ url: `${BLOB_URL}#2`, available: true }] },
      ],
    });
    expect(media.map((m) => m.url)).toEqual([`${BLOB_URL}#1`, `${BLOB_URL}#2`]);
    expect(JSON.stringify(rest)).not.toContain(BLOB_URL);
    // The surrounding structure is preserved — only the blobs are lifted out.
    expect(rest).toEqual({ epochs: [{ epochNumber: 1 }, { epochNumber: 2, samples: [] }] });
  });

  // 🔴 THE IDENTITY CONJUNCT, WHICH THE `available`-ONLY CONTROLS CANNOT SEE.
  // Dropping `('url' in v || 'id' in v)` leaves every control above green and
  // makes any object carrying an `available` key vanish from the forwarded
  // output — measured as a surviving mutant before this test existed.
  it('does NOT strip an object with `available` but no identity field', () => {
    const capacity = { available: true, queueDepth: 3 };
    expect(splitPassThroughStepOutput({ capacity })).toEqual({ media: [], rest: { capacity } });
  });

  // 🔴 THE DEPTH CAP, PINNED RATHER THAN IMPLIED. Measured: `JSON.parse` accepts
  // 200,000 levels while an unbounded recursive walk overflows the stack between
  // 1,000 and 2,000, so this cap is the only thing bounding the recursion. Past
  // it a value is forwarded as-is; that residue is stated at the walk.
  // 🔴 AN ARRAY INSIDE AN ARRAY. Every other array fixture here holds objects or
  // primitives, so "recurse into the non-blob elements" was pinned for objects
  // only: forwarding any array-valued element verbatim survived the whole suite
  // and sent the url straight out through `stepOutputs`.
  it('descends into an array nested directly inside an array', () => {
    const { media, rest } = splitPassThroughStepOutput({
      frames: [[{ url: BLOB_URL, available: true }]],
    });
    expect(media.map((m) => m.url)).toEqual([BLOB_URL]);
    expect(rest).toEqual({ frames: [[]] });
  });

  // 🔴 THE BOUNDARY WITH ARRAYS ON THE PATH. Both object-chain fixtures below
  // leave the array branch's own `depth + 1` unpinned — dropping it survived the
  // suite, and it is the increment that keeps a deep ORCHESTRATOR RESPONSE (not
  // an app payload — the walked value is `step.output`) from overflowing the
  // stack. Measured: without the increment an array chain overflows between
  // 1,000 and 2,000 levels, and `JSON.parse` admits 200,000.
  it('counts array levels toward the depth cap', () => {
    const atCap = splitPassThroughStepOutput({ a: [{ b: [{ url: BLOB_URL, available: true }] }] });
    expect(atCap.media.map((m) => m.url)).toEqual([BLOB_URL]);
    expect(JSON.stringify(atCap.rest)).not.toContain(BLOB_URL);

    const pastCap = splitPassThroughStepOutput({
      z: { a: [{ b: [{ url: BLOB_URL, available: true }] }] },
    });
    expect(pastCap.media).toEqual([]);
    expect(JSON.stringify(pastCap.rest)).toContain(BLOB_URL);
  });

  // 🔴 BOTH SIDES OF THE BOUNDARY, or the constant is pinned to an INTERVAL. A
  // negative case alone bounds it from above only; this pair pins the value.
  // (An earlier version of this note justified it by the `epochs` fixture
  // needing ≥3 — true of the all-or-nothing array rule that preceded the
  // per-element walk, and stale the moment that changed. The structural reason
  // is the one that survives a fixture reshape.)
  it('reaches a blob at exactly the deepest level the cap examines', () => {
    const { media, rest } = splitPassThroughStepOutput({
      a: { b: { c: { d: { url: BLOB_URL, available: true } } } },
    });
    expect(media.map((m) => m.url)).toEqual([BLOB_URL]);
    expect(JSON.stringify(rest)).not.toContain(BLOB_URL);
  });

  it('does NOT descend past the depth cap', () => {
    const deep = { a: { b: { c: { d: { e: { url: BLOB_URL, available: true } } } } } };
    const { media, rest } = splitPassThroughStepOutput(deep);
    expect(media).toEqual([]);
    expect(JSON.stringify(rest)).toContain(BLOB_URL);
  });

  // 🔴 THE UNCONDITIONAL STRIP AT THE WHOLE-VALUE SITE — the per-key site has its
  // own control above, and this one had none. Gating that branch on what
  // `mediaFromBlobs` PRODUCED lets a BLOCKED `transcode`-shaped output fall
  // through to the walk and forward its url verbatim.
  it('strips a whole-value blob that produced NO media', () => {
    expect(
      splitPassThroughStepOutput({ id: 'b', available: false, url: BLOB_URL, tier: 'm' })
    ).toEqual({ media: [], rest: {} });
    expect(splitPassThroughStepOutput([{ url: BLOB_URL, available: false }])).toEqual({
      media: [],
      rest: [],
    });
  });

  // 🔴 `url` IS OPTIONAL UPSTREAM — a blocked blob simply has no `url` key. Keyed
  // on `available` + `url` it failed the shape test and was forwarded whole, so
  // its `blockedReason` and raw `nsfwLevel` reached the app and the module's
  // "a dropped blob cannot ride out through `rest`" claim was false.
  it('strips a blob whose `url` key is ABSENT', () => {
    const blocked = { type: 'image', id: 'b', available: false, blockedReason: 'csam-policy' };
    expect(splitPassThroughStepOutput({ blob: blocked })).toEqual({ media: [], rest: {} });
    expect(splitPassThroughStepOutput(blocked)).toEqual({ media: [], rest: {} });
    expect(JSON.stringify(splitPassThroughStepOutput({ blob: blocked }).rest)).not.toContain(
      'csam-policy'
    );
  });

  it('handles the SINGULAR `blob` key and a non-object output', () => {
    expect(
      splitPassThroughStepOutput({ blob: { url: BLOB_URL, available: true } }).media
    ).toHaveLength(1);
    expect(splitPassThroughStepOutput('just text')).toEqual({ media: [], rest: 'just text' });
    expect(splitPassThroughStepOutput(undefined)).toEqual({ media: [], rest: undefined });
  });
});

describe('snapshotFromWorkflow — pass-through step', () => {
  it('routes image blobs to imageUrls and forwards the REST as stepOutputs', () => {
    const snap = snapshotFromWorkflow(
      workflowWithPassThroughStep({
        blobs: [{ url: BLOB_URL, available: true }],
        text: 'a model reply',
      }) as never
    );
    expect(snap.imageUrls).toEqual([BLOB_URL]);
    expect(snap.stepOutputs).toEqual([
      { $type: PASS_THROUGH_TYPE, output: { blobs: [], text: 'a model reply' } },
    ]);
    // 🔴 THE NEGATIVE HALF: no second image channel.
    expect(JSON.stringify(snap.stepOutputs)).not.toContain(BLOB_URL);
  });

  it('forwards a non-media output whole', () => {
    const snap = snapshotFromWorkflow(
      workflowWithPassThroughStep({ text: 'hello', tokens: { in: 3, out: 9 } }) as never
    );
    expect(snap.imageUrls).toBeUndefined();
    expect(snap.stepOutputs).toEqual([
      { $type: PASS_THROUGH_TYPE, output: { text: 'hello', tokens: { in: 3, out: 9 } } },
    ]);
  });

  // 🔴 A STEP THIS BRIDGE DID NOT SUBMIT IS STILL DROPPED. Same `$type`, same
  // output, different `name` — so this is the gate and not the `$type` test.
  // Without it the arm would forward the output of any step the ORCHESTRATOR put
  // on the workflow, on `textToImage` and `customComfy` workflows too, through a
  // channel with no moderation posture.
  it('DROPS a foreign step with the same $type but a different name', () => {
    const wf = workflowWithPassThroughStep(
      { blobs: [{ url: BLOB_URL, available: true }], text: 'secret' },
      'some-other-step'
    );
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toBeUndefined();
    expect(snap.stepOutputs).toBeUndefined();
    expect(projectAppWorkflow(wf as never).images).toEqual([]);
  });

  // A fresh submit reply carries steps with no `output` at all. An entry there
  // would say nothing and would appear on EVERY pass-through submit reply.
  it('OMITS stepOutputs for a step that has produced nothing yet', () => {
    const snap = snapshotFromWorkflow({
      id: 'wf_pt_new',
      status: 'processing',
      steps: [{ $type: PASS_THROUGH_TYPE, name: BLOCK_STEP_NAME }],
    } as never);
    expect(snap.stepOutputs).toBeUndefined();
  });

  // 🔴 A MIXED WORKFLOW — the shape nothing else in this file builds, and the one
  // the "every existing snapshot stays byte-identical" claim is really about. A
  // native step alongside a step this bridge did not submit must produce the
  // pre-change snapshot exactly: the native urls, and no `stepOutputs` at all.
  it('a NATIVE step beside a foreign step yields the pre-change snapshot', () => {
    const snap = snapshotFromWorkflow({
      id: 'wf_mixed',
      status: 'succeeded',
      steps: [
        {
          $type: 'textToImage',
          name: 't',
          output: { images: [{ url: 'https://i/x.png', available: true }] },
        },
        {
          $type: PASS_THROUGH_TYPE,
          name: 'orchestrator-added',
          output: { blobs: [{ url: BLOB_URL, available: true }] },
        },
      ],
    } as never);
    expect(snap.imageUrls).toEqual(['https://i/x.png']);
    expect(snap.stepOutputs).toBeUndefined();
  });

  it('KEEPS an entry for an empty-object output (distinct from absent)', () => {
    const snap = snapshotFromWorkflow(workflowWithPassThroughStep({}) as never);
    expect(snap.stepOutputs).toEqual([{ $type: PASS_THROUGH_TYPE, output: {} }]);
  });

  // Additive-by-construction: the field must be ABSENT for every body that
  // existed before this arm, or an SDK validator sees a shape change on a
  // snapshot nothing about this change touched.
  it('OMITS stepOutputs for a native textToImage workflow', () => {
    const snap = snapshotFromWorkflow({
      id: 'wf_t2i',
      status: 'succeeded',
      steps: [
        { $type: 'textToImage', output: { images: [{ url: 'https://i/x.png', available: true }] } },
      ],
    } as never);
    expect(snap.imageUrls).toEqual(['https://i/x.png']);
    expect(snap.stepOutputs).toBeUndefined();
  });

  it('OMITS stepOutputs for a native customComfy workflow', () => {
    const snap = snapshotFromWorkflow({
      id: 'wf_cc',
      status: 'succeeded',
      steps: [
        { $type: 'customComfy', output: { blobs: [{ url: 'https://i/c.png', available: true }] } },
      ],
    } as never);
    expect(snap.imageUrls).toEqual(['https://i/c.png']);
    expect(snap.stepOutputs).toBeUndefined();
  });
});

describe('projectAppWorkflow — pass-through step', () => {
  // 🔴 THIS IS THE PUBLISHABILITY HALF OF THE GATED-IMAGE CHAIN.
  // `resolveOwnedWorkflowOutputs` reads THIS projection, so a pass-through image
  // missing here is one a viewer can see in their own block and can never
  // publish — which routes it AROUND the per-viewer gated read rather than
  // through it.
  it('surfaces pass-through blobs as AppWorkflow images, with the rest dropped', () => {
    const projected = projectAppWorkflow(
      workflowWithPassThroughStep({
        blobs: [{ url: BLOB_URL, available: true, width: 64, height: 48, nsfwLevel: 'pg13' }],
        text: 'not an image',
      }) as never
    );
    expect(projected.images).toEqual([
      { url: BLOB_URL, width: 64, height: 48, nsfwLevel: NsfwLevel.PG13 },
    ]);
    // `AppWorkflow` is the queue contract — images, cost, status and nothing else.
    expect(Object.keys(projected).sort()).toEqual(
      ['cost', 'createdAt', 'images', 'status', 'workflowId'].sort()
    );
  });

  it('drops an unavailable pass-through blob rather than handing over a dead link', () => {
    const projected = projectAppWorkflow(
      workflowWithPassThroughStep({ blobs: [{ url: BLOB_URL, available: false }] }) as never
    );
    expect(projected.images).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAM, not the two ends of it.
//
// 🔴 AN EARLIER VERSION OF THIS BLOCK BUILT AN `Image` ROW BY HAND AND CALLED
// `getBlockGatedImagesByIds` ON IT. Every assertion passed — and every one of
// them would have passed with this whole feature DELETED, because no
// pass-through symbol was in scope. It was a test of the pre-existing gated read
// wearing this feature's name.
//
// The join is what matters: a pass-through blob is publishable ONLY because
// `projectAppWorkflow` surfaces it (that projection is what
// `resolveOwnedWorkflowOutputs` reads), and it is safe cross-viewer ONLY because
// what `publishGenerationOutputs` then writes is read back through the gated
// clamp. So the row below is DERIVED from the projection rather than invented:
// delete the pass-through branch in `projectAppWorkflow` and this block fails at
// its first assertion, before it ever reaches the gated read.
//
// What is still NOT covered, stated rather than implied: the middle link —
// `resolveOwnedWorkflowOutputs` → `publishGenerationOutputs` →
// `persistBlockWorkflowOutputImage` → the `Image` row — is mocked away, so
// "a row gets written" is an assumption, not a measurement. That path also has
// its own host allowlist (`isAllowedOutputHost`), which a pass-through `$type`
// returning blobs from an unlisted host would fail — fail-safe, and untested for
// this arm. Nothing here performs a publish; the describe name says so.
// ─────────────────────────────────────────────────────────────────────────────
describe('the gated read over an Image row a pass-through publish would produce', () => {
  const APP = 'app_test';
  const VIEWER = 42;
  const AUTHOR = 7;
  const SFW = NsfwLevel.PG | NsfwLevel.PG13;
  const PUBLISHED_ID = 9001;

  /**
   * The projected output a publish of a pass-through step would draw from.
   *
   * 🔴 DERIVED, NOT WRITTEN DOWN — that is what makes this block fail when the
   * pass-through branch in `projectAppWorkflow` is deleted, rather than passing
   * over a hand-built row as an earlier version did.
   */
  function projectedOutput() {
    const projected = projectAppWorkflow(
      workflowWithPassThroughStep({
        blobs: [{ url: BLOB_URL, available: true, width: 512, height: 384 }],
      }) as never
    );
    expect(
      projected.images,
      'a pass-through blob must be publishable at all — see projectAppWorkflow'
    ).toHaveLength(1);
    return projected.images[0];
  }

  /**
   * The `Image` row a publish of that projected output produces.
   *
   * ⚠️ `url` is an OPAQUE KEY, not derived from the projected url, and a draft of
   * this fixture got that backwards. `persistBlockWorkflowOutputImage` FETCHES
   * the projected url and stores the bytes under a fresh uuid
   * (`uploadImageBufferToStore`), so the projected url is the fetch SOURCE and
   * never the row's `url`. `width`/`height` ARE carried across, so those are what
   * this derives — and they are deliberately UNEQUAL, so a `width`/`height` swap
   * in the gated read cannot pass.
   */
  const publishedRow = (over: Record<string, unknown> = {}) => {
    const projected = projectedOutput();
    return {
      id: PUBLISHED_ID,
      userId: AUTHOR,
      url: 'a4f1c0de-0000-4000-8000-000000000001.png',
      // 🔴 PG13, NOT PG. `contentRatingFromNsfwLevel(PG)` is `'g'` — which is
      // also what 0/null/undefined return (the documented fail-closed default),
      // so a hardcoded rating, a dropped argument and the real computation are
      // indistinguishable at PG. PG13 is inside the SFW ceiling below, so the
      // row is still `visible`, and `'pg13'` is a value the default cannot be.
      nsfwLevel: NsfwLevel.PG13,
      ingestion: ImageIngestionStatus.Scanned,
      width: projected.width,
      height: projected.height,
      needsReview: null,
      poi: false,
      minor: false,
      tosViolation: false,
      acceptableMinor: false,
      blockedFor: null,
      ...over,
    };
  };

  beforeEach(() => {
    dbMock.dbRead.$queryRaw.mockReset();
    getAllHiddenForUser.mockClear();
  });

  it('yields a VISIBLE BlockGatedImage (an edge url, never the raw key) in-ceiling', async () => {
    const row = publishedRow();
    dbMock.dbRead.$queryRaw.mockResolvedValue([row]);
    const { images } = await getBlockGatedImagesByIds({
      imageIds: [PUBLISHED_ID],
      browsingLevel: SFW,
      appId: APP,
      userId: VIEWER,
    });
    expect(images).toEqual([
      {
        imageId: PUBLISHED_ID,
        status: 'visible',
        nsfwLevel: NsfwLevel.PG13,
        // 🔴 THE STRING LITERAL, not `contentRatingFromNsfwLevel(...)` — calling
        // the same helper the service calls on the same input reimplements the
        // thing under test and passes whatever it returns.
        contentRating: 'pg13',
        // The gated EDGE url (1200 = the service's own GATED_IMAGE_EDGE_WIDTH,
        // module-private), never the raw storage key.
        url: `edge:${row.url}@1200`,
        // Carried from the projection, and UNEQUAL, so a swap cannot pass.
        width: 512,
        height: 384,
      },
    ]);
  });

  // 🔴 THE OVER-CEILING VIEWER. `hidden` and NO url — the per-viewer moderation
  // boundary the pass-through arm must not route around.
  it('yields HIDDEN with no url for an over-ceiling viewer', async () => {
    const row = publishedRow({ nsfwLevel: NsfwLevel.X });
    dbMock.dbRead.$queryRaw.mockResolvedValue([row]);
    const { images } = await getBlockGatedImagesByIds({
      imageIds: [PUBLISHED_ID],
      browsingLevel: SFW,
      appId: APP,
      userId: VIEWER,
    });
    expect(images).toEqual([{ imageId: PUBLISHED_ID, status: 'hidden' }]);
    expect(JSON.stringify(images)).not.toContain(row.url);
  });
});
