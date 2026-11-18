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
 *           many LoRAs carry an ecosystem's name ("Flux") and would pass any boost.
 *   subject — graded by precision@k on `images`: the share of the top `k` whose prompt
 *           matches every group in `expectTerms` (any term of a group, whole word,
 *           case-insensitive). Prompt text is the point here: these came from reports
 *           that semantic search returns look-alikes whose prompts never name the subject.
 */

import type { ECO } from '~/shared/constants/basemodel.constants';

export type GoldenTarget = 'images' | 'models';

type GoldenQueryBase = { id: string; text: string; targets: GoldenTarget[]; note?: string };

export type GoldenQuery =
  | (GoldenQueryBase & { kind: 'canonical' })
  | (GoldenQueryBase & { kind: 'typo'; canonical: string })
  | (GoldenQueryBase & { kind: 'named'; expectEcosystem: keyof typeof ECO; k: number })
  | (GoldenQueryBase & { kind: 'subject'; expectTerms: string[][]; k: number });

export function defineGoldenSet(queries: GoldenQuery[]) {
  const byId = new Map<string, GoldenQuery>();
  for (const query of queries) {
    if (byId.has(query.id)) throw new Error(`golden query id "${query.id}" is duplicated`);
    byId.set(query.id, query);
  }
  for (const query of queries) {
    if (query.kind === 'subject' && !query.expectTerms.length)
      throw new Error(`subject "${query.id}" has no term groups`);
    if (query.kind === 'subject' && !query.expectTerms.every((group) => group.length))
      throw new Error(`subject "${query.id}" has an empty term group`);
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

  // Subject counts (tester report): semantic search ranks images with the wrong number of
  // subjects, or with the count written as text in the picture, above prompts that name it.
  {
    id: 'subject-count-2-girls',
    kind: 'subject',
    text: '2 girls',
    expectTerms: [['2girls', '2 girls', 'two girls']],
    k: 10,
    targets: ['images'],
    note: 'Reported with no correct match in the top results.',
  },
  {
    id: 'subject-count-3-girls',
    kind: 'subject',
    text: '3 girls',
    expectTerms: [['3girls', '3 girls', 'three girls']],
    k: 20,
    targets: ['images'],
    note: 'Reported with the first miss around rank 20, so k is 20.',
  },
  {
    id: 'subject-count-3-boys',
    kind: 'subject',
    text: '3 boys',
    expectTerms: [['3boys', '3 boys', 'three boys']],
    k: 10,
    targets: ['images'],
  },
  {
    id: 'subject-count-mixed',
    kind: 'subject',
    text: '2 girls 1 boy',
    expectTerms: [
      ['2girls', '2 girls', 'two girls'],
      ['1boy', '1 boy', 'one boy'],
    ],
    k: 10,
    targets: ['images'],
    note: 'Mixed-gender counts were reported as worse than single-gender ones.',
  },
]);
