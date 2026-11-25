import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
// Static import, same reasoning as get-models-raw.transient-503.test.ts.
import { getModelsRaw, getModelsWithVersions } from '~/server/services/model.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { runModelSearch } from '~/server/services/model-search.service';

redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

const { capturedQueries } = vi.hoisted(() => ({
  capturedQueries: [] as { text: string; values: unknown[] }[],
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: vi.fn(async (query: { text: string; values: unknown[] }) => {
      capturedQueries.push(query);
      return { result: async () => [], cancel: async () => undefined };
    }),
  },
  pgDbWrite: {},
  pgDbReadLong: {},
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: undefined,
  withMeili: vi.fn(),
  MeiliCallTimeoutError: class extends Error {},
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

/** The feed SQL for a Hot, base-filtered query, with the pin's id restriction applied. */
async function feedSql(pin: { onlyModelIds?: number[]; excludeModelIds?: number[] }) {
  capturedQueries.length = 0;
  await getModelsRaw({
    input: { browsingLevel: 1, take: 10, sort: 'Hot', baseModels: ['Flux.1 D'] } as never,
    ...pin,
  });
  expect(capturedQueries).toHaveLength(1);
  return capturedQueries[0];
}

const bound = ({ text, values }: { text: string; values: unknown[] }, re: RegExp) =>
  [...text.matchAll(re)].map((m) => values[Number(m[1]) - 1]);

describe('getModelsRaw official-checkpoint pin ids', () => {
  it('restricts to onlyModelIds', async () => {
    const q = await feedSql({ onlyModelIds: [10, 11] });
    expect(bound(q, /mm\."modelId" IN \(\$(\d+),\$\d+\)/g)).toEqual([10]);
    expect(bound(q, /mm\."modelId" IN \(\$\d+,\$(\d+)\)/g)).toEqual([11]);
  });

  it('drops excludeModelIds', async () => {
    const q = await feedSql({ excludeModelIds: [10, 11] });
    // One scalar parameter per id: this query path sent a bound array as a string (22P02 in prod).
    expect(bound(q, /mm\."modelId" NOT IN \(\$(\d+),\$\d+\)/g)).toEqual([10]);
    expect(bound(q, /mm\."modelId" NOT IN \(\$\d+,\$(\d+)\)/g)).toEqual([11]);
    expect(q.values.some(Array.isArray)).toBe(false);
  });

  it('adds no id predicate without either', async () => {
    const { text } = await feedSql({});
    expect(text).not.toMatch(/mm\."modelId" (NOT )?IN/);
  });
});

/**
 * A taken-down model is its owner's and moderators' alone, in every list. Only the v1 by-id route keeps
 * it (`includeWithheld`). Predicate semantics are pinned in model-withheld.sql.behavior.test.ts.
 */

const TAKEN_DOWN =
  /"mode" IS DISTINCT FROM \$(\d+)::"ModelModifier" OR \(\$(\d+)::boolean AND mm\."userId" = \$(\d+)\) OR \$(\d+)::boolean/;

async function withheldFeedSql(
  user?: { id: number; isModerator?: boolean },
  includeWithheld?: boolean
) {
  capturedQueries.length = 0;
  await getModelsRaw({
    input: { browsingLevel: 1, take: 10, sort: 'Newest' } as never,
    user,
    includeWithheld,
  });
  expect(capturedQueries).toHaveLength(1);
  return capturedQueries[0];
}

/** The clause's bound values: [mode, signedIn, viewerId, isModerator], or undefined when absent. */
const withheldClause = ({ text, values }: { text: string; values: unknown[] }) => {
  const m = text.replace(/\s+/g, ' ').match(TAKEN_DOWN);
  return m ? m.slice(1, 5).map((n) => values[Number(n) - 1]) : undefined;
};

describe('getModelsRaw and taken-down models', () => {
  it.each([
    ['a signed-out visitor', undefined, ['TakenDown', false, undefined, false]],
    ['a signed-in visitor', { id: 7 }, ['TakenDown', true, 7, false]],
    ['a moderator', { id: 8, isModerator: true }, ['TakenDown', true, 8, true]],
  ])('binds the viewer for %s', async (_n, user, bound) => {
    expect(withheldClause(await withheldFeedSql(user))).toEqual(bound);
  });

  it('keeps them when the caller opts out', async () => {
    expect(withheldClause(await withheldFeedSql({ id: 7 }, true))).toBeUndefined();
  });

  // Control for the clause search: the Archived filter is still found where it always was.
  it('still drops Archived as before', async () => {
    const { text, values } = await withheldFeedSql({ id: 7 });
    const archived = text.replace(/\s+/g, ' ').match(/"mode" != \$(\d+)::"ModelModifier"/);
    expect(archived && values[Number(archived[1]) - 1]).toBe('Archived');
  });

  it.each([
    ['applies the rule by default (the v1 lists)', undefined, ['TakenDown', true, 7, false]],
    ['keeps them only on opt-out (the v1 by-id route)', true, undefined],
  ])('the public v1 path (getModelsWithVersions) %s', async (_n, includeWithheld, expected) => {
    capturedQueries.length = 0;
    await getModelsWithVersions({
      input: { browsingLevel: 1, take: 10, sort: 'Newest' } as never,
      user: { id: 7 },
      includeWithheld,
    }).catch(() => undefined); // only the feed query matters here
    expect(capturedQueries.length).toBeGreaterThan(0);
    // Positive control: the captured query is the model feed (it carries the Archived filter).
    const { text, values } = capturedQueries[0];
    const archived = text.replace(/\s+/g, ' ').match(/"mode" != \$(\d+)::"ModelModifier"/);
    expect(archived && values[Number(archived[1]) - 1]).toBe('Archived');
    expect(withheldClause(capturedQueries[0])).toEqual(expected);
  });
});

/**
 * The v1 model lists (/api/v1/models and the blocks/models and blocks/tools catalogs, all through
 * runModelSearch): the statement runModelSearch really builds is captured, and its taken-down clause
 * is run over PGlite rows.
 */
const OWNER = 10;
let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TABLE mm ("modelId" int PRIMARY KEY, "mode" "ModelModifier", "userId" int);
    INSERT INTO mm VALUES (1, NULL, ${OWNER}), (2, 'TakenDown', ${OWNER});
  `);
});
afterAll(() => pg.close());

const LIST_TAKEN_DOWN =
  /\( mm\."mode" IS DISTINCT FROM \$\d+::"ModelModifier" OR \(\$\d+::boolean AND mm\."userId" = \$\d+\) OR \$\d+::boolean \)/;

/** The model ids the list's own taken-down clause lets the viewer see. */
async function listed(user?: { id: number; isModerator?: boolean }) {
  capturedQueries.length = 0;
  await runModelSearch(
    { limit: 10, sort: 'Newest' } as Parameters<typeof runModelSearch>[0],
    {
      browsingLevel: 1,
      nsfwImagePassthrough: false,
      user,
      baseUrlOrigin: 'https://civitai.com',
    } as Parameters<typeof runModelSearch>[1]
  ).catch(() => undefined); // only the statement matters
  expect(capturedQueries).toHaveLength(1);
  const { text, values } = capturedQueries[0];
  const clause = text.replace(/\s+/g, ' ').match(LIST_TAKEN_DOWN)?.[0];
  if (!clause) return [1, 2]; // no clause: every row is listed
  const args: unknown[] = [];
  const local = clause.replace(/\$(\d+)/g, (_m, n) => {
    args.push(values[Number(n) - 1]);
    return `$${args.length}`;
  });
  const { rows } = await pg.query<{ modelId: number }>(
    `SELECT "modelId" FROM mm WHERE ${local} ORDER BY "modelId"`,
    args
  );
  return rows.map((r) => r.modelId);
}

describe('runModelSearch and taken-down models', () => {
  it('hides a taken-down model from a signed-out viewer, and lists the healthy one', async () => {
    expect(await listed(undefined)).toEqual([1]);
  });

  it('hides it from a signed-in viewer who is not its owner', async () => {
    expect(await listed({ id: 20 })).toEqual([1]);
  });

  it('lists it for its owner', async () => {
    expect(await listed({ id: OWNER })).toEqual([1, 2]);
  });

  it('lists it for a moderator', async () => {
    expect(await listed({ id: 30, isModerator: true })).toEqual([1, 2]);
  });
});
