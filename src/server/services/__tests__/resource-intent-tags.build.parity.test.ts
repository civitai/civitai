import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type {
  SparseByKey,
  TagModelContent,
  TagTrainingRow,
} from '~/server/services/resource-intent-tags/build';
import {
  contentTagScores,
  parseTagVocabulary,
  TagIndexAccumulator,
} from '~/server/services/resource-intent-tags/build';
import { decodeTagIndex, encodeTagIndex } from '~/server/services/resource-intent-tags/payload';
import { scoreTagRequest } from '~/server/services/resource-intent-tags/score';
import type { VersionInfo } from '~/server/services/resource-intent-tags/sources';
import { genTrainingRow } from '~/server/services/resource-intent-tags/sources';
import { RESOURCE_INTENT_TAGS_SPEC } from '~/server/services/resource-intent-tags/spec';

/**
 * Parity: the build against the offline prototype on SYNTHETIC raw inputs (invented keys, names,
 * ecosystems, users and prompts). The generator wrote those inputs in the prototype's own file shapes,
 * ran the prototype's own commands on them (prepare, score, content, eco_options, the P3 index) and
 * read back what they computed; it imports non-public code and is not in this repository. Never edit
 * the fixture to make this pass; regenerate it or fix the port.
 *
 * Tolerances: content scores are rounded to 4 decimals on both sides, so they compare exactly; fits and
 * user-side shares to 1e-12 (summation order differs); scores through the float32 snapshot to 1e-7
 * (absolute below 1, relative above), with the ranked order exact.
 */
type Pairs = [number, number][];
type KindJson = {
  modelIds: number[];
  fit: number[];
  ecosystems: string[][];
  postings: Record<string, [number, number, number | null][]>;
  ecosystemUsers: Record<string, Pairs>;
  userByTag: Record<string, Pairs>;
  userByEcosystem: Record<string, Pairs>;
};
type Golden = {
  vocabulary: {
    id: number;
    key: string;
    users: number;
    idf: number;
    explicit: boolean;
    near: number[];
  }[];
  versions: [number, number, string, string][];
  genRows: {
    u: string;
    p: string;
    versionIds: number[];
    liked: boolean;
    favorite: boolean;
    disliked: boolean;
  }[];
  postRows: {
    u: string;
    p: string;
    resources: { modelId: number; type: string; baseModel: string }[];
    reactions: number;
    tips: number;
  }[];
  models: (Omit<TagModelContent, 'modelId'> & { modelId: number })[];
  expected: {
    trainUsers: number;
    trainRows: number;
    content: Record<string, Record<string, number>>;
    ecosystems: { name: string; users: number; observations: number }[];
    tagEcosystemCounts: Record<string, Record<string, number>>;
    kinds: Record<'addon' | 'checkpoint', KindJson>;
    cases: {
      name: string;
      prompt: string;
      browsingLevel: number;
      baseModel: string | null;
      kind: 'addon' | 'checkpoint';
      ecosystems: string[];
      ecosystem: string;
      ranked: Pairs;
    }[];
  };
};
const golden = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/resource-intent-tags-build-golden.json'), 'utf8')
) as Golden;
const E = golden.expected;

const vocab = parseTagVocabulary(
  Buffer.from(JSON.stringify({ schema: 'p2m-vocab/2', tags: golden.vocabulary }))
);
const key = (t: number) => vocab.tags[t].key;
const versions = new Map<number, VersionInfo>(
  golden.versions.map(([v, modelId, type, baseModel]) => [
    v,
    { modelId, type, baseModel, flagged: false },
  ])
);

function trainingRows(): TagTrainingRow[] {
  return [
    ...golden.genRows.map(
      (r) =>
        genTrainingRow(
          {
            user: r.u,
            prompt: r.p,
            versionIds: r.versionIds,
            liked: r.liked,
            favorite: r.favorite,
            disliked: r.disliked,
          },
          versions
        ) as TagTrainingRow
    ),
    ...golden.postRows.map(
      (r): TagTrainingRow => ({
        source: 'post',
        user: r.u,
        prompt: r.p,
        resources: r.resources,
        reactions: r.reactions,
        tips: r.tips,
      })
    ),
  ];
}

function build(rows = trainingRows(), excludeGenPrompt: (p: string) => boolean = () => false) {
  const acc = new TagIndexAccumulator(vocab, {
    addonTypes: RESOURCE_INTENT_TAGS_SPEC.build.addonTypes,
    excludeGenPrompt,
  });
  for (const m of golden.models) acc.addModel(m);
  for (const r of rows) acc.addRow(r);
  return acc.finalize();
}
const built = build();

const close = (a: number, b: number, tol = 1e-12) =>
  Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/** A sparse list keyed by `name(key)`, each entry [modelId, value]. */
function sparseJson(s: SparseByKey, modelIds: Uint32Array, name: (k: number) => string) {
  const out: Record<string, Pairs> = {};
  s.keys.forEach((k, i) => {
    const pairs: Pairs = [];
    for (let j = s.ptr[i]; j < s.ptr[i + 1]; j++) pairs.push([modelIds[s.resource[j]], s.value[j]]);
    out[name(k)] = pairs;
  });
  return out;
}

function expectPairsClose(actual: Record<string, Pairs>, expected: Record<string, Pairs>) {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const [k, pairs] of Object.entries(expected)) {
    expect(
      actual[k].map((p) => p[0]),
      k
    ).toEqual(pairs.map((p) => p[0]));
    actual[k].forEach((p, i) => expect(close(p[1], pairs[i][1]), `${k} ${p[0]}`).toBe(true));
  }
}

describe('resource-intent-tags build parity with the prototype', () => {
  it('the fixture is the one this test was written for', () => {
    expect(golden.genRows.length + golden.postRows.length).toBe(2294);
    expect(E.trainRows).toBe(2293);
    expect(E.cases.reduce((n, c) => n + c.ranked.length, 0)).toBe(242);
    expect(Object.values(E.content).flatMap((c) => Object.values(c))).toContain(0.1562);
  });

  it('content tags of every model: noisy-OR over the sources, the prompt minimum, the 0.1 cut, half-even rounding', () => {
    for (const m of golden.models) {
      const got = contentTagScores(m, vocab.idByKey);
      const asKeys = Object.fromEntries([...got].map(([t, c]) => [key(t), c]));
      expect(asKeys, String(m.modelId)).toEqual(E.content[m.modelId] ?? {});
    }
  });

  it('counts rows and users as the prototype loaded them', () => {
    const s = built.stats;
    expect(s.rows.gen + s.rows.post).toBe(E.trainRows);
    expect(s.droppedNoResources).toBe(1);
    expect(s.users).toBe(E.trainUsers);
    expect(s.excludedByAuditor).toBe(0);
  });

  it('ecosystems: every one named by a row or a model, with training users and rows', () => {
    expect(built.data.ecosystems).toEqual(E.ecosystems);
    expect(built.data.rowsWithEcosystem).toBe(E.ecosystems.reduce((n, e) => n + e.observations, 0));
  });

  it('raw (tag, ecosystem) row counts', () => {
    const c = built.data.tagEcosystemCounts;
    const got: Record<string, Record<string, number>> = {};
    for (let t = 0; t < vocab.tags.length; t++) {
      if (c.ptr[t + 1] === c.ptr[t]) continue;
      got[key(t)] = {};
      for (let k = c.ptr[t]; k < c.ptr[t + 1]; k++)
        got[key(t)][built.data.ecosystems[c.ecosystem[k]].name] = c.count[k];
    }
    expect(got).toEqual(E.tagEcosystemCounts);
  });

  describe.each(['addon', 'checkpoint'] as const)('%s', (kind) => {
    const K = built.data.kinds[kind];
    const X = E.kinds[kind];
    const eco = (e: number) => built.data.ecosystems[e].name;

    it('resources in model id order, their own shrunk fit and published ecosystems', () => {
      expect([...K.modelIds]).toEqual(X.modelIds);
      K.fit.forEach((f, i) => expect(close(f, X.fit[i]), String(X.modelIds[i])).toBe(true));
      const ecos = X.modelIds.map((_, i) =>
        [...K.ecosystemIds.subarray(K.ecosystemPtr[i], K.ecosystemPtr[i + 1])].map(eco)
      );
      expect(ecos).toEqual(X.ecosystems);
    });

    it('postings: content score, and the pair fit where the pair has >= 2 users', () => {
      const got: Record<string, [number, number, number | null][]> = {};
      for (let t = 0; t < vocab.tags.length; t++) {
        const { ptr, resource, c, fit } = K.postings;
        if (ptr[t + 1] === ptr[t]) continue;
        got[key(t)] = [];
        for (let k = ptr[t]; k < ptr[t + 1]; k++)
          got[key(t)].push([K.modelIds[resource[k]], c[k], Number.isNaN(fit[k]) ? null : fit[k]]);
      }
      expect(Object.keys(got).sort()).toEqual(Object.keys(X.postings).sort());
      for (const [k, entries] of Object.entries(X.postings)) {
        expect(
          got[k].map((e) => [e[0], e[1], e[2] === null]),
          k
        ).toEqual(entries.map((e) => [e[0], e[1], e[2] === null]));
        got[k].forEach((e, i) => {
          if (e[2] !== null)
            expect(close(e[2], entries[i][2] as number), `${k} ${e[0]}`).toBe(true);
        });
      }
    });

    it('popularity: users of each resource per ecosystem', () => {
      expect(sparseJson(K.ecosystemUsers, K.modelIds, eco)).toEqual(X.ecosystemUsers);
    });

    it('user-side distributions per tag and per ecosystem', () => {
      expectPairsClose(sparseJson(K.userByTag, K.modelIds, key), X.userByTag);
      expectPairsClose(sparseJson(K.userByEcosystem, K.modelIds, eco), X.userByEcosystem);
    });
  });

  it.each(E.cases.map((c) => [c.name, c] as const))(
    'scores %s as the prototype ranks it, through the float32 snapshot',
    async (_name, c) => {
      const { index } = await decodeTagIndex(await encodeTagIndex(built.data, '0'.repeat(64)));
      const r = scoreTagRequest(index, {
        prompt: c.prompt,
        kind: c.kind,
        browsingLevel: c.browsingLevel,
        baseModel: c.baseModel,
      });
      expect(r.status).toBe('ok');
      expect(r.ecosystems).toEqual(c.ecosystems);
      expect(r.ecosystem).toBe(c.ecosystem);
      expect(r.candidates.map((x) => x.modelId)).toEqual(c.ranked.map(([m]) => m));
      r.candidates.forEach((x, i) => expect(close(x.score, c.ranked[i][1], 1e-7)).toBe(true));
    }
  );
});

describe('resource-intent-tags build: the auditor exclusion', () => {
  it('drops a generator row the auditor flags, exactly as if it had never been read', () => {
    const rows = trainingRows();
    const victim = rows.findIndex((r) => r.source === 'gen' && r.resources.length > 0);
    const flagged = rows[victim].prompt;
    const excluded = build(rows, (p) => p === flagged);
    const without = build(rows.filter((r) => r.prompt !== flagged || r.source !== 'gen'));
    expect(excluded.stats.excludedByAuditor).toBeGreaterThan(0);
    expect(excluded.data).toEqual(without.data);
    expect(excluded.data).not.toEqual(built.data);
  });

  it('never consults the auditor for posted rows', () => {
    const seen: string[] = [];
    build(trainingRows(), (p) => {
      seen.push(p);
      return false;
    });
    expect(seen.length).toBe(golden.genRows.length);
  });
});

describe('parseTagVocabulary', () => {
  const tags = [
    { id: 0, key: 'amber kite', users: 30, idf: 1.2, explicit: false, near: [1] },
    { id: 1, key: 'brass owl', users: 40, idf: 0.9, explicit: true, near: [0] },
  ];
  const bytes = (t: unknown, schema = 'p2m-vocab/2') =>
    Buffer.from(JSON.stringify({ schema, tags: t }));

  it('versions the payload by the sha256 of its exact bytes', () => {
    const b = bytes(tags);
    expect(parseTagVocabulary(b).vocabVersion).toBe(createHash('sha256').update(b).digest('hex'));
    const spaced = Buffer.from(JSON.stringify({ schema: 'p2m-vocab/2', tags }, null, 1));
    expect(parseTagVocabulary(spaced).vocabVersion).not.toBe(parseTagVocabulary(b).vocabVersion);
  });

  it.each<[string, Buffer, string]>([
    ['another schema', bytes(tags, 'p2m-vocab/1'), 'schema'],
    ['an id that is not its position', bytes([tags[1], tags[0]]), 'id is not its position'],
    [
      'keys out of code-point order',
      bytes([
        { ...tags[1], id: 0, near: [1] },
        { ...tags[0], id: 1, near: [0] },
      ]),
      'key order',
    ],
    [
      'a near set that is not symmetric',
      bytes([tags[0], { ...tags[1], near: [] }]),
      'not symmetric',
    ],
    ['a near set holding its own tag', bytes([{ ...tags[0], near: [0] }, tags[1]]), 'near id'],
    ['a non-finite idf', bytes([{ ...tags[0], idf: 'x' }, tags[1]]), 'idf'],
  ])('refuses %s', (_name, b, message) => {
    expect(() => parseTagVocabulary(b)).toThrow(message);
  });
});
