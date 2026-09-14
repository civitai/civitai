import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetHybridNodes } from '~/__tests__/mocks/hybrid';
import {
  BLOCK_POST_APP_ID_META_KEY,
  resolveAppPublishedImages,
  resolveBlockPostSources,
  resolveExistingPostTags,
  resolveGalleryTarget,
  resolveOwnedWorkflowOutputs,
  writeBlockPost,
} from '~/server/services/blocks/block-post.service';
import { BLOCK_POST_MAX_IMAGES } from '~/server/services/blocks/block-post.logic';

/**
 * The guard matrix for `blocks.createPostFromApp`'s server half. Every control
 * has a NEGATIVE case proving it REFUSES, and each refusal is asserted by its own
 * specific message — never merely "it threw".
 *
 * 🔴 WHY THE MESSAGE AND NOT JUST THE THROW. Several of these guards sit behind
 * one another (a published-image source runs ownership, provenance, `postId IS
 * NULL` and the maturity clamp; the gallery path runs five availability checks
 * before the self-dealing one). A test that asserts only "rejects" passes when an
 * EARLIER guard fires for an unrelated reason, so the guard it names may not have
 * executed at all. Asserting the message is what makes each case a claim about
 * the guard in its title. Where the production message is deliberately UNIFORM
 * across several causes (the existence-oracle refusals), the test says so and
 * pins the discriminator a different way.
 */

const OWNED_WORKFLOW = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/blocks/block-workflows.service', () => ({
  blockWorkflowOwnedByAppUser: OWNED_WORKFLOW,
}));

const APP_ID = 'appblk-alpha';
const PUBLISHER_USER_ID = 900;
const VIEWER_USER_ID = 42;
/** Public browsing flag bit used by the fixtures. Distinct from every id above. */
const BROWSING = 1;

const ACTOR = {
  userId: VIEWER_USER_ID,
  appId: APP_ID,
  appBlockId: 'apb_alpha',
  browsingLevel: BROWSING,
};

/** A row shaped like the raw `Image` SELECT, scanned-clean and within the ceiling. */
function imageRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7001,
    url: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    nsfwLevel: BROWSING,
    ingestion: 'Scanned',
    width: 512,
    height: 768,
    needsReview: null,
    poi: false,
    minor: false,
    tosViolation: false,
    acceptableMinor: false,
    blockedFor: null,
    ...over,
  };
}

async function expectRejection(p: Promise<unknown>, code: string, message: string) {
  await expect(p).rejects.toMatchObject({ code, message });
  await p.catch((e) => expect(e).toBeInstanceOf(TRPCError));
}

beforeEach(() => {
  // 🔴 The shared db mock is module-global and is NOT auto-reset between tests in
  // this project. Without this, `mock.calls[0]` reads the FIRST test's call and a
  // `not.toHaveBeenCalled()` assertion reads the whole file's history — both of
  // which produce confidently wrong verdicts rather than errors. Measured: eight
  // of these cases passed/failed for the wrong reason before it was added.
  resetHybridNodes();
  OWNED_WORKFLOW.mockReset();
  OWNED_WORKFLOW.mockResolvedValue(true);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveExistingPostTags — a block may NEVER mint a site tag', () => {
  it('resolves only names that already exist, and reports the rest as dropped', async () => {
    dbMock.dbRead.tag.findMany.mockResolvedValue([{ id: 11, name: 'anime' }]);

    const out = await resolveExistingPostTags(['Anime', 'a-tag-nobody-has-ever-used']);

    expect(out).toEqual({
      tagIds: [11],
      names: ['anime'],
      dropped: ['a-tag-nobody-has-ever-used'],
    });
  });

  it('NEVER writes: no create, createMany or upsert on any tag client', async () => {
    // THE control this whole function exists for. `findOrCreateTagsByName` — the
    // native path — would have called `dbWrite.tag.createMany` here.
    dbMock.dbRead.tag.findMany.mockResolvedValue([]);

    await resolveExistingPostTags(['brand-new-tag-name']);

    expect(dbMock.dbWrite.tag.createMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.tag.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.tag.upsert).not.toHaveBeenCalled();
  });

  it('queries with the exclusions that keep moderation/admin tags out of a block’s reach', async () => {
    dbMock.dbRead.tag.findMany.mockResolvedValue([]);
    await resolveExistingPostTags(['anything']);

    // Asserted on the QUERY rather than on a fixture, because the exclusion is
    // enforced by Postgres: a fixture-based test would have to trust the mock to
    // honour a `where` it is free to ignore, which proves nothing.
    const where = dbMock.dbRead.tag.findMany.mock.calls[0][0].where;
    expect(where.adminOnly).toBe(false);
    expect(where.type.in).toEqual(expect.arrayContaining(['UserGenerated', 'Label']));
    expect(where.type.in).not.toContain('Moderation');
    expect(where.type.in).not.toContain('System');
    expect(where.target.has).toBe('Post');
  });

  it('short-circuits with no query at all when nothing was requested', async () => {
    const out = await resolveExistingPostTags([]);
    expect(out).toEqual({ tagIds: [], names: [], dropped: [] });
    expect(dbMock.dbRead.tag.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveGalleryTarget', () => {
  const OTHER_OWNER = 555;

  function version(over: { model?: Record<string, unknown>; status?: string } = {}) {
    return {
      id: 3100,
      name: 'v1.5',
      status: 'Published',
      modelId: 800,
      model: {
        id: 800,
        name: 'Some Model',
        userId: OTHER_OWNER,
        status: 'Published',
        deletedAt: null,
        availability: 'Public',
        ...over.model,
      },
      ...(over.status ? { status: over.status } : {}),
    };
  }

  function call(over: Parameters<typeof resolveGalleryTarget>[0] | null = null) {
    return resolveGalleryTarget(
      over ?? { modelVersionId: 3100, posterUserId: VIEWER_USER_ID, appId: APP_ID }
    );
  }

  it('resolves a published, public, third-party model version', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(version());
    dbMock.dbRead.oauthClient.findUnique.mockResolvedValue({ userId: PUBLISHER_USER_ID });

    await expect(call()).resolves.toEqual({
      modelVersionId: 3100,
      modelId: 800,
      modelName: 'Some Model',
      versionName: 'v1.5',
    });
  });

  describe('🔴 THE SELF-DEALING GUARD — the one control that removes the payoff', () => {
    it('REFUSES a model owned by the calling app’s own publisher', async () => {
      // Everything else about this version is perfectly valid: published, public,
      // undeleted. The ONLY thing wrong is that the model owner IS the app
      // publisher — so no earlier check can take credit for this refusal.
      dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(
        version({ model: { userId: PUBLISHER_USER_ID } })
      );
      dbMock.dbRead.oauthClient.findUnique.mockResolvedValue({ userId: PUBLISHER_USER_ID });

      await expectRejection(
        call(),
        'FORBIDDEN',
        'this app may not attach posts to its own publisher’s models'
      );
    });

    it('ALLOWS the same request when the publisher differs by exactly one id', async () => {
      // The positive control for the guard above: identical fixture except the
      // publisher id. Without this, a mutant that refuses EVERY gallery attach
      // would pass the negative case.
      dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(
        version({ model: { userId: PUBLISHER_USER_ID + 1 } })
      );
      dbMock.dbRead.oauthClient.findUnique.mockResolvedValue({ userId: PUBLISHER_USER_ID });

      await expect(call()).resolves.toMatchObject({ modelVersionId: 3100 });
    });

    it('is NOT satisfied by the poster happening to own the model', async () => {
      // A viewer posting to their OWN model is legitimate (the reward's own
      // self-post guard handles it) and must not be confused with self-dealing.
      dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(
        version({ model: { userId: VIEWER_USER_ID } })
      );
      dbMock.dbRead.oauthClient.findUnique.mockResolvedValue({ userId: PUBLISHER_USER_ID });

      await expect(call()).resolves.toMatchObject({ modelVersionId: 3100 });
    });

    it('FAILS CLOSED when the publisher cannot be resolved at all', async () => {
      dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(version());
      dbMock.dbRead.oauthClient.findUnique.mockResolvedValue(null);

      await expectRejection(
        call(),
        'FORBIDDEN',
        'cannot verify app publisher for a gallery attach'
      );
    });
  });

  describe('availability — every one of these is an ADDITION over native, which checks none of them', () => {
    it.each([
      ['a nonexistent version', null],
      ['a DRAFT version', version({ status: 'Draft' })],
      ['a version whose MODEL is unpublished', version({ model: { status: 'Draft' } })],
      ['a DELETED model', version({ model: { deletedAt: new Date() } })],
      ['a PRIVATE model', version({ model: { availability: 'Private' } })],
    ])('refuses %s', async (_label, row) => {
      dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(row);
      dbMock.dbRead.oauthClient.findUnique.mockResolvedValue({ userId: PUBLISHER_USER_ID });

      // ⚠️ ONE UNIFORM MESSAGE ON PURPOSE — a per-cause message would turn this
      // endpoint into an oracle for "does version N exist / is it private". The
      // per-cause claim these rows make is therefore NOT carried by the message;
      // it is carried by each row differing from the passing fixture in exactly
      // one field, so a guard that stopped checking that field would let it through.
      await expectRejection(call(), 'BAD_REQUEST', 'gallery target is not available');
    });

    it('does not even look up the publisher when the version is unavailable', async () => {
      // Ordering claim: the availability checks run BEFORE the OauthClient read,
      // so an unavailable target costs no extra query.
      dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(null);
      await call().catch(() => undefined);
      expect(dbMock.dbRead.oauthClient.findUnique).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveAppPublishedImages', () => {
  function call(imageIds = [7001]) {
    return resolveAppPublishedImages({
      imageIds,
      userId: VIEWER_USER_ID,
      appId: APP_ID,
      browsingLevel: BROWSING,
    });
  }

  it('returns a host-resolved edge url — never the raw storage key', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([imageRow()]);
    const out = await call();

    expect(out).toHaveLength(1);
    expect(out[0].imageId).toBe(7001);
    // The RAW storage key never leaves the server. What comes back is an edge
    // transform of it, so the key appears only as a path segment inside a
    // width-clamped url — never as the whole value.
    expect(out[0].url).not.toBe(imageRow().url);
    expect(out[0].url).toContain('width=450');
  });

  it('REFUSES (does not silently skip) an id the scoped query did not return', async () => {
    // The query's own conjuncts — wrong owner, wrong app, already-posted,
    // nonexistent — all present as "no row". Refusing rather than skipping is what
    // keeps the consent thumbnails and the published set identical.
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);
    await expectRejection(call(), 'BAD_REQUEST', 'an image is not available to post');
  });

  it.each([
    ['still Pending a scan', { ingestion: 'Pending' }],
    ['scanned but unrated (nsfwLevel 0)', { nsfwLevel: 0 }],
    ['flagged needsReview', { needsReview: 'poi' }],
    ['flagged minor', { minor: true }],
    ['a TOS violation', { tosViolation: true }],
    ['hard-blocked', { blockedFor: 'csam' }],
    ['above the viewer’s ceiling', { nsfwLevel: BROWSING << 4 }],
  ])('refuses an image that is %s', async (_label, over) => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([imageRow(over)]);
    await expectRejection(call(), 'BAD_REQUEST', 'an image is not available to post');
  });

  it('scopes the SQL to owner + provenance marker + postId IS NULL', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([imageRow()]);
    await call();

    // The four conjuncts live in the SQL, so this asserts the SQL — and the two
    // VALUES they compare against are BOUND PARAMETERS, not literals, so they are
    // asserted from the tagged template's interpolations rather than its text. A
    // `toContain('blockPublishedAppId')` over the text alone reports a false
    // ABSENCE here for a marker that is very much being applied.
    const rawCall = dbMock.dbRead.$queryRaw.mock.calls[0];
    const sql = (rawCall[0] as string[]).join('?');
    const params = rawCall.slice(1);
    expect(sql).toContain('i."userId" = ');
    expect(sql).toContain('i."postId" IS NULL');
    expect(sql).toContain('i."metadata"->>(');
    expect(params).toContain(VIEWER_USER_ID);
    expect(params).toContain(BLOCK_POST_APP_ID_META_KEY);
    expect(params).toContain(APP_ID);
  });

  it('refuses a source carrying no usable ids at all', async () => {
    await expectRejection(call([]), 'BAD_REQUEST', 'no valid image ids in a published source');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveOwnedWorkflowOutputs', () => {
  const WORKFLOW_ID = 'wf_123';
  const taggedWorkflow = {
    status: 'succeeded',
    tags: [`app-block:${APP_ID}`],
    steps: [
      {
        $type: 'textToImage',
        output: {
          images: [
            {
              url: 'https://orchestration.civitai.com/v2/blobs/a.jpg',
              available: true,
              width: 1,
              height: 1,
            },
          ],
        },
      },
    ],
  };

  function call(getWorkflow: (id: string) => Promise<unknown>) {
    return resolveOwnedWorkflowOutputs({
      userId: VIEWER_USER_ID,
      appId: APP_ID,
      appBlockId: ACTOR.appBlockId,
      workflowId: WORKFLOW_ID,
      getWorkflow,
    });
  }

  it('REFUSES a workflow that is not in this app’s subqueue', async () => {
    OWNED_WORKFLOW.mockResolvedValue(false);
    const getWorkflow = vi.fn();

    await expectRejection(call(getWorkflow), 'FORBIDDEN', 'workflow is not in this app subqueue');
    // The ownership proof runs BEFORE any orchestrator call, so a rejected
    // workflow costs no outbound request.
    expect(getWorkflow).not.toHaveBeenCalled();
  });

  it('REFUSES a workflow the orchestrator does not tag for this app', async () => {
    // Ownership PASSES here — so this refusal can only come from the app-tag
    // check, which is the guard this case is about.
    OWNED_WORKFLOW.mockResolvedValue(true);
    const getWorkflow = vi
      .fn()
      .mockResolvedValue({ ...taggedWorkflow, tags: ['app-block:appblk-someone-else'] });

    await expectRejection(call(getWorkflow), 'FORBIDDEN', 'workflow is not tagged for this app');
  });

  it('accepts an owned + correctly-tagged workflow', async () => {
    const getWorkflow = vi.fn().mockResolvedValue(taggedWorkflow);
    await expect(call(getWorkflow)).resolves.toHaveLength(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 THE TERMINALITY GATE — the primary invariant behind the preview/write
  // consent guarantee. Preview and write resolve `sources` independently, so a
  // RUNNING workflow can gain an output between them and publish an image the
  // viewer was never shown. Every authorization check still passes; it is the
  // CONFIRM going wrong. Refusing a non-terminal source removes the race rather
  // than detecting it afterwards, and binds every caller including ones that
  // render no dialog.
  describe.each([
    ['pending', true],
    ['processing', true],
    ['succeeded', false],
    ['failed', false],
    ['expired', false],
    ['canceled', false],
  ] as const)('status %s', (status, shouldRefuse) => {
    it(
      shouldRefuse ? 'is REFUSED (still running)' : 'is admitted (output set is frozen)',
      async () => {
        const getWorkflow = vi.fn().mockResolvedValue({ ...taggedWorkflow, status });

        if (shouldRefuse) {
          await expectRejection(
            call(getWorkflow),
            'BAD_REQUEST',
            'workflow is still running — wait for it to finish before posting'
          );
        } else {
          await expect(call(getWorkflow)).resolves.toHaveLength(1);
        }
      }
    );
  });

  it('an UNRECOGNISED orchestrator status is refused — the gate fails CLOSED', async () => {
    // The orchestrator is an external system. A status this codebase has never
    // heard of must not fall through into "terminal"; a new non-terminal state
    // added upstream would otherwise silently re-open the race.
    const getWorkflow = vi
      .fn()
      .mockResolvedValue({ ...taggedWorkflow, status: 'someNewUpstreamState' });

    await expectRejection(
      call(getWorkflow),
      'BAD_REQUEST',
      'workflow is still running — wait for it to finish before posting'
    );
  });

  it('the terminality gate runs AFTER both ownership proofs, not instead of them', async () => {
    // Ordering matters for what a caller learns: a workflow it does not own must
    // get the ownership refusal, not a state refusal that would confirm the
    // workflow exists and is running.
    OWNED_WORKFLOW.mockResolvedValue(false);
    await expectRejection(
      call(vi.fn().mockResolvedValue({ ...taggedWorkflow, status: 'processing' })),
      'FORBIDDEN',
      'workflow is not in this app subqueue'
    );

    OWNED_WORKFLOW.mockResolvedValue(true);
    await expectRejection(
      call(
        vi.fn().mockResolvedValue({
          ...taggedWorkflow,
          status: 'processing',
          tags: ['app-block:appblk-someone-else'],
        })
      ),
      'FORBIDDEN',
      'workflow is not tagged for this app'
    );
  });

  it('BLANKS an off-allowlist output IN PLACE — it does not renumber the ones after it', async () => {
    // The host renders these urls as consent thumbnails, so an off-allowlist url
    // would be an image request the HOST makes to an arbitrary origin.
    //
    // 🔴 THE INDEX SPACE IS THE ASSERTION, NOT THE COUNT. This used to `filter()`,
    // which is a SILENT RENUMBER: with outputs `[evil, ok]`, dropping index 0 made
    // `ok` index 0, so a block asking for the image it saw at index 1 got an
    // out-of-range discard, and a block asking for index 0 got `ok` — a DIFFERENT
    // image than the one it named. `queryAppWorkflows` and
    // `publishGenerationOutputs` both hand the block the UNFILTERED projection, so
    // the index space this must agree with is the unfiltered one. A `null` slot
    // keeps the length and the positions; refusal happens at the selection site.
    const getWorkflow = vi.fn().mockResolvedValue({
      ...taggedWorkflow,
      steps: [
        {
          $type: 'textToImage',
          output: {
            images: [
              { url: 'https://evil.example/a.jpg', available: true, width: 1, height: 1 },
              {
                url: 'https://orchestration.civitai.com/v2/blobs/ok.jpg',
                available: true,
                width: 1,
                height: 1,
              },
            ],
          },
        },
      ],
    });

    const out = await call(getWorkflow);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeNull();
    expect(out[1]?.url).toContain('orchestration.civitai.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an off-allowlist output REFUSES the index that named it — never substitutes', () => {
  /**
   * The consumer half of the blanked slot. Two cases, and the second is the one
   * that was silently wrong: it is the exact shape the old filtering code turned
   * into "publish a different image than the block asked for".
   */
  function twoOutputsFirstEvil() {
    return {
      status: 'succeeded',
      tags: [`app-block:${APP_ID}`],
      steps: [
        {
          $type: 'textToImage',
          output: {
            images: [
              { url: 'https://evil.example/a.jpg', available: true, width: 1, height: 1 },
              {
                url: 'https://orchestration.civitai.com/v2/blobs/ok.jpg',
                available: true,
                width: 2,
                height: 3,
              },
            ],
          },
        },
      ],
    };
  }

  beforeEach(() => {
    OWNED_WORKFLOW.mockResolvedValue(true);
  });

  it('index 1 still resolves to the image the block saw at index 1', async () => {
    // Under the old filtering return this index was OUT OF RANGE and discarded,
    // so the whole request refused with "no valid output indexes to post".
    const out = await resolveBlockPostSources({
      sources: [{ kind: 'workflow', workflowId: 'wf_1', imageIndexes: [1] }],
      actor: ACTOR,
      getWorkflow: vi.fn().mockResolvedValue(twoOutputsFirstEvil()),
    });
    expect(out).toHaveLength(1);
    // Width 2 / height 3 are distinct from every other fixture value here, so
    // this cannot pass by resolving to the wrong output.
    expect(out[0]).toMatchObject({ kind: 'workflow', width: 2, height: 3 });
  });

  it('index 0 is REFUSED rather than resolving to the NEXT image', async () => {
    // 🔴 THE REGRESSION THIS PINS. Old behaviour: `filter()` made `ok` index 0, so
    // this call SUCCEEDED and published `ok` — an image the block had seen at a
    // different index. A substitution is worse than a refusal here because the
    // consent dialog would render it and nothing would look wrong.
    await expectRejection(
      resolveBlockPostSources({
        sources: [{ kind: 'workflow', workflowId: 'wf_1', imageIndexes: [0] }],
        actor: ACTOR,
        getWorkflow: vi.fn().mockResolvedValue(twoOutputsFirstEvil()),
      }),
      'BAD_REQUEST',
      'workflow has no available outputs to post'
    );
  });

  it('an OMITTED imageIndexes SKIPS the blanked slot and publishes the rest', async () => {
    // 🔴 THE ASYMMETRY, AND WHY IT IS NOT A HOLE IN THE RULE ABOVE. The refusal
    // exists because silently skipping an index the block NAMED would publish a
    // different image than the one named. An omitted `imageIndexes` names nothing
    // — it is documented as "every AVAILABLE output", and the indexes are invented
    // by the expansion in `resolveWorkflowOutputSelection`, not by the block. So
    // there is nothing to substitute against, and refusing the WHOLE post because
    // one output came back on an unexpected host would fail an app that never
    // asked for that output. Fails closed either way (the blanked slot is never
    // published) and the preview resolves identically, so the consent thumbnails
    // already exclude it — this is not a consent question.
    const out = await resolveBlockPostSources({
      sources: [{ kind: 'workflow', workflowId: 'wf_1' }],
      actor: ACTOR,
      getWorkflow: vi.fn().mockResolvedValue({
        status: 'succeeded',
        tags: [`app-block:${APP_ID}`],
        steps: [
          {
            $type: 'textToImage',
            output: {
              images: [
                { url: 'https://evil.example/a.jpg', available: true, width: 1, height: 1 },
                {
                  url: 'https://orchestration.civitai.com/v2/blobs/b.jpg',
                  available: true,
                  width: 2,
                  height: 3,
                },
                {
                  url: 'https://orchestration.civitai.com/v2/blobs/c.jpg',
                  available: true,
                  width: 5,
                  height: 7,
                },
              ],
            },
          },
        ],
      }),
    });

    // Dimensions are pairwise distinct and distinct from the blanked slot's, so
    // this cannot pass by resolving the wrong outputs or by duplicating one.
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ width: 2, height: 3 });
    expect(out[1]).toMatchObject({ width: 5, height: 7 });
  });

  /**
   * 🔴 THE ALL-BLANKED GUARD OWNS A REFUSAL MESSAGE NOTHING ELSE CAN PRODUCE, AND
   * THESE TWO CASES ARE WHAT MAKE THAT TESTED RATHER THAN ASSUMED.
   *
   * Measured before they existed: deleting `|| outputs.every((o) => o == null)`
   * from `resolveBlockPostSources` left the whole file GREEN, because the mutant
   * died to the downstream per-slot `if (!o)` guard, which emits the IDENTICAL
   * message — the redundant-guard shape where a mutant dies to the OTHER guard. It
   * is no longer even redundant: with an omitted `imageIndexes` the per-slot guard
   * now SKIPS rather than refuses, so without the clause these two requests fall
   * through to messages that point an app author at the wrong problem entirely.
   */
  describe('a workflow whose outputs are ALL off-allowlist refuses as a WORKFLOW problem', () => {
    function allEvil(n = 1) {
      return {
        status: 'succeeded',
        tags: [`app-block:${APP_ID}`],
        steps: [
          {
            $type: 'textToImage',
            output: {
              images: Array.from({ length: n }, (_, i) => ({
                url: `https://evil.example/${i}.jpg`,
                available: true,
                width: 1,
                height: 1,
              })),
            },
          },
        ],
      };
    }

    it('with NO indexes named — not the generic "a post needs at least one image"', async () => {
      // Without the clause the skip arm drops every slot, this source contributes
      // nothing, and the refusal comes from the end-of-function emptiness check.
      await expectRejection(
        resolveBlockPostSources({
          sources: [{ kind: 'workflow', workflowId: 'wf_1' }],
          actor: ACTOR,
          getWorkflow: vi.fn().mockResolvedValue(allEvil()),
        }),
        'BAD_REQUEST',
        'workflow has no available outputs to post'
      );
    });

    it('with an OUT-OF-RANGE index named — not "no valid output indexes to post"', async () => {
      // Without the clause `resolveWorkflowOutputSelection` returns nothing for an
      // in-range-index-free request and the selection check refuses first, telling
      // the author their INDEXES are wrong when the workflow is the problem.
      await expectRejection(
        resolveBlockPostSources({
          sources: [{ kind: 'workflow', workflowId: 'wf_1', imageIndexes: [9] }],
          actor: ACTOR,
          getWorkflow: vi.fn().mockResolvedValue(allEvil(2)),
        }),
        'BAD_REQUEST',
        'workflow has no available outputs to post'
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveBlockPostSources — the image cap REFUSES rather than truncating', () => {
  function workflowWith(n: number) {
    return {
      status: 'succeeded',
      tags: [`app-block:${APP_ID}`],
      steps: [
        {
          $type: 'textToImage',
          output: {
            images: Array.from({ length: n }, (_, i) => ({
              url: `https://orchestration.civitai.com/v2/blobs/${i}.jpg`,
              available: true,
              width: 1,
              height: 1,
            })),
          },
        },
      ],
    };
  }

  it(`refuses ${
    BLOCK_POST_MAX_IMAGES + 1
  } images instead of publishing the first ${BLOCK_POST_MAX_IMAGES}`, async () => {
    // 🔴 THE DIVERGENCE FROM `publishGenerationOutputs`, which silently `break`s.
    // A confirm shows thumbnails of the WHOLE set; truncating after the click
    // would publish a different set than the one consented to.
    const getWorkflow = vi.fn().mockResolvedValue(workflowWith(BLOCK_POST_MAX_IMAGES + 1));

    await expectRejection(
      resolveBlockPostSources({
        sources: [{ kind: 'workflow', workflowId: 'wf_1' }],
        actor: ACTOR,
        getWorkflow,
      }),
      'BAD_REQUEST',
      `a post may contain at most ${BLOCK_POST_MAX_IMAGES} images`
    );
  });

  it(`accepts exactly ${BLOCK_POST_MAX_IMAGES}`, async () => {
    const getWorkflow = vi.fn().mockResolvedValue(workflowWith(BLOCK_POST_MAX_IMAGES));
    const out = await resolveBlockPostSources({
      sources: [{ kind: 'workflow', workflowId: 'wf_1' }],
      actor: ACTOR,
      getWorkflow,
    });
    expect(out).toHaveLength(BLOCK_POST_MAX_IMAGES);
  });

  it('combines BOTH source kinds in request order — fresh outputs AND prior publishes', async () => {
    const getWorkflow = vi.fn().mockResolvedValue(workflowWith(1));
    dbMock.dbRead.$queryRaw.mockResolvedValue([imageRow({ id: 9001 })]);

    const out = await resolveBlockPostSources({
      sources: [
        { kind: 'workflow', workflowId: 'wf_1' },
        { kind: 'published', imageIds: [9001] },
      ],
      actor: ACTOR,
      getWorkflow,
    });

    expect(out.map((r) => r.kind)).toEqual(['workflow', 'published']);
  });

  it('refuses a workflow with no available outputs', async () => {
    const getWorkflow = vi.fn().mockResolvedValue(workflowWith(0));
    await expectRejection(
      resolveBlockPostSources({
        sources: [{ kind: 'workflow', workflowId: 'wf_1' }],
        actor: ACTOR,
        getWorkflow,
      }),
      'BAD_REQUEST',
      'workflow has no available outputs to post'
    );
  });

  it('refuses when the requested indexes are all out of range', async () => {
    const getWorkflow = vi.fn().mockResolvedValue(workflowWith(2));
    await expectRejection(
      resolveBlockPostSources({
        sources: [{ kind: 'workflow', workflowId: 'wf_1', imageIndexes: [17, 18] }],
        actor: ACTOR,
        getWorkflow,
      }),
      'BAD_REQUEST',
      'no valid output indexes to post'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('writeBlockPost', () => {
  beforeEach(() => {
    dbMock.dbWrite.post.create.mockResolvedValue({ id: 5150 });
    dbMock.dbWrite.image.updateMany.mockResolvedValue({ count: 1 });
  });

  it('creates a PUBLISHED post stamped with the server-authoritative app marker', async () => {
    await writeBlockPost({
      actor: ACTOR,
      materialisedImageIds: [1, 2],
      title: 'Hello',
      detail: null,
      tagIds: [11],
      tagNames: ['anime'],
      gallery: null,
    });

    const data = dbMock.dbWrite.post.create.mock.calls[0][0].data;
    expect(data.userId).toBe(VIEWER_USER_ID);
    expect(data.publishedAt).toBeInstanceOf(Date);
    expect(data.metadata).toEqual({ [BLOCK_POST_APP_ID_META_KEY]: APP_ID });
    expect(data.tags).toEqual({ create: [{ tagId: 11 }] });
  });

  it('adopts each image with the FULL conjunct set, and assigns post order', async () => {
    await writeBlockPost({
      actor: ACTOR,
      materialisedImageIds: [101, 102],
      title: null,
      detail: null,
      tagIds: [],
      tagNames: [],
      gallery: null,
    });

    expect(dbMock.dbWrite.image.updateMany).toHaveBeenCalledTimes(2);
    const first = dbMock.dbWrite.image.updateMany.mock.calls[0][0];
    // 🔴 The `where` IS the guard. Each conjunct closes a different hole and a
    // missing one is invisible without this assertion, because the mock will
    // happily report count:1 for any `where` at all.
    expect(first.where).toEqual({
      id: 101,
      userId: VIEWER_USER_ID,
      postId: null,
      metadata: { path: [BLOCK_POST_APP_ID_META_KEY], equals: APP_ID },
    });
    expect(first.data).toEqual({ postId: 5150, index: 0 });
    expect(dbMock.dbWrite.image.updateMany.mock.calls[1][0].data).toEqual({
      postId: 5150,
      index: 1,
    });
  });

  it('THROWS when an image no longer matches — the count IS the ownership proof', async () => {
    // A row that changed underneath us (concurrently adopted, ownership moved,
    // moderated) simply does not match, so the count comes back 0.
    dbMock.dbWrite.image.updateMany.mockResolvedValue({ count: 0 });

    await expectRejection(
      writeBlockPost({
        actor: ACTOR,
        materialisedImageIds: [101],
        title: null,
        detail: null,
        tagIds: [],
        tagNames: [],
        gallery: null,
      }),
      'CONFLICT',
      'an image is no longer available to post'
    );
  });

  it('attaches images by UPDATE, AFTER the Post row exists — `post_published_at_change` depends on it', async () => {
    // 🔴 PINNING AN INCIDENTAL DEPENDENCY, NOT A STYLE PREFERENCE. A third `Post`
    // trigger — `post_published_at_change`, `AFTER UPDATE OF "publishedAt"` —
    // also never fires on this path, and it is deliberately NOT re-issued because
    // its effect already happens by accident: `image_sort_at_before` (`BEFORE
    // INSERT OR UPDATE ON "Image"`) fires on the adopt, and `set_image_sort_at()`
    // reads the already-written `publishedAt` to compute the same
    // `GREATEST(publishedAt, scannedAt, createdAt)`; Prisma's `@updatedAt` on
    // `Image` supplies the bump Meili's incremental sync selects on.
    //
    // That holds ONLY while images are attached by an UPDATE issued after the Post
    // row exists. Creating the rows already carrying `postId` would silently stop
    // authoring `sortAt`/`updatedAt`, with no test and no error — so both halves
    // are asserted here.
    await writeBlockPost({
      actor: ACTOR,
      materialisedImageIds: [101],
      title: null,
      detail: null,
      tagIds: [],
      tagNames: [],
      gallery: null,
    });

    expect(dbMock.dbWrite.post.create).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.image.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.post.create.mock.invocationCallOrder[0]).toBeLessThan(
      dbMock.dbWrite.image.updateMany.mock.invocationCallOrder[0]
    );
    // …and by UPDATE, never by creating a row that already carries `postId`.
    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.createMany).not.toHaveBeenCalled();
    // ⚠️ WHAT THIS DOES NOT PIN: `set_image_sort_at()`'s own SQL. That runs in
    // Postgres and no tier in this repo executes it, so the SQL half of the
    // coverage claim is unverified here and is documented as such in the
    // `applyBlockPostPublishEffects` trigger ledger.
  });

  it('runs the create and the adopt inside ONE transaction', async () => {
    await writeBlockPost({
      actor: ACTOR,
      materialisedImageIds: [101],
      title: null,
      detail: null,
      tagIds: [],
      tagNames: [],
      gallery: null,
    });
    // Atomicity is a product requirement here: a half-written post is a public
    // artefact the viewer never agreed to.
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
  });

  it('writes the gallery target onto the row when one was resolved', async () => {
    await writeBlockPost({
      actor: ACTOR,
      materialisedImageIds: [101],
      title: null,
      detail: null,
      tagIds: [],
      tagNames: [],
      gallery: { modelVersionId: 3100, modelId: 800, modelName: 'M', versionName: 'v1' },
    });
    expect(dbMock.dbWrite.post.create.mock.calls[0][0].data.modelVersionId).toBe(3100);
  });

  it('omits the tags relation entirely when there are none (never `create: []`)', async () => {
    await writeBlockPost({
      actor: ACTOR,
      materialisedImageIds: [101],
      title: null,
      detail: null,
      tagIds: [],
      tagNames: [],
      gallery: null,
    });
    expect(dbMock.dbWrite.post.create.mock.calls[0][0].data.tags).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 the attribution marker is NOT client-settable — a structural claim', () => {
  it('the Post marker and the Image marker are the SAME key — one sweep reads both', async () => {
    // ⚠️ TWO CONSTANTS, ONE VALUE, AND THAT IS LOAD-BEARING RATHER THAN
    // COINCIDENTAL. The containment story is "find everything this app produced",
    // which is a single query over both tables only while the keys agree. Because
    // the values are identical today, a test that asserted one constant would pass
    // while the code used the other — so the RELATIONSHIP is pinned here
    // explicitly instead of being left to chance.
    const { BLOCK_PUBLISHED_APP_ID_META_KEY } = await import(
      '~/server/services/blocks/block-image-upload.service'
    );
    expect(BLOCK_POST_APP_ID_META_KEY).toBe(BLOCK_PUBLISHED_APP_ID_META_KEY);
    expect(BLOCK_POST_APP_ID_META_KEY).toBe('blockPublishedAppId');
  });

  it('no post input schema exposes `metadata`, so no client can forge or suppress it', async () => {
    // The whole security property of `Post.metadata.blockPublishedAppId` rests on
    // this: the server writes it unconditionally and nothing on the wire can. A
    // future `metadata` field added to either schema would silently make the
    // marker spoofable — the badge would then be rendering a block-supplied
    // claim while looking server-authoritative.
    const { postCreateSchema, postUpdateSchema } = await import('~/server/schema/post.schema');

    expect(Object.keys(postCreateSchema.shape)).not.toContain('metadata');
    expect(Object.keys(postUpdateSchema.shape)).not.toContain('metadata');

    // POSITIVE CONTROL for the check itself: these schemas DO expose the fields
    // this test would otherwise be unable to distinguish from "reads nothing".
    expect(Object.keys(postCreateSchema.shape)).toContain('title');
    expect(Object.keys(postUpdateSchema.shape)).toContain('id');
  });

  it('and the parsed output drops a `metadata` key a caller tries to smuggle in', async () => {
    const { postCreateSchema } = await import('~/server/schema/post.schema');
    const parsed = postCreateSchema.parse({
      title: 'x',
      metadata: { blockPublishedAppId: 'appblk-evil' },
    } as never);
    expect('metadata' in parsed).toBe(false);
  });
});
