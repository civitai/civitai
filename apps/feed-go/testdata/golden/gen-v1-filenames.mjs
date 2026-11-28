// Writes what the v1 models routes' file naming needs from the Node engine itself:
//
//   TZ=UTC node --import tsx apps/feed-go/testdata/golden/gen-v1-filenames.mjs
//
// (from the repo root, with the repo's node_modules: see README.md).
//
// 1. apps/feed-go/internal/v1models/jscanon.json: Canonicalize (ECMA-262 22.2.2.7.3, the
//    non-unicode, ignoreCase branch) of every UTF-16 code unit, as this Node computes it: the code
//    units whose canonical value is not themselves. `replaceInsensitive` (src/utils/string-helpers.ts)
//    builds `new RegExp(<escaped literal>, 'gi')`, and two code units match under that flag exactly
//    when their canonical values are equal. V8 computes it with ICU's toUpper, so the table is this
//    Node's ICU's; every entry is checked here against the RegExp engine itself before it is written,
//    and src/server/services/__tests__/feed-go-js-canonicalize.parity.test.ts recomputes it in the
//    Node the app tests run on, so a Node upgrade that moves it fails there. With it, `trim`: the
//    code units String.prototype.trim removes (the version name is trimmed after the strip).
// 2. testdata/golden/v1-filenames/cases.json: the REAL replaceInsensitive and resolveModelFileName
//    (src/utils/model-file-naming.ts) over names with non-ASCII text, each answer the Node one
//    (internal/v1models/filename_golden_test.go requires Go's to equal it).
//
// Every name is synthetic.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.cwd();
const { replaceInsensitive } = await import(join(REPO, 'src/utils/string-helpers.ts'));
const { resolveModelFileName } = await import(join(REPO, 'src/utils/model-file-naming.ts'));

// --- 1. the canonicalization table ---------------------------------------------------------------

/** Canonicalize(rer, ch) with rer.[[IgnoreCase]] true and rer.[[Unicode]] false. */
function canonicalize(cu) {
  const u = String.fromCharCode(cu).toUpperCase();
  if (u.length !== 1) return cu;
  const c = u.charCodeAt(0);
  if (cu >= 128 && c < 128) return cu;
  return c;
}
const hex4 = (n) => n.toString(16).padStart(4, '0');
/** Whether `/<a>/i` (non-unicode) matches the one code unit b. */
const matches = (a, b) => new RegExp(`^\\u${hex4(a)}$`, 'i').test(String.fromCharCode(b));

const canon = new Uint16Array(0x10000);
for (let cu = 0; cu <= 0xffff; cu++) canon[cu] = canonicalize(cu);
// Classes: every code unit by its canonical value.
const classes = new Map();
for (let cu = 0; cu <= 0xffff; cu++) {
  const c = canon[cu];
  if (!classes.has(c)) classes.set(c, []);
  classes.get(c).push(cu);
}
// The RegExp engine must agree: every pair in a class matches both ways, and each code unit's own
// one-unit lower and upper case forms match it exactly when they share its class.
let checked = 0;
for (const members of classes.values()) {
  if (members.length < 2) continue;
  for (const a of members)
    for (const b of members) {
      if (!matches(a, b))
        throw new Error(`/\\u${hex4(a)}/i does not match \\u${hex4(b)}, same class`);
      checked++;
    }
}
for (let cu = 0; cu <= 0xffff; cu++) {
  if (cu >= 0xd800 && cu <= 0xdfff) continue;
  const ch = String.fromCharCode(cu);
  for (const other of [ch.toLowerCase(), ch.toUpperCase()]) {
    if (other.length !== 1 || other === ch) continue;
    const o = other.charCodeAt(0);
    if (matches(cu, o) !== (canon[cu] === canon[o]))
      throw new Error(`/\\u${hex4(cu)}/i vs \\u${hex4(o)}: the engine and Canonicalize disagree`);
    checked++;
  }
}
const pairs = [];
for (let cu = 0; cu <= 0xffff; cu++) if (canon[cu] !== cu) pairs.push([cu, canon[cu]]);
// String.prototype.trim's set (WhiteSpace and LineTerminator): every code unit trim removes. All of
// them are in the BMP.
const trim = [];
for (let cu = 0; cu <= 0xffff; cu++) if (String.fromCharCode(cu).trim() === '') trim.push(cu);
const table = {
  generator: 'apps/feed-go/testdata/golden/gen-v1-filenames.mjs',
  node: process.version,
  icu: process.versions.icu,
  unicode: process.versions.unicode,
  canon: pairs,
  trim,
};
writeFileSync(
  join(REPO, 'apps/feed-go/internal/v1models/jscanon.json'),
  JSON.stringify(table) + '\n'
);

// --- 2. the naming cases -------------------------------------------------------------------------

const replaceCases = [
  ['Café v2', 'CAFÉ'],
  ['ÖL Model', 'öl'],
  ['Straße v1', 'STRASSE'],
  ['STRASSE v1', 'straße'],
  ['Σίσυφος v1', 'σίσυφοσ'],
  ['ΣΊΣΥΦΟΣ v1', 'σίσυφος'],
  ['kelvin 3', '\u212aelvin'],
  ['\u212aelvin 3', 'kelvin'],
  ['ſpring v1', 'spring'],
  ['İstanbul v1', 'istanbul'],
  ['ıstanbul v1', 'ISTANBUL'],
  ['Ｍｏｄｅｌ v1', 'ｍｏｄｅｌ'],
  ['Модель v3 модель', 'МОДЕЛЬ'],
  ['模型 v1', '模型'],
  ['🐱cat v1 🐱CAT', '🐱cat'],
  ['ǅemal v1', 'ǆemal'],
  ['ᾳ v1', 'ᾼ'],
  ['ﬁle v1', 'FILE'],
  ['aaa', 'aa'],
  ['x', ''],
];
const replaced = replaceCases.map(([value, search]) => ({
  value,
  search,
  result: replaceInsensitive(value, search, ''),
}));

const file = (
  id,
  name,
  type = 'Model',
  metadata = { format: 'SafeTensor', size: 'pruned', fp: 'fp16' }
) => ({
  id,
  name,
  overrideName: null,
  type,
  metadata,
});
const namingCases = [
  { model: { name: 'Café Model', type: 'Checkpoint' }, version: { name: 'CAFÉ MODEL v2' } },
  { model: { name: 'Σίσυφος', type: 'Checkpoint' }, version: { name: 'ΣΊΣΥΦΟΣ XL' } },
  { model: { name: 'Straße', type: 'Checkpoint' }, version: { name: 'STRASSE v1' } },
  {
    model: { name: 'Модель', type: 'Checkpoint' },
    version: { name: '\u00a0модель\u3000v3\u2028' },
  },
  { model: { name: '模型', type: 'Checkpoint' }, version: { name: '模型 v1' } },
  { model: { name: '🐱 Cat', type: 'Checkpoint' }, version: { name: '🐱 CAT v2' } },
  { model: { name: 'Ｍｏｄｅｌ', type: 'VAE' }, version: { name: 'ｍｏｄｅｌ fp16' } },
  { model: { name: 'Kelvin', type: 'Checkpoint' }, version: { name: '\u212aelvin v1' } },
  {
    model: { name: 'Ölbild', type: 'TextualInversion' },
    version: { name: 'ÖLBILD neg', trainedWords: ['ölbild'] },
  },
  { model: { name: 'ǅemal', type: 'Checkpoint' }, version: { name: 'ǆemal\u2003' } },
  // Only a non-ASCII space is left after the strip: trimmed by the engine's set (a leading empty
  // word would capitalise `v2`).
  { model: { name: 'Café', type: 'Checkpoint' }, version: { name: 'Café\u3000v2' } },
].map((c, i) => {
  const base = 7100 + i * 10;
  const files =
    c.model.type === 'TextualInversion'
      ? [file(base, 'model.pt'), file(base + 1, 'negative.pt', 'Negative')]
      : [
          file(base, 'model.safetensors'),
          file(base + 1, 'model.safetensors', 'Model', {
            format: 'SafeTensor',
            size: 'full',
            fp: 'fp32',
          }),
          file(base + 2, 'data.zip', 'Training Data', {}),
        ];
  return {
    ...c,
    files,
    names: files.map((f) =>
      resolveModelFileName({
        model: c.model,
        modelVersion: c.version,
        file: { ...f },
        versionFiles: files,
      })
    ),
  };
});
const outDir = join(HERE, 'v1-filenames');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'cases.json'),
  JSON.stringify({ node: process.version, replace: replaced, naming: namingCases }, null, 2) + '\n'
);
console.log(
  `jscanon.json: ${pairs.length} code units (${checked} engine checks; node ${process.version}, icu ${process.versions.icu}); ` +
    `cases.json: ${replaced.length} replace, ${namingCases.length} naming cases`
);
