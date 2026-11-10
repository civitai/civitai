/**
 * Golden queries for the search relevance eval (Qdrant via the search service vs
 * Meilisearch). Query expansion and named-entity boosting are judged against this set,
 * so each query says how it is graded rather than pinning result ids, which drift as
 * the index changes:
 *
 *   typo  — graded by recall@k against the results of its `canonical` query. A typo
 *           that returns nothing the correct spelling returns is a miss.
 *   named — graded by whether a hit from `expectEcosystem` ranks in the top `k`: on
 *           `models`, a Checkpoint whose base model is in that ecosystem; on `images`, an
 *           image generated on one. Matched by ecosystem, never by name substring, since
 *           thousands of LoRAs have "Flux" in their names and would pass any boost.
 */

import type { ECO } from '~/shared/constants/basemodel.constants';

export type GoldenTarget = 'images' | 'models';

type GoldenQueryBase = { id: string; text: string; targets: GoldenTarget[]; note?: string };

export type GoldenQuery =
  | (GoldenQueryBase & { kind: 'canonical' })
  | (GoldenQueryBase & { kind: 'typo'; canonical: string })
  | (GoldenQueryBase & { kind: 'named'; expectEcosystem: keyof typeof ECO; k: number });

export function defineGoldenSet(queries: GoldenQuery[]) {
  const byId = new Map<string, GoldenQuery>();
  for (const query of queries) {
    if (byId.has(query.id)) throw new Error(`golden query id "${query.id}" is duplicated`);
    byId.set(query.id, query);
  }
  for (const query of queries) {
    if (query.kind !== 'typo') continue;
    const canonical = byId.get(query.canonical);
    if (canonical?.kind !== 'canonical')
      throw new Error(`typo "${query.id}" points at "${query.canonical}", not a canonical query`);
    const missing = query.targets.filter((target) => !canonical.targets.includes(target));
    if (missing.length)
      throw new Error(
        `typo "${query.id}" targets ${missing.join(', ')}, which its canonical does not`
      );
  }
  return queries;
}

const HOMER_TARGETS: GoldenTarget[] = ['images', 'models'];

export const GOLDEN_QUERIES = defineGoldenSet([
  // Misspelled "Homer Simpson", as reported from real searches: query expansion should recover these.
  { id: 'homer-simpson', kind: 'canonical', text: 'homer simpson', targets: HOMER_TARGETS },
  {
    id: 'homer-simpson-typo-transposed',
    kind: 'typo',
    text: 'homer simspon',
    canonical: 'homer-simpson',
    targets: HOMER_TARGETS,
  },
  {
    id: 'homer-simpson-typo-substituted',
    kind: 'typo',
    text: 'homer simpsom',
    canonical: 'homer-simpson',
    targets: HOMER_TARGETS,
  },
  {
    id: 'homer-simpson-typo-doubled',
    kind: 'typo',
    text: 'hommer simpson',
    canonical: 'homer-simpson',
    targets: HOMER_TARGETS,
  },
  {
    id: 'homer-simpson-typo-dropped',
    kind: 'typo',
    text: 'homer simpsn',
    canonical: 'homer-simpson',
    targets: HOMER_TARGETS,
  },
  {
    id: 'homer-simpson-typo-joined',
    kind: 'typo',
    text: 'homersimpson',
    canonical: 'homer-simpson',
    targets: HOMER_TARGETS,
    note: 'No space: a token-level spell corrector sees one unknown word.',
  },

  // Name-only queries: the user typed a name, so named boosting should put it first.
  {
    id: 'name-moss-image-misspelled',
    kind: 'named',
    text: 'MOS image',
    expectEcosystem: 'MossImage',
    k: 5,
    targets: ['models', 'images'],
    note: 'Misspelled "MOSS Image": "image" is part of the name, so it must not be dropped as a type word.',
  },
  {
    id: 'name-flux',
    kind: 'named',
    text: 'Flux',
    expectEcosystem: 'Flux1',
    k: 5,
    targets: ['models'],
  },
  {
    id: 'name-flux-lowercase',
    kind: 'named',
    text: 'flux',
    expectEcosystem: 'Flux1',
    k: 5,
    targets: ['models'],
  },
]);
