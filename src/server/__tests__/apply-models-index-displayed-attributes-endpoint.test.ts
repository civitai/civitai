import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { modelsDisplayedAttributes } from '~/server/search-index/displayed-attributes';

/**
 * This endpoint is the only in-repo way to apply `modelsDisplayedAttributes` to the LIVE models
 * index without a full rebuild, and that list is a privacy boundary: until it is applied, an index
 * sits on Meili's `["*"]` default and returns `sortMetrics` — the unmasked download/tipped figures
 * of creators who hid them — in every hit.
 *
 * Three properties are pinned: it is INERT unless someone explicitly asks for the write, the write
 * it makes is the whole desired list ON THE MODELS INDEX, and a write that REDUCES what clients
 * receive needs a second, explicit flag. `updateDisplayedAttributes` REPLACES rather than merges,
 * so writing anything narrower — or writing to the wrong index — silently strips that index's
 * responses, and a client reading a field that stopped being returned breaks with `undefined`
 * rather than an error.
 */

const { env, getDisplayedAttributes, updateDisplayedAttributes, getTasks, getStats, index } =
  vi.hoisted(() => {
    // Meili's display-everything default — the un-narrowed state this route exists to leave, and
    // the shape every refusal below is exercised against. Not a claim about any live index.
    const getDisplayedAttributes = vi.fn(async () => ['*'] as string[]);
    const updateDisplayedAttributes = vi.fn(async () => ({ taskUid: 99 }));
    const getTasks = vi.fn(async () => ({ results: [] as { uid: number }[] }));
    const getStats = vi.fn(async () => ({
      // Deliberately NOT a subset of the desired list — a document can carry top-level attributes
      // the whitelist withholds, and the route's job is to name them. The specific entries and
      // counts here are the FIXTURE's; no claim about any live index is intended, and the withheld
      // set itself is pinned in models-displayed-attributes.test.ts rather than restated here.
      fieldDistribution: {
        id: 97,
        name: 97,
        versions: 97,
        sortMetrics: 31,
        isOfficial: 29,
        canGenerateNext: 17,
      } as Record<string, number>,
    }));
    return {
      env: {
        WEBHOOK_TOKEN: 'test-token',
        LOGGING: '',
        NEXTAUTH_URL: 'https://example.test',
        TRPC_ORIGINS: [] as string[],
      },
      getDisplayedAttributes,
      updateDisplayedAttributes,
      getTasks,
      getStats,
      index: vi.fn(() => ({
        getDisplayedAttributes,
        updateDisplayedAttributes,
        getTasks,
        getStats,
      })),
    };
  });

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: { index },
  metricsSearchClient: null,
}));

const handler = (await import('~/pages/api/admin/temp/apply-models-index-displayed-attributes'))
  .default;

function call(query: Record<string, string>, token = 'test-token') {
  const req = { method: 'POST', query: { token, ...query }, headers: {} } as never;
  let statusCode = 0;
  let payload: Record<string, unknown> | undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      payload = data;
      return res;
    },
    send: () => res,
    setHeader: () => res,
    end: () => res,
  };
  return handler(req, res as never).then(() => ({
    statusCode,
    payload: payload as Record<string, unknown>,
  }));
}

/** The flags a real narrowing needs. Spelled out once so each test says what it is varying. */
const APPLY = { dryRun: 'false', allowRemove: 'true' };

describe('apply-models-index-displayed-attributes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDisplayedAttributes.mockResolvedValue(['*']);
    getTasks.mockReset();
    getTasks.mockResolvedValue({ results: [] });
    getStats.mockReset();
    getStats.mockResolvedValue({
      fieldDistribution: {
        id: 97,
        name: 97,
        versions: 97,
        sortMetrics: 31,
        isOfficial: 29,
        canGenerateNext: 17,
      },
    });
  });

  it('documents the rollback against the index name the route actually targets', async () => {
    // The docstring spells the index LITERALLY in its reset command, because `MODELS_SEARCH_INDEX`
    // is a TypeScript constant and `$MODELS_SEARCH_INDEX` in a shell expands to nothing — which
    // yields `/indexes//settings/...` and a 404 that reads as "the route does not exist".
    //
    // A literal is correct and unpinned, and that `_vN` suffix rotates. After a bump the stale
    // literal would still name an index that plausibly still EXISTS, so the DELETE succeeds and the
    // operator believes the undo applied to the live index when it did not. This ties the two.
    //
    // 🔴 Reads RAW source on purpose — the command lives inside a block comment, so the
    // comment-stripping helper the sibling guards use would delete exactly what this asserts.
    //
    // 🔴 And it asserts on the COMMAND LINE, not on the file. A whole-file
    // `not.toContain('$MODELS_SEARCH_INDEX')` fails on the prose two lines below the command that
    // explains why the variable form is wrong — the fourth time in this changeset that a guard
    // matched the text documenting the hazard it greps for. Scope the assertion to the construct.
    const route = readFileSync(
      join(process.cwd(), 'src/pages/api/admin/temp/apply-models-index-displayed-attributes.ts'),
      'utf8'
    );
    const urlLines = route.split('\n').filter((l) => l.includes('settings/displayed-attributes'));

    expect(urlLines).toHaveLength(1);
    expect(urlLines[0]).toContain(`/indexes/${MODELS_SEARCH_INDEX}/settings/displayed-attributes`);
    expect(urlLines[0]).not.toContain('$MODELS_SEARCH_INDEX');
  });

  it('rejects a call with the wrong token, and writes nothing', async () => {
    const { statusCode } = await call({ ...APPLY }, 'wrong');

    expect(statusCode).toBe(401);
    expect(updateDisplayedAttributes).not.toHaveBeenCalled();
  });

  it('targets the MODELS index', async () => {
    // Retargeting this at another index passes every other assertion in this file while narrowing
    // that index's responses in production.
    await call({});

    expect(index).toHaveBeenCalledWith(MODELS_SEARCH_INDEX);
  });

  it('asks only for PENDING SETTINGS tasks when deciding whether one is in flight', async () => {
    // Point this at another type or drop 'processing' and the double-write guard silently stops
    // guarding, while the 409 test below keeps passing on its canned result.
    await call({});

    expect(getTasks.mock.calls[0][0]).toEqual({
      statuses: ['enqueued', 'processing'],
      types: ['settingsUpdate'],
    });
  });

  it('writes NOTHING by default', async () => {
    const { payload } = await call({});

    expect(payload.dryRun).toBe(true);
    expect(payload.narrowing).toBe(true);
    expect(updateDisplayedAttributes).not.toHaveBeenCalled();
  });

  it('names every attribute the write would stop returning, sortMetrics among them', async () => {
    // The disclosure this route exists to provide. An operator reading only the 35-entry desired
    // list cannot tell which stored fields actually disappear; this is the field distribution
    // minus the whitelist, which is the real answer. Fixture counts are arbitrary and pairwise
    // distinct — the assertion is on WHICH attributes come back, never on a magnitude, and a real
    // measurement does not belong in this repo.
    const { payload } = await call({});

    expect(payload.willStopReturning).toEqual(['canGenerateNext', 'isOfficial', 'sortMetrics']);
  });

  it('still answers the dry run when the tasks and stats APIs are unreachable', async () => {
    // A key without tasks.get or stats would otherwise take out the read-only path too. null means
    // "did not determine", which is distinct from [] meaning "checked, nothing".
    getTasks.mockRejectedValue(new Error('403 forbidden'));
    getStats.mockRejectedValue(new Error('403 forbidden'));

    const { statusCode, payload } = await call({});

    expect(statusCode).toBe(200);
    expect(payload.pending).toBeNull();
    expect(payload.willStopReturning).toBeNull();
    expect(updateDisplayedAttributes).not.toHaveBeenCalled();
  });

  it('REFUSES to narrow away from the ["*"] default without allowRemove', async () => {
    // `*` is not a named attribute, so an `extra`-only guard would see nothing to remove and let
    // this through — silently changing every search response on the index.
    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(409);
    expect(payload.narrowing).toBe(true);
    expect(payload.willStopReturning).toEqual(['canGenerateNext', 'isOfficial', 'sortMetrics']);
    expect(updateDisplayedAttributes).not.toHaveBeenCalled();
  });

  it('writes the WHOLE desired list, because the call replaces rather than merges', async () => {
    const { payload } = await call({ ...APPLY });

    expect(updateDisplayedAttributes).toHaveBeenCalledTimes(1);
    expect(updateDisplayedAttributes.mock.calls[0][0]).toEqual([...modelsDisplayedAttributes]);
    expect(payload.taskUid).toBe(99);
  });

  it('reports added/removed truthfully when narrowing from the wildcard', async () => {
    // 🔴 The inverse of this was shipped and found by a review round. Computing `missing` by literal
    // membership in `['*']` makes the whole desired list "missing", so the two fields an operator
    // reads first reported a large `added` against an empty `removed` — for a write that adds
    // nothing and removes whatever the field distribution says. Under `*` the index already returns
    // everything, so nothing is added and the losses come from that distribution, not from `extra`,
    // which excludes `*` by design and is always empty here. The expectations below are the
    // FIXTURE's three, not a production figure; the earlier wording quoted production counts and
    // one of them went stale inside its own commit.
    const { payload } = await call({ ...APPLY });

    expect(payload.added).toEqual([]);
    expect(payload.removed).toEqual(['canGenerateNext', 'isOfficial', 'sortMetrics']);
  });

  it('reports removed as null, not [], when the stats read failed mid-narrowing', async () => {
    // `force` is needed because the same unreachable-API condition also refuses on `pending`; this
    // test is about the REPORTING, so push past the gate rather than asserting it twice.
    getStats.mockRejectedValue(new Error('403 forbidden'));

    const { payload } = await call({ ...APPLY, force: 'true' });

    expect(payload.removed).toBeNull();
    expect(payload.willStopReturning).toBeNull();
  });

  it('counts a nested field under its PARENT, so a flattened distribution cannot over-report', async () => {
    // Meilisearch flattens nested objects to dot notation internally. If the stats endpoint ever
    // reports `user.username` rather than `user`, a literal comparison against this top-level list
    // matches nothing and reports every nested field as a loss — burying the real ones. Children
    // ride along with their listed parent, so the parent is the right unit.
    getStats.mockResolvedValue({
      fieldDistribution: {
        'user.username': 11,
        'versions.canGenerateNext': 7,
        'metrics.downloadCount': 5,
        sortMetrics: 3,
      },
    });

    const { payload } = await call({});

    expect(payload.willStopReturning).toEqual(['sortMetrics']);
  });

  it('writes a list that does NOT contain sortMetrics', async () => {
    // The end-to-end property, asserted on what reaches Meilisearch rather than on the module the
    // route imports. A route that merged `current` into `desired` would pass the equality test
    // above only by accident; this one states the consequence directly.
    await call({ ...APPLY });

    expect(updateDisplayedAttributes.mock.calls[0][0]).not.toContain('sortMetrics');
    expect(updateDisplayedAttributes.mock.calls[0][0]).not.toContain('*');
  });

  it('refuses the narrowing even when the stats read failed, because the gate is on intent', async () => {
    // Deliberate split: `willStopReturning` is disclosure and may be null, but the refusal keys on
    // `allowRemove`. Gating on a reading that can be missing would turn an unreachable stats API
    // into a green light for the write.
    getStats.mockRejectedValue(new Error('403 forbidden'));

    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(409);
    expect(payload.willStopReturning).toBeNull();
    expect(updateDisplayedAttributes).not.toHaveBeenCalled();
  });

  it('REFUSES the write when it cannot tell whether a settings task is pending', async () => {
    getTasks.mockRejectedValue(new Error('403 forbidden'));

    const { statusCode } = await call({ ...APPLY });

    expect(statusCode).toBe(409);
    expect(updateDisplayedAttributes).not.toHaveBeenCalled();
  });

  it('does not write when the live list already matches', async () => {
    getDisplayedAttributes.mockResolvedValue([...modelsDisplayedAttributes]);

    const { payload } = await call({ ...APPLY });

    expect(payload.unchanged).toBe(true);
    expect(updateDisplayedAttributes).not.toHaveBeenCalled();
  });

  it('REFUSES a write that would remove a NAMED attribute the live index has', async () => {
    // The post-narrowing shape: no `*` any more, but the live list carries something the code list
    // does not. Drift is not directional and the repo cannot see which way it has gone.
    getDisplayedAttributes.mockResolvedValue([...modelsDisplayedAttributes, 'somethingElse']);

    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(409);
    expect(payload.narrowing).toBe(false);
    expect(payload.extra).toEqual(['somethingElse']);
    expect(updateDisplayedAttributes).not.toHaveBeenCalled();
  });

  it('permits the named removal only with allowRemove, and actually removes', async () => {
    // Asserting only that a write happened would let `[...desired, ...extra]` pass — which reports
    // `removed` while removing nothing, so an operator re-runs forever.
    getDisplayedAttributes.mockResolvedValue([...modelsDisplayedAttributes, 'somethingElse']);

    const { payload } = await call({ ...APPLY });

    expect(updateDisplayedAttributes.mock.calls[0][0]).toEqual([...modelsDisplayedAttributes]);
    expect(payload.removed).toEqual(['somethingElse']);
  });

  it('adds a missing attribute without allowRemove, because widening loses nothing', async () => {
    // The one shape that needs no second flag: already narrowed, and the code list has gained an
    // entry. Requiring allowRemove here would train operators to pass it always.
    getDisplayedAttributes.mockResolvedValue(
      modelsDisplayedAttributes.filter((a) => a !== 'hiddenMetrics')
    );

    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(200);
    expect(payload.added).toEqual(['hiddenMetrics']);
    expect(updateDisplayedAttributes.mock.calls[0][0]).toEqual([...modelsDisplayedAttributes]);
  });

  it('REFUSES a second write while a settings task is still enqueued', async () => {
    // getDisplayedAttributes reports what is APPLIED, so during the enqueue-to-applied window a
    // second call sees the same diff and would enqueue a second write. There is no method guard on
    // the route, so a browser reload is enough to do it.
    getTasks.mockResolvedValue({ results: [{ uid: 7 }] });

    const { statusCode, payload } = await call({ ...APPLY });

    expect(statusCode).toBe(409);
    expect(payload.pending).toEqual([7]);
    expect(updateDisplayedAttributes).not.toHaveBeenCalled();
  });

  it('permits it only with force, and still writes the whole list', async () => {
    getTasks.mockResolvedValue({ results: [{ uid: 7 }] });

    const { payload } = await call({ ...APPLY, force: 'true' });

    expect(updateDisplayedAttributes.mock.calls[0][0]).toEqual([...modelsDisplayedAttributes]);
    expect(payload.narrowing).toBe(true);
  });
});
