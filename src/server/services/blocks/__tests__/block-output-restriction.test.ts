import { describe, expect, it } from 'vitest';
import {
  BLOCK_STEP_NAME,
  projectAppWorkflow,
  projectAppWorkflowWithPositions,
  snapshotFromWorkflow,
  WORKFLOW_METADATA_BLOCK_STEPS_KEY,
} from '~/server/services/blocks/workflow.service';
import {
  blockOutputCeilingFromClaims,
  classifyBlockOutput,
} from '~/server/services/blocks/block-output-restriction';

/**
 * Restricted outputs: an output the orchestrator will not serve to this app (mature
 * content refused by the workflow, or above the app token's ceiling) reaches the app as
 * `{ restricted: true, reason }` in `outputs`, and its url reaches the app NOWHERE —
 * not `imageUrls`, not `steps[].imageUrls`, not `AppWorkflow.images`, not
 * `model3dOutputs`.
 *
 * Every url below is distinct, and a restricted one is asserted absent from the whole
 * serialised reply, so a url leaking through any field fails the test.
 */

// A viewer whose own browsing level allows every level, so the token's domain ceiling
// alone decides (the ceiling is the domain ceiling intersected with the viewer's level).
const ANY_VIEWER = 1 | 2 | 4 | 8 | 16;
// An SFW app token (green/blue host): PG | PG13.
const SFW = {
  ...blockOutputCeilingFromClaims({ maxBrowsingLevel: 1 | 2, viewerBrowsingLevel: ANY_VIEWER }),
  serving: false,
  mint: null,
};
// A mature app token (red host): PG through XXX.
const MATURE = {
  ...blockOutputCeilingFromClaims({
    maxBrowsingLevel: 1 | 2 | 4 | 8 | 16,
    viewerBrowsingLevel: ANY_VIEWER,
  }),
  serving: false,
  mint: null,
};

function image(id: string, nsfwLevel: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    type: 'image',
    url: `https://cdn/${id}.png`,
    available: true,
    width: 512,
    height: 768,
    ...(nsfwLevel === null ? {} : { nsfwLevel }),
    ...over,
  };
}

function wf(
  images: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {}
): Parameters<typeof snapshotFromWorkflow>[0] {
  return {
    id: 'wf_r',
    createdAt: '2026-11-14T00:00:00.000Z',
    status: 'succeeded',
    // Just finished, so an unrated output is still inside the rating hold
    // (`isRatingHoldExpired`; its deadline is pinned in rating-hold-compat.test.ts).
    completedAt: new Date().toISOString(),
    metadata: {},
    tags: [],
    cost: { total: 8 },
    steps: [
      { $type: 'textToImage', name: 's1', status: 'succeeded', metadata: {}, output: { images } },
    ],
    ...over,
  } as never;
}

describe('restricted outputs — snapshotFromWorkflow', () => {
  it('(a) SFW app: an R output is restricted for the CEILING, has no url, and is not in imageUrls', () => {
    // The site sends `allowMatureContent: false` for an SFW app.
    const snap = snapshotFromWorkflow(wf([image('r1', 'r')], { allowMatureContent: false }), SFW);
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'ceiling' }]);
    expect(snap).not.toHaveProperty('imageUrls');
    expect(JSON.stringify(snap)).not.toContain('https://cdn/r1.png');
  });

  it('(a) SFW app: still CEILING when the workflow never carried allowMatureContent', () => {
    const snap = snapshotFromWorkflow(wf([image('r1', 'r')]), SFW);
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'ceiling' }]);
    expect(snap).not.toHaveProperty('imageUrls');
  });

  it('(b) mature app, allowMatureContent:false from the paying pool: an R output is restricted for the POOL', () => {
    const snap = snapshotFromWorkflow(
      wf([image('r1', 'r')], { allowMatureContent: false }),
      MATURE
    );
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'pool' }]);
    expect(snap).not.toHaveProperty('imageUrls');
    expect(JSON.stringify(snap)).not.toContain('https://cdn/r1.png');
  });

  it('(c) mature app, mature allowed: an R output is { url, nsfwLevel: r }', () => {
    for (const allowMatureContent of [true, undefined, null]) {
      const snap = snapshotFromWorkflow(wf([image('r1', 'r')], { allowMatureContent }), MATURE);
      expect(snap.outputs).toStrictEqual([{ url: 'https://cdn/r1.png', nsfwLevel: 'r' }]);
      expect(snap.imageUrls).toStrictEqual(['https://cdn/r1.png']);
    }
  });

  it('(d) a PG output on a restricted workflow is a normal { url, nsfwLevel }', () => {
    for (const ceiling of [SFW, MATURE]) {
      const snap = snapshotFromWorkflow(
        wf([image('p1', 'pg'), image('p2', 'pg13')], { allowMatureContent: false }),
        ceiling
      );
      expect(snap.outputs).toStrictEqual([
        { url: 'https://cdn/p1.png', nsfwLevel: 'pg' },
        { url: 'https://cdn/p2.png', nsfwLevel: 'pg13' },
      ]);
      expect(snap.imageUrls).toStrictEqual(['https://cdn/p1.png', 'https://cdn/p2.png']);
    }
  });

  it('(e) a mix keeps every position in outputs; imageUrls holds only the unrestricted, in order', () => {
    const snap = snapshotFromWorkflow(
      wf(
        [
          image('m0', 'pg'),
          image('m1', 'r'),
          image('m2', 'pg13'),
          image('m3', 'xxx'),
          image('m4', null),
          image('m5', 'x'),
        ],
        { allowMatureContent: false }
      ),
      MATURE
    );
    expect(snap.outputs).toStrictEqual([
      { url: 'https://cdn/m0.png', nsfwLevel: 'pg' },
      { restricted: true, reason: 'pool' },
      { url: 'https://cdn/m2.png', nsfwLevel: 'pg13' },
      { restricted: true, reason: 'pool' },
      // Unrated on a workflow that refused mature content: HELD, no url, no rating.
      { pending: true },
      { restricted: true, reason: 'pool' },
    ]);
    expect(snap.imageUrls).toStrictEqual(['https://cdn/m0.png', 'https://cdn/m2.png']);
    expect(snap.ratingPending).toBe(true);
    const wire = JSON.stringify(snap);
    for (const id of ['m1', 'm3', 'm4', 'm5']) expect(wire).not.toContain(`https://cdn/${id}.png`);
  });

  it('(f) a BLOCKED output keeps its position with no url; an unavailable one is still dropped', () => {
    const snap = snapshotFromWorkflow(
      wf(
        [
          image('ok', 'pg'),
          // A maturity block reads as restricted, for the ceiling.
          image('blk', 'r', { blockedReason: 'MatureContent' }),
          // Any other block (moderation) is `{ blocked: true }`.
          image('mod', 'pg', { blockedReason: 'Potentially ToS violating content detected' }),
          // A videoGen-style block: available, url present — still blocked.
          image('mod2', null, { available: false, url: null, blockedReason: 'CSAM' }),
          image('pend', null, { available: false, url: null }),
          image('ok2', 'pg13'),
        ],
        { allowMatureContent: false }
      ),
      MATURE
    );
    expect(snap.outputs).toStrictEqual([
      { url: 'https://cdn/ok.png', nsfwLevel: 'pg' },
      { restricted: true, reason: 'ceiling' },
      { blocked: true },
      { blocked: true },
      { url: 'https://cdn/ok2.png', nsfwLevel: 'pg13' },
    ]);
    expect(snap.imageUrls).toStrictEqual(['https://cdn/ok.png', 'https://cdn/ok2.png']);
    const wire = JSON.stringify(snap);
    for (const id of ['blk', 'mod', 'pend']) expect(wire).not.toContain(`https://cdn/${id}.png`);
  });

  it('(f) a late block never moves a position', () => {
    const outputsOf = (blockedReason?: string) =>
      projectAppWorkflowWithPositions(
        wf([image('b0', 'pg', blockedReason ? { blockedReason } : {}), image('b1', 'pg')]),
        MATURE
      ).positions;
    expect(outputsOf()[1].image.url).toBe('https://cdn/b1.png');
    expect(outputsOf('Moderated')[1].image.url).toBe('https://cdn/b1.png');
    expect(outputsOf('Moderated')[0].output).toStrictEqual({ blocked: true });
  });

  it('(g) an R VIDEO on a restricted workflow is restricted with no url', () => {
    const video = wf([], {
      allowMatureContent: false,
      steps: [
        {
          $type: 'videoGen',
          name: BLOCK_STEP_NAME,
          status: 'succeeded',
          metadata: {},
          output: {
            video: {
              id: 'v1',
              type: 'video',
              available: true,
              url: 'https://cdn/v1.mp4',
              nsfwLevel: 'r',
            },
          },
        },
      ],
    });
    for (const [ceiling, reason] of [
      [MATURE, 'pool'],
      [SFW, 'ceiling'],
    ] as const) {
      const snap = snapshotFromWorkflow(video, ceiling);
      expect(snap.outputs).toStrictEqual([{ restricted: true, reason }]);
      expect(snap).not.toHaveProperty('imageUrls');
      expect(JSON.stringify(snap)).not.toContain('https://cdn/v1.mp4');
      const projected = projectAppWorkflow(video, ceiling);
      expect(projected.images).toStrictEqual([]);
      expect(JSON.stringify(projected)).not.toContain('https://cdn/v1.mp4');
    }
  });

  it('mirrors the rule on steps[] for a kind:workflow submit, and on the union', () => {
    const snap = snapshotFromWorkflow(
      wf([], {
        allowMatureContent: false,
        metadata: { [WORKFLOW_METADATA_BLOCK_STEPS_KEY]: [{ name: 'gen' }] },
        steps: [
          {
            $type: 'imageGen',
            name: 'gen',
            status: 'succeeded',
            output: { images: [image('w0', 'r'), image('w1', 'pg')] },
          },
        ],
      }),
      MATURE
    );
    expect(snap.steps).toStrictEqual([
      {
        name: 'gen',
        $type: 'imageGen',
        status: 'succeeded',
        imageUrls: ['https://cdn/w1.png'],
        outputs: [
          { restricted: true, reason: 'pool' },
          { url: 'https://cdn/w1.png', nsfwLevel: 'pg' },
        ],
      },
    ]);
    expect(snap.imageUrls).toStrictEqual(['https://cdn/w1.png']);
    expect(snap.outputs).toStrictEqual([
      { restricted: true, reason: 'pool' },
      { url: 'https://cdn/w1.png', nsfwLevel: 'pg' },
    ]);
    expect(JSON.stringify(snap)).not.toContain('https://cdn/w0.png');
  });

  it('withholds a restricted 3D model from model3dOutputs too', () => {
    const model = (id: string, nsfwLevel: string) => ({
      id,
      type: 'model3d',
      url: `https://cdn/${id}.glb`,
      available: true,
      format: 'glb',
      nsfwLevel,
    });
    const workflow = wf([], {
      allowMatureContent: false,
      steps: [
        {
          $type: 'meshGen',
          name: BLOCK_STEP_NAME,
          status: 'succeeded',
          output: { model: model('g0', 'r'), riggedModel: model('g1', 'pg') },
        },
      ],
    });
    const snap = snapshotFromWorkflow(workflow, MATURE);
    expect(snap.imageUrls).toStrictEqual(['https://cdn/g1.glb']);
    expect(snap.model3dOutputs?.map((m) => m.url)).toStrictEqual(['https://cdn/g1.glb']);
    expect(JSON.stringify(snap)).not.toContain('https://cdn/g0.glb');
    const projected = projectAppWorkflow(workflow, MATURE);
    expect(projected.model3dOutputs?.map((m) => m.url)).toStrictEqual(['https://cdn/g1.glb']);
    expect(JSON.stringify(projected)).not.toContain('https://cdn/g0.glb');
  });

  it('never forwards allowMatureContent, transactions or the workflow nsfwLevel', () => {
    const snap = snapshotFromWorkflow(
      wf([image('r1', 'r')], {
        allowMatureContent: false,
        nsfwLevel: 'pg13',
        transactions: { list: [{ type: 'debit', accountType: 'blue', amount: 8 }] },
      }),
      MATURE
    );
    expect(snap).not.toHaveProperty('allowMatureContent');
    expect(snap).not.toHaveProperty('transactions');
    expect(snap).not.toHaveProperty('nsfwLevel');
  });

  it('omits outputs when the workflow has no available output', () => {
    expect(snapshotFromWorkflow(wf([]), MATURE)).not.toHaveProperty('outputs');
  });
});

describe('(h) restricted outputs — projectAppWorkflow', () => {
  it('applies the same rule: images holds the unrestricted only, outputs keeps positions', () => {
    const projected = projectAppWorkflow(
      wf([image('q0', 'pg'), image('q1', 'r'), image('q2', 'pg13')], {
        allowMatureContent: false,
      }),
      MATURE
    );
    expect(projected).toStrictEqual({
      workflowId: 'wf_r',
      status: 'succeeded',
      images: [
        { url: 'https://cdn/q0.png', width: 512, height: 768, nsfwLevel: 1 },
        { url: 'https://cdn/q2.png', width: 512, height: 768, nsfwLevel: 2 },
      ],
      cost: 8,
      createdAt: '2026-11-14T00:00:00.000Z',
      outputs: [
        { url: 'https://cdn/q0.png', nsfwLevel: 'pg' },
        { restricted: true, reason: 'pool' },
        { url: 'https://cdn/q2.png', nsfwLevel: 'pg13' },
      ],
    });
  });

  it('SFW app: R is restricted for the ceiling', () => {
    const projected = projectAppWorkflow(wf([image('q1', 'r')]), SFW);
    expect(projected.images).toStrictEqual([]);
    expect(projected.outputs).toStrictEqual([{ restricted: true, reason: 'ceiling' }]);
    expect(JSON.stringify(projected)).not.toContain('https://cdn/q1.png');
  });

  it('mature allowed: R is a normal image', () => {
    const projected = projectAppWorkflow(
      wf([image('q1', 'r')], { allowMatureContent: true }),
      MATURE
    );
    expect(projected.images).toStrictEqual([
      { url: 'https://cdn/q1.png', width: 512, height: 768, nsfwLevel: 4 },
    ]);
    expect(projected.outputs).toStrictEqual([{ url: 'https://cdn/q1.png', nsfwLevel: 'r' }]);
  });

  it('images is index-aligned with the snapshot imageUrls under the same ceiling', () => {
    const workflow = wf(
      [image('i0', 'r'), image('i1', 'pg'), image('i2', 'x'), image('i3', 'pg13')],
      { allowMatureContent: false }
    );
    for (const ceiling of [SFW, MATURE]) {
      expect(projectAppWorkflow(workflow, ceiling).images.map((i) => i.url)).toStrictEqual(
        snapshotFromWorkflow(workflow, ceiling).imageUrls
      );
    }
  });
});

describe('🔴 F1 — unrated outputs are held, at every level', () => {
  it('ratingPending is set on the snapshot, the step and the listing while any output is held', () => {
    const workflow = wf([], {
      metadata: { [WORKFLOW_METADATA_BLOCK_STEPS_KEY]: [{ name: 'gen' }] },
      steps: [
        {
          $type: 'imageGen',
          name: 'gen',
          status: 'succeeded',
          output: { images: [image('u0', null), image('u1', 'pg')] },
        },
      ],
    });
    const snap = snapshotFromWorkflow(workflow, SFW);
    expect(snap.outputs).toStrictEqual([
      { pending: true },
      { url: 'https://cdn/u1.png', nsfwLevel: 'pg' },
    ]);
    expect(snap.ratingPending).toBe(true);
    expect(snap.steps?.[0].ratingPending).toBe(true);
    expect(snap.imageUrls).toStrictEqual(['https://cdn/u1.png']);
    expect(JSON.stringify(snap)).not.toContain('https://cdn/u0.png');
    const listed = projectAppWorkflow(workflow, SFW);
    expect(listed.ratingPending).toBe(true);
    expect(listed.images.map((i) => i.url)).toStrictEqual(['https://cdn/u1.png']);
    expect(JSON.stringify(listed)).not.toContain('https://cdn/u0.png');
  });

  it('ratingPending is OMITTED once every output is rated', () => {
    const snap = snapshotFromWorkflow(wf([image('r0', 'pg')]), SFW);
    expect(snap).not.toHaveProperty('ratingPending');
  });

  it('an imageResourceTraining sample (a plain string, NEVER rated) fails closed as unrated on an SFW token', () => {
    const training = wf([], {
      steps: [
        {
          $type: 'imageResourceTraining',
          name: BLOCK_STEP_NAME,
          status: 'succeeded',
          output: {
            moderationStatus: 'approved',
            epochs: [{ epochNumber: 1, sampleImages: ['https://cdn/sample.png'] }],
          },
        },
      ],
    });
    const snap = snapshotFromWorkflow(training, SFW);
    // Terminal, not a hold: no rating will ever come, so no ratingPending either.
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'unrated' }]);
    expect(snap).not.toHaveProperty('ratingPending');
    expect(JSON.stringify(snap)).not.toContain('sample.png');
    expect(snapshotFromWorkflow(training, MATURE).outputs).toStrictEqual([
      { url: 'https://cdn/sample.png' },
    ]);
  });
});

describe('🔴 F2 — a 3D mesh takes its thumbnail / preview rating', () => {
  const mesh = (id: string, format = 'glb') => ({
    id,
    type: 'model3d',
    url: `https://cdn/${id}.${format}`,
    available: true,
    format,
    nsfwLevel: null,
  });
  /** The realistic polyGen shape: every mesh unrated, the auto-thumbnail rated. */
  const polyGen = (thumbnailRating: string | null, extraSteps: unknown[] = []) =>
    wf([], {
      steps: [
        {
          $type: 'polyGen',
          name: BLOCK_STEP_NAME,
          status: 'succeeded',
          output: {
            model: mesh('m-model'),
            fbxModel: mesh('m-fbx', 'fbx'),
            riggedModel: mesh('m-rigged'),
            riggedFbxModel: mesh('m-rigged-fbx', 'fbx'),
            animatedModel: mesh('m-anim'),
            basicAnimations: { walkingModel: mesh('m-walk'), runningModel: mesh('m-run') },
            thumbnail: image('thumb', thumbnailRating),
          },
        },
        ...extraSteps,
      ],
    });
  const MESH_URLS = [
    'm-model.glb',
    'm-fbx.fbx',
    'm-rigged.glb',
    'm-rigged-fbx.fbx',
    'm-anim.glb',
    'm-walk.glb',
    'm-run.glb',
  ];

  it("a null-rated mesh with an 'x' thumbnail on an SFW token: every mesh url is withheld", () => {
    const snap = snapshotFromWorkflow(polyGen('x'), SFW);
    expect(snap.outputs).toHaveLength(8);
    expect(snap.outputs!.every((o) => 'restricted' in o)).toBe(true);
    expect(snap).not.toHaveProperty('imageUrls');
    expect(snap).not.toHaveProperty('model3dOutputs');
    const listed = projectAppWorkflow(polyGen('x'), SFW);
    expect(listed.images).toStrictEqual([]);
    for (const reply of [JSON.stringify(snap), JSON.stringify(listed)]) {
      for (const url of MESH_URLS) expect(reply).not.toContain(url);
    }
  });

  it('the mesh carries the thumbnail rating as its own on a mature token', () => {
    const snap = snapshotFromWorkflow(polyGen('x'), MATURE);
    expect(snap.outputs!.slice(0, 7)).toStrictEqual(
      MESH_URLS.map((u) => ({ url: `https://cdn/${u}`, nsfwLevel: 'x' }))
    );
  });

  it("a workflow's model3DPreview render rating reaches the mesh too", () => {
    const preview = {
      $type: 'model3DPreview',
      name: 'preview',
      status: 'succeeded',
      output: { images: [image('pv', 'xxx')] },
    };
    const snap = snapshotFromWorkflow(polyGen('pg', [preview]), MATURE);
    expect(snap.outputs![0]).toStrictEqual({ url: 'https://cdn/m-model.glb', nsfwLevel: 'xxx' });
    expect(projectAppWorkflow(polyGen('pg', [preview]), MATURE).outputs![0]).toStrictEqual({
      url: 'https://cdn/m-model.glb',
      nsfwLevel: 'xxx',
    });
  });

  it('no rating source yet: every mesh is held on an SFW token', () => {
    const snap = snapshotFromWorkflow(polyGen(null), SFW);
    expect(snap.outputs!.every((o) => 'pending' in o)).toBe(true);
    expect(snap.ratingPending).toBe(true);
    for (const url of MESH_URLS) expect(JSON.stringify(snap)).not.toContain(url);
  });
});

describe('🔴 round 2 — a mesh is rated only when EVERY rating source has rated', () => {
  const mesh = (id: string) => ({
    id,
    type: 'model3d',
    url: `https://cdn/${id}.glb`,
    available: true,
    format: 'glb',
    nsfwLevel: null,
  });
  /** One mesh, a pg13 thumbnail (or none), and an optional model3DPreview step. */
  const withPreview = (opts: {
    thumbnail?: string | null | 'absent';
    preview?: { status: string; images: Array<string | null> } | 'absent';
    stepStatus?: string;
  }) =>
    wf([], {
      steps: [
        {
          $type: 'polyGen',
          name: BLOCK_STEP_NAME,
          status: opts.stepStatus ?? 'succeeded',
          output: {
            model: mesh('rm'),
            ...(opts.thumbnail === 'absent'
              ? {}
              : { thumbnail: image('rt', opts.thumbnail === undefined ? 'pg13' : opts.thumbnail) }),
          },
        },
        ...(opts.preview === 'absent' || opts.preview === undefined
          ? []
          : [
              {
                $type: 'model3DPreview',
                name: 'preview',
                status: opts.preview.status,
                output: {
                  images: opts.preview.images.map((r, i) => image(`rp${i}`, r)),
                },
              },
            ]),
      ],
    });
  const meshOutput = (workflow: Parameters<typeof snapshotFromWorkflow>[0]) =>
    snapshotFromWorkflow(workflow, SFW).outputs![0];

  it('a pg13 thumbnail with the preview step STILL RUNNING is pending', () => {
    expect(
      meshOutput(withPreview({ preview: { status: 'processing', images: [] } }))
    ).toStrictEqual({
      pending: true,
    });
  });

  it('a pg13 thumbnail with a preview image UNRATED is pending', () => {
    expect(
      meshOutput(withPreview({ preview: { status: 'succeeded', images: ['pg', null] } }))
    ).toStrictEqual({ pending: true });
  });

  it('a pg13 thumbnail with the preview rated x is restricted', () => {
    expect(
      meshOutput(withPreview({ preview: { status: 'succeeded', images: ['pg', 'x'] } }))
    ).toStrictEqual({ restricted: true, reason: 'ceiling' });
  });

  it('every source rated (pg13 thumbnail, pg preview) hands out the url at the max rating', () => {
    expect(
      meshOutput(withPreview({ preview: { status: 'succeeded', images: ['pg'] } }))
    ).toStrictEqual({ url: 'https://cdn/rm.glb', nsfwLevel: 'pg13' });
  });

  it('a declared thumbnail with no rating yet is pending, even with the preview rated', () => {
    expect(
      meshOutput(withPreview({ thumbnail: null, preview: { status: 'succeeded', images: ['pg'] } }))
    ).toStrictEqual({ pending: true });
  });

  it('no thumbnail and no preview on a FINISHED step fails closed as unrated', () => {
    const snap = snapshotFromWorkflow(withPreview({ thumbnail: 'absent' }), SFW);
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'unrated' }]);
    expect(snap).not.toHaveProperty('ratingPending');
    expect(JSON.stringify(snap)).not.toContain('rm.glb');
  });

  it('no source yet while the step is still running is pending', () => {
    expect(
      meshOutput(withPreview({ thumbnail: 'absent', stepStatus: 'processing' }))
    ).toStrictEqual({
      pending: true,
    });
  });

  it('no source on a mature token with nothing restricting it keeps the url', () => {
    expect(
      snapshotFromWorkflow(withPreview({ thumbnail: 'absent' }), MATURE).outputs
    ).toStrictEqual([{ url: 'https://cdn/rm.glb' }]);
  });

  it('the listing applies the same rule', () => {
    const running = withPreview({ preview: { status: 'processing', images: [] } });
    expect(projectAppWorkflow(running, SFW).outputs![0]).toStrictEqual({ pending: true });
    expect(JSON.stringify(projectAppWorkflow(running, SFW))).not.toContain('rm.glb');
  });
});

describe('🔴 round 3 — a never-rated video engine is never delivered unscanned', () => {
  /** A pass-through `{ kind:'step', $type:'videoGen', input }` as the orchestrator echoes it. */
  const videoGen = (engine: string, nsfwLevel?: string) =>
    wf([], {
      steps: [
        {
          $type: 'videoGen',
          name: BLOCK_STEP_NAME,
          status: 'succeeded',
          input: { engine, prompt: 'a lighthouse at dusk' },
          output: {
            video: {
              id: 'v',
              type: 'video',
              available: true,
              url: 'https://cdn/v.mp4',
              ...(nsfwLevel ? { nsfwLevel } : {}),
            },
          },
        },
      ],
    });

  it.each(['kling', 'kling-v3', 'veo3', 'vidu-q4', 'grok', 'gemini-omni'])(
    '%s: an UNRATED video is restricted as unrated on an SFW token, with no url',
    (engine) => {
      const snap = snapshotFromWorkflow(videoGen(engine), SFW);
      expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'unrated' }]);
      expect(JSON.stringify(snap)).not.toContain('v.mp4');
      expect(projectAppWorkflow(videoGen(engine), SFW).outputs).toStrictEqual([
        { restricted: true, reason: 'unrated' },
      ]);
    }
  );

  it('a rating that DOES arrive still meets the ceiling: veo3 rated x is restricted', () => {
    const snap = snapshotFromWorkflow(videoGen('veo3', 'x'), SFW);
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'ceiling' }]);
    expect(JSON.stringify(snap)).not.toContain('v.mp4');
  });

  it('a rated engine not on the list (gemini, not gemini-omni) is HELD while unrated', () => {
    const snap = snapshotFromWorkflow(videoGen('gemini'), SFW);
    expect(snap.outputs).toStrictEqual([{ pending: true }]);
    expect(snap.ratingPending).toBe(true);
    expect(JSON.stringify(snap)).not.toContain('v.mp4');
  });

  it('another rated engine (wan) is held too', () => {
    expect(snapshotFromWorkflow(videoGen('wan'), SFW).outputs).toStrictEqual([{ pending: true }]);
  });
});

describe('🔴 round 4 — never-rated delivery is gated on exactly what it claims', () => {
  /** A bridge-submitted step, as the orchestrator echoes it, with any `$type` / `input`. */
  const step = (
    $type: string,
    input: Record<string, unknown>,
    output: Record<string, unknown>,
    over: Record<string, unknown> = {}
  ) =>
    wf([], {
      steps: [{ $type, name: BLOCK_STEP_NAME, status: 'succeeded', input, output }],
      ...over,
    });
  const video = { id: 'tv', type: 'video', available: true, url: 'https://cdn/tv.mp4' };

  it.each([
    ['a re-cased twin beside the engine', { engine: 'kling', Engine: 'wan' }],
    // INVARIANT GUARD, not regression coverage: with no `engine` key at all the step was
    // already held before the twin refusal existed (it passed at base, and it stays green
    // with that refusal deleted). Only the twin-beside case above pins the refusal.
    ['(invariant guard) a re-cased engine key alone', { Engine: 'kling' }],
  ])('%s: the engine is unknown, so the unrated video is HELD on an SFW token', (_label, input) => {
    const snap = snapshotFromWorkflow(step('videoGen', input, { video }), SFW);
    expect(snap.outputs).toStrictEqual([{ pending: true }]);
    expect(JSON.stringify(snap)).not.toContain('tv.mp4');
  });

  it('only a VIDEO is delivered: an unrated image from a kling videoGen step is held', () => {
    const snap = snapshotFromWorkflow(
      step('videoGen', { engine: 'kling' }, { images: [image('ki', null)] }),
      SFW
    );
    expect(snap.outputs).toStrictEqual([{ pending: true }]);
    expect(JSON.stringify(snap)).not.toContain('ki.png');
  });

  it('only a videoGen step is delivered: another $type naming engine kling is held', () => {
    const snap = snapshotFromWorkflow(step('videoUpscaler', { engine: 'kling' }, { video }), SFW);
    expect(snap.outputs).toStrictEqual([{ pending: true }]);
  });

  it('the site ecosystem rule alone restricts: a rated engine (wan) under ecosystem Kling', () => {
    const snap = snapshotFromWorkflow(
      step(
        'videoGen',
        { engine: 'wan' },
        { video },
        { metadata: { params: { ecosystem: 'Kling' } } }
      ),
      SFW
    );
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'unrated' }]);
    // CONTROL: the same step without the ecosystem is held.
    expect(
      snapshotFromWorkflow(step('videoGen', { engine: 'wan' }, { video }), SFW).outputs
    ).toStrictEqual([{ pending: true }]);
  });

  it.each(['na', 'NA', ' Na '])(
    "a mesh's own %j gives way to a source value it does not know, which fails closed",
    (own) => {
      const snap = snapshotFromWorkflow(
        step(
          'polyGen',
          {},
          {
            model: {
              id: 'wm',
              type: 'model3d',
              url: 'https://cdn/wm.glb',
              available: true,
              format: 'glb',
              nsfwLevel: own,
            },
            thumbnail: image('wt', 'weird'),
          }
        ),
        MATURE
      );
      expect(snap.outputs![0]).toStrictEqual({ restricted: true, reason: 'ceiling' });
      expect(JSON.stringify(snap)).not.toContain('wm.glb');
    }
  );
});

describe("round 3 — a mesh whose sources read 'na' is delivered", () => {
  const mesh = {
    id: 'nm',
    type: 'model3d',
    url: 'https://cdn/nm.glb',
    available: true,
    format: 'glb',
    nsfwLevel: null,
  };
  const meshWith = (thumbnail: string, preview: string[]) =>
    wf([], {
      steps: [
        {
          $type: 'polyGen',
          name: BLOCK_STEP_NAME,
          status: 'succeeded',
          output: { model: mesh, thumbnail: image('nt', thumbnail) },
        },
        {
          $type: 'model3DPreview',
          name: 'preview',
          status: 'succeeded',
          output: { images: preview.map((r, i) => image(`np${i}`, r)) },
        },
      ],
    });

  it("every source 'na': the mesh gets 'na' — its url, no rating to report", () => {
    expect(snapshotFromWorkflow(meshWith('na', ['na']), SFW).outputs![0]).toStrictEqual({
      url: 'https://cdn/nm.glb',
    });
  });

  it("'na' mixed with real ratings: the real max wins", () => {
    expect(snapshotFromWorkflow(meshWith('na', ['pg13', 'na']), SFW).outputs![0]).toStrictEqual({
      url: 'https://cdn/nm.glb',
      nsfwLevel: 'pg13',
    });
    expect(snapshotFromWorkflow(meshWith('r', ['na']), SFW).outputs![0]).toStrictEqual({
      restricted: true,
      reason: 'ceiling',
    });
  });
});

describe('stable output positions — the index space of publish, post and persist', () => {
  it('a position per available output, restricted ones included, aligned with outputs', () => {
    const { workflow, positions } = projectAppWorkflowWithPositions(
      wf([image('p0', 'pg'), image('p1', 'r'), image('p2', 'pg13')], { allowMatureContent: false }),
      MATURE
    );
    expect(positions.map((p) => p.output)).toStrictEqual(workflow.outputs);
    expect(positions.map((p) => p.image.url)).toStrictEqual([
      'https://cdn/p0.png',
      'https://cdn/p1.png',
      'https://cdn/p2.png',
    ]);
  });

  it('(a) a rating that lands late never moves a position', () => {
    const before = projectAppWorkflowWithPositions(
      wf([image('l0', null), image('l1', 'pg')], { allowMatureContent: false }),
      MATURE
    ).positions;
    const after = projectAppWorkflowWithPositions(
      wf([image('l0', 'r'), image('l1', 'pg')], { allowMatureContent: false }),
      MATURE
    ).positions;
    expect(before[1].image.url).toBe('https://cdn/l1.png');
    expect(after[1].image.url).toBe('https://cdn/l1.png');
    // Held while unrated, restricted once rated: the same slot, never a url between.
    expect(before[0].output).toStrictEqual({ pending: true });
    expect(after[0].output).toStrictEqual({ restricted: true, reason: 'pool' });
  });
});

describe('classifyBlockOutput', () => {
  const media = (nsfwLevel: string | null) => ({ url: 'https://cdn/c.png', nsfwLevel });

  it('reads an output above the site-set workflow nsfwLevel cap as CEILING, not pool', () => {
    expect(
      classifyBlockOutput(media('r'), { allowMatureContent: false, nsfwLevel: 'pg13' }, MATURE)
    ).toStrictEqual({ restricted: true, reason: 'ceiling' });
  });

  it('fails CLOSED on a rating it does not know', () => {
    for (const rating of ['blocked', 'constructor', 'toString', 'R+']) {
      expect(classifyBlockOutput(media(rating), {}, MATURE)).toStrictEqual({
        restricted: true,
        reason: 'ceiling',
      });
    }
  });

  it("normalises the orchestrator's spellings to the five ratings", () => {
    const cases: Array<[string, string]> = [
      ['g', 'pg'],
      ['PG', 'pg'],
      ['pg-13', 'pg13'],
      ['XXX', 'xxx'],
    ];
    for (const [spelling, rating] of cases) {
      expect(classifyBlockOutput(media(spelling), {}, MATURE)).toStrictEqual({
        url: 'https://cdn/c.png',
        nsfwLevel: rating,
      });
    }
  });

  it("'na' is a verdict with no level — a url and no rating", () => {
    expect(classifyBlockOutput(media('na'), { allowMatureContent: false }, SFW)).toStrictEqual({
      url: 'https://cdn/c.png',
    });
  });

  // 🔴 F1 — an unrated output is HELD wherever its rating could still restrict it.
  it.each([
    ['an SFW ceiling', {}, SFW],
    [
      'a ceiling short of XXX',
      {},
      blockOutputCeilingFromClaims({
        maxBrowsingLevel: 1 | 2 | 4 | 8,
        viewerBrowsingLevel: ANY_VIEWER,
      }),
    ],
    ['allowMatureContent false', { allowMatureContent: false }, MATURE],
    ['an nsfwLevel cap below XXX', { nsfwLevel: 'pg13' }, MATURE],
    ['an unrecognised nsfwLevel cap', { nsfwLevel: 'weird' }, MATURE],
  ] as const)('holds an unrated output under %s', (_label, facts, ceiling) => {
    for (const rating of [null, '']) {
      expect(classifyBlockOutput(media(rating), facts as never, ceiling)).toStrictEqual({
        pending: true,
      });
    }
  });

  it('hands an unrated output its url at once when nothing could restrict it', () => {
    for (const facts of [{}, { allowMatureContent: true }, { nsfwLevel: 'xxx' }]) {
      expect(classifyBlockOutput(media(null), facts as never, MATURE)).toStrictEqual({
        url: 'https://cdn/c.png',
      });
    }
  });

  it('never holds what will never be rated: audio passes, a never-rated output fails closed', () => {
    expect(classifyBlockOutput({ ...media(null), type: 'audio' }, {}, SFW)).toStrictEqual({
      url: 'https://cdn/c.png',
    });
    expect(
      classifyBlockOutput({ ...media(null), type: 'video' }, {}, SFW, { neverRated: true })
    ).toStrictEqual({ restricted: true, reason: 'unrated' });
    // Where nothing could restrict it, a never-rated output keeps its url.
    expect(
      classifyBlockOutput({ ...media(null), type: 'video' }, {}, MATURE, { neverRated: true })
    ).toStrictEqual({ url: 'https://cdn/c.png' });
    // A rated engine's video IS held.
    expect(classifyBlockOutput({ ...media(null), type: 'video' }, {}, SFW)).toStrictEqual({
      pending: true,
    });
  });

  it('a 3D mesh with no propagated rating is held, whatever its format', () => {
    expect(classifyBlockOutput({ ...media(null), type: 'model3d' }, {}, SFW)).toStrictEqual({
      pending: true,
    });
  });

  it('a blocked output: MatureContent is restricted for the ceiling, anything else is blocked', () => {
    expect(
      classifyBlockOutput({ ...media('pg'), blockedReason: 'MatureContent' }, {}, MATURE)
    ).toStrictEqual({
      restricted: true,
      reason: 'ceiling',
    });
    expect(
      classifyBlockOutput({ ...media('pg'), blockedReason: 'Moderated' }, {}, MATURE)
    ).toStrictEqual({
      blocked: true,
    });
    expect(
      classifyBlockOutput({ ...media('pg'), blockedReason: 'none' }, {}, MATURE)
    ).toStrictEqual({
      url: 'https://cdn/c.png',
      nsfwLevel: 'pg',
    });
  });

  it('restricts above the token ceiling even when the workflow allows mature content', () => {
    const rOnly = blockOutputCeilingFromClaims({
      maxBrowsingLevel: 1 | 2 | 4,
      viewerBrowsingLevel: ANY_VIEWER,
    });
    expect(classifyBlockOutput(media('x'), { allowMatureContent: true }, rOnly)).toStrictEqual({
      restricted: true,
      reason: 'ceiling',
    });
    expect(classifyBlockOutput(media('r'), { allowMatureContent: true }, rOnly)).toStrictEqual({
      url: 'https://cdn/c.png',
      nsfwLevel: 'r',
    });
  });

  it('fails closed to PG for a token with no numeric ceiling', () => {
    expect(blockOutputCeilingFromClaims({})).toStrictEqual({ maxBrowsingLevel: 1 });
    expect(
      blockOutputCeilingFromClaims({
        maxBrowsingLevel: Number.NaN,
        viewerBrowsingLevel: ANY_VIEWER,
      })
    ).toStrictEqual({ maxBrowsingLevel: 3 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 The output ceiling is the VIEWER's level, as #8786 clamps the gated-image read:
// the token's domain ceiling intersected with its signed `viewerBrowsingLevel`. The
// levels are pairwise distinct: domain PG|PG13|R (7), a PG viewer (1), a PG+R viewer
// that skips PG13 (5), and a PG+R+X viewer (13), whose intersection with the domain (5)
// is neither the domain nor the viewer. A site that passes the domain ceiling alone
// gives 7; one that passes the viewer's level alone gives 13.
describe("🔴 the output ceiling is clamped to the viewer's own browsing level", () => {
  const DOMAIN_TO_R = 1 | 2 | 4;
  const r = { id: 'vr', type: 'image', url: 'https://cdn/vr.png', nsfwLevel: 'r' };
  const pg13 = { id: 'vp', type: 'image', url: 'https://cdn/vp.png', nsfwLevel: 'pg13' };
  const facts = { allowMatureContent: true };

  it('a PG viewer on a domain ceiling up to R: an R output is restricted ceiling', () => {
    const ceiling = blockOutputCeilingFromClaims({
      maxBrowsingLevel: DOMAIN_TO_R,
      viewerBrowsingLevel: 1,
    });
    expect(ceiling).toStrictEqual({ maxBrowsingLevel: 1 });
    expect(classifyBlockOutput(r, facts, ceiling)).toStrictEqual({
      restricted: true,
      reason: 'ceiling',
    });
  });

  it('the same R output, the viewer at PG+R: url; their PG13 output is restricted', () => {
    const ceiling = blockOutputCeilingFromClaims({
      maxBrowsingLevel: DOMAIN_TO_R,
      viewerBrowsingLevel: 1 | 4,
    });
    expect(ceiling).toStrictEqual({ maxBrowsingLevel: 5 });
    expect(classifyBlockOutput(r, facts, ceiling)).toStrictEqual({
      url: 'https://cdn/vr.png',
      nsfwLevel: 'r',
    });
    expect(classifyBlockOutput(pg13, facts, ceiling)).toStrictEqual({
      restricted: true,
      reason: 'ceiling',
    });
  });

  it('a viewer level wider than the domain is cut to the domain: 13 on 7 is 5', () => {
    expect(
      blockOutputCeilingFromClaims({
        maxBrowsingLevel: DOMAIN_TO_R,
        viewerBrowsingLevel: 1 | 4 | 8,
      })
    ).toStrictEqual({ maxBrowsingLevel: 5 });
  });

  it('a token without a viewer level reads PG', () => {
    const ceiling = blockOutputCeilingFromClaims({ maxBrowsingLevel: DOMAIN_TO_R });
    expect(ceiling).toStrictEqual({ maxBrowsingLevel: 1 });
    expect(classifyBlockOutput(r, facts, ceiling)).toStrictEqual({
      restricted: true,
      reason: 'ceiling',
    });
    expect(classifyBlockOutput(pg13, facts, ceiling)).toStrictEqual({
      restricted: true,
      reason: 'ceiling',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 PG-13 FLOOR (operator decision). For a SIGNED-IN viewer (`sub` is `user:<id>`) with a
// viewer level, the output ceiling is that level OR PG|PG-13, intersected with the
// domain ceiling: the site's generator shows a signed-in user their own PG-13
// generations whatever their NSFW setting. An anonymous viewer, and a token with no
// viewer level, keep PG. Real domain ceilings: green and blue are PG|PG-13 (3), red is
// every level (31). Outputs pg13 (2) and r (4); viewers PG (1) and PG+R (5).
describe('🔴 a signed-in viewer is never below PG-13', () => {
  const GREEN = 1 | 2;
  const BLUE = 1 | 2;
  const RED = 1 | 2 | 4 | 8 | 16;
  const SIGNED_IN = 'user:42';
  const pg13 = { id: 'fp', type: 'image', url: 'https://cdn/fp.png', nsfwLevel: 'pg13' };
  const r = { id: 'fr', type: 'image', url: 'https://cdn/fr.png', nsfwLevel: 'r' };
  const facts = { allowMatureContent: true };
  const ceilingOf = (claims: Parameters<typeof blockOutputCeilingFromClaims>[0]) =>
    blockOutputCeilingFromClaims(claims);

  it('a signed-in PG viewer on blue: the PG-13 output gets its url, the R one is ceiling', () => {
    const ceiling = ceilingOf({ sub: SIGNED_IN, maxBrowsingLevel: BLUE, viewerBrowsingLevel: 1 });
    expect(ceiling).toStrictEqual({ maxBrowsingLevel: 3 });
    expect(classifyBlockOutput(pg13, facts, ceiling)).toStrictEqual({
      url: 'https://cdn/fp.png',
      nsfwLevel: 'pg13',
    });
    expect(classifyBlockOutput(r, facts, ceiling)).toStrictEqual({
      restricted: true,
      reason: 'ceiling',
    });
  });

  it('a signed-in PG viewer on red gets PG|PG-13 (3), not PG and not the domain', () => {
    expect(
      ceilingOf({ sub: SIGNED_IN, maxBrowsingLevel: RED, viewerBrowsingLevel: 1 })
    ).toStrictEqual({ maxBrowsingLevel: 3 });
  });

  it('a signed-in PG+R viewer on red keeps R and gains PG-13: 7', () => {
    expect(
      ceilingOf({ sub: SIGNED_IN, maxBrowsingLevel: RED, viewerBrowsingLevel: 1 | 4 })
    ).toStrictEqual({ maxBrowsingLevel: 7 });
  });

  it.each([
    ['an anonymous viewer', { sub: 'anon', maxBrowsingLevel: RED, viewerBrowsingLevel: 1 }],
    ['a signed-in token without a viewer level', { sub: SIGNED_IN, maxBrowsingLevel: RED }],
    ['a token with no subject', { maxBrowsingLevel: RED, viewerBrowsingLevel: 1 }],
    ['a malformed subject', { sub: 'user:0042', maxBrowsingLevel: RED, viewerBrowsingLevel: 1 }],
    [
      'a signed-in token with an invalid viewer level',
      { sub: SIGNED_IN, maxBrowsingLevel: RED, viewerBrowsingLevel: -1 },
    ],
  ] as const)('%s keeps PG: the PG-13 output is restricted', (_label, claims) => {
    const ceiling = ceilingOf(claims);
    expect(ceiling).toStrictEqual({ maxBrowsingLevel: 1 });
    expect(classifyBlockOutput(pg13, facts, ceiling)).toStrictEqual({
      restricted: true,
      reason: 'ceiling',
    });
  });

  it('(invariant guard) green is unchanged: its viewer level is already PG|PG-13', () => {
    const ceiling = ceilingOf({ sub: SIGNED_IN, maxBrowsingLevel: GREEN, viewerBrowsingLevel: 3 });
    expect(ceiling).toStrictEqual({ maxBrowsingLevel: 3 });
    expect(classifyBlockOutput(r, facts, ceiling)).toStrictEqual({
      restricted: true,
      reason: 'ceiling',
    });
  });

  // INVARIANT GUARD (green at base too): it pins the INTERSECTION, so a floor applied
  // after the domain cut, rather than before it, fails here.
  it('(invariant guard) a floor that would exceed the domain is cut to it: a PG-only domain stays PG', () => {
    expect(
      ceilingOf({ sub: SIGNED_IN, maxBrowsingLevel: 1, viewerBrowsingLevel: 1 })
    ).toStrictEqual({ maxBrowsingLevel: 1 });
  });
});
