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

// An SFW app token (green/blue host): PG | PG13.
const SFW = blockOutputCeilingFromClaims({ maxBrowsingLevel: 1 | 2 });
// A mature app token (red host): PG through XXX.
const MATURE = blockOutputCeilingFromClaims({ maxBrowsingLevel: 1 | 2 | 4 | 8 | 16 });

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
      // Unrated: not restricted, and no rating to report.
      { url: 'https://cdn/m4.png' },
      { restricted: true, reason: 'pool' },
    ]);
    expect(snap.imageUrls).toStrictEqual([
      'https://cdn/m0.png',
      'https://cdn/m2.png',
      'https://cdn/m4.png',
    ]);
    const wire = JSON.stringify(snap);
    for (const id of ['m1', 'm3', 'm5']) expect(wire).not.toContain(`https://cdn/${id}.png`);
  });

  it('(f) a blocked or unavailable output is still dropped, and is not in outputs', () => {
    const snap = snapshotFromWorkflow(
      wf(
        [
          image('ok', 'pg'),
          image('blk', 'r', { blockedReason: 'MatureContent' }),
          image('pend', null, { available: false, url: null }),
        ],
        { allowMatureContent: false }
      ),
      MATURE
    );
    expect(snap.outputs).toStrictEqual([{ url: 'https://cdn/ok.png', nsfwLevel: 'pg' }]);
    expect(snap.imageUrls).toStrictEqual(['https://cdn/ok.png']);
    expect(JSON.stringify(snap)).not.toContain('https://cdn/blk.png');
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
    expect(after[0].output).toStrictEqual({ restricted: true, reason: 'pool' });
    // The convenience view DID shift — which is why it is not an index space.
    const view = (w: Parameters<typeof projectAppWorkflow>[0]) =>
      projectAppWorkflow(w, MATURE).images.map((i) => i.url);
    expect(view(wf([image('l0', null), image('l1', 'pg')], { allowMatureContent: false }))[1]).toBe(
      'https://cdn/l1.png'
    );
    expect(view(wf([image('l0', 'r'), image('l1', 'pg')], { allowMatureContent: false }))[0]).toBe(
      'https://cdn/l1.png'
    );
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

  it("treats null and 'na' as unrated — a url and no rating", () => {
    for (const rating of [null, 'na', '']) {
      expect(classifyBlockOutput(media(rating), { allowMatureContent: false }, SFW)).toStrictEqual({
        url: 'https://cdn/c.png',
      });
    }
  });

  it('restricts above the token ceiling even when the workflow allows mature content', () => {
    const rOnly = blockOutputCeilingFromClaims({ maxBrowsingLevel: 1 | 2 | 4 });
    expect(classifyBlockOutput(media('x'), { allowMatureContent: true }, rOnly)).toStrictEqual({
      restricted: true,
      reason: 'ceiling',
    });
    expect(classifyBlockOutput(media('r'), { allowMatureContent: true }, rOnly)).toStrictEqual({
      url: 'https://cdn/c.png',
      nsfwLevel: 'r',
    });
  });

  it('fails closed to SFW for a token with no numeric ceiling', () => {
    expect(blockOutputCeilingFromClaims({})).toStrictEqual({ maxBrowsingLevel: 3 });
    expect(blockOutputCeilingFromClaims({ maxBrowsingLevel: Number.NaN })).toStrictEqual({
      maxBrowsingLevel: 3,
    });
  });
});
