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
 *   subject — `images` only, graded by precision@k: the share of the top `k` whose prompt
 *           matches every group in `expectTerms` (any term of a group, case-insensitive,
 *           as a whole word bounded by non-letters, so `pokémon` needs a Unicode-aware
 *           boundary, not `\b`). Below half is a miss. Prompt text is the point here:
 *           these came from reports that semantic search returns look-alikes whose
 *           prompts never name the subject.
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
    if (query.kind === 'subject') {
      if (!query.expectTerms.length || !query.expectTerms.every((group) => group.length))
        throw new Error(`subject "${query.id}" has an empty term group`);
      if (query.targets.some((target) => target !== 'images'))
        throw new Error(`subject "${query.id}" is graded on prompts, so it targets images only`);
    }
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

  // Tester reports: semantic search ignores prompt text and is weak on names and niche terms.
  {
    id: 'subject-foxy-paladin',
    kind: 'subject',
    text: 'foxy paladin',
    expectTerms: [
      ['fox', 'foxy', 'kitsune'],
      ['paladin', 'knight'],
    ],
    k: 10,
    targets: ['images'],
  },
  {
    id: 'subject-nami-yellow-skirt',
    kind: 'subject',
    text: 'nami wearing a yellow skirt',
    expectTerms: [['nami'], ['yellow'], ['skirt', 'miniskirt']],
    k: 10,
    targets: ['images'],
    note: 'Character plus clothing: Nami images in another outfit are a partial miss.',
  },
  {
    id: 'subject-misty-pokemon',
    kind: 'subject',
    text: 'misty pokemon',
    expectTerms: [
      ['misty', 'kasumi'],
      ['pokemon', 'pokémon'],
    ],
    k: 10,
    targets: ['images'],
    note: '"misty" is also an adjective, so a prompt needs the Pokemon context too: foggy scenes or other Pokemon characters are the failure.',
  },
  {
    id: 'subject-gremmy',
    kind: 'subject',
    text: 'Gremmy',
    expectTerms: [['gremmy']],
    k: 10,
    targets: ['images'],
    note: 'Single niche character name with no descriptive words to fall back on.',
  },
]);
