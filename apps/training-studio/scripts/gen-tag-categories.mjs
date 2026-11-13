// Regenerates src/lib/data/tag-categories.json: the tagger's Character and Copyright ("source
// material") tag names, which auto-label drops by default (lib/autolabel-exclude.ts).
//
// Source: cl_tagger tag mapping, the vocabulary of the orchestrator's "cl-tagger.v2" tagger.
//   https://huggingface.co/cella110n/cl_tagger/resolve/0b6e9b4e145b1423bfd1715119074a24a301b471/cl_tagger_1_02/tag_mapping.json
//   mapping version cl_tagger_1_02, repo revision 0b6e9b4e145b1423bfd1715119074a24a301b471
// If the orchestrator moves to a newer mapping, bump both here and re-run:
//   node apps/training-studio/scripts/gen-tag-categories.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REVISION = '0b6e9b4e145b1423bfd1715119074a24a301b471';
const MAPPING = 'cl_tagger_1_02';
const SOURCE = `https://huggingface.co/cella110n/cl_tagger/resolve/${REVISION}/${MAPPING}/tag_mapping.json`;
const OUT = fileURLToPath(new URL('../src/lib/data/tag-categories.json', import.meta.url));

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE}: ${res.status}`);
/** @type {Record<string, { tag: string; category: string }>} */
const mapping = await res.json();

// Stored in the matcher's normal form (lower case, `_` as space) so the app needn't re-normalise.
const norm = (/** @type {string} */ t) => t.toLowerCase().replace(/_/g, ' ').trim();
const pick = (/** @type {string} */ category) =>
  [...new Set(Object.values(mapping).filter((v) => v.category === category).map((v) => norm(v.tag)))].sort();

const out = { character: pick('Character'), source: pick('Copyright') };
if (out.character.length < 1000 || out.source.length < 100)
  throw new Error(`suspiciously small mapping: ${out.character.length} / ${out.source.length}`);
writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log(`wrote ${OUT}: ${out.character.length} character, ${out.source.length} source`);
