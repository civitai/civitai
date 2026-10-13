/**
 * A deterministic, SYNTHETIC benign corpus of the strings App Blocks store in shared storage: the
 * leaves of a `data` blob (values and object keys) and counter keys. It feeds
 * `shared-data-proxy-corpus.test.ts`, which measures how many of them the local shared-data
 * moderation flags.
 *
 * Every string is built here from a seeded PRNG and the small word lists below — no network, no
 * production data, no real ids. The same seed always yields the same corpus, so a measured count
 * is reproducible and a change in it is a change in the detectors (or in this file).
 *
 * What it does NOT model: real users' prose. The English kinds are templates over a fixed benign
 * vocabulary, so they say nothing about slang, typos or other languages.
 */

/**
 * mulberry32, a 32-bit PRNG; not for crypto. A DELIBERATE local copy: the repo's other copies live
 * in an unrelated service (`resource-intent-cooc/build.ts`) and an eval script, and importing either
 * would couple this moderation fixture to them for six lines.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

const int = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];
const chars = (rng: Rng, alphabet: string, length: number) =>
  Array.from({ length }, () => alphabet[Math.floor(rng() * alphabet.length)]).join('');
const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

const HEX = '0123456789abcdef';
/** Crockford base32, as `newUlid` encodes (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ── Vocabulary ─────────────────────────────────────────────────────────────────
// Deliberately plain: scenery, art styles, objects, app-state nouns. No people, ages or bodies —
// those are what the minor/POI detectors exist for, so they are not "benign" in this sense.

const ADJECTIVES = [
  'quiet',
  'golden',
  'misty',
  'bright',
  'ancient',
  'silver',
  'gentle',
  'vivid',
  'frozen',
  'hidden',
  'lonely',
  'endless',
  'crimson',
  'emerald',
  'rusty',
  'velvet',
  'stormy',
  'sunny',
  'cozy',
  'distant',
  'electric',
  'floating',
  'glass',
  'paper',
  'wooden',
  'neon',
  'pastel',
  'autumn',
  'winter',
  'summer',
  'spring',
  'midnight',
  'morning',
  'northern',
  'coastal',
  'mountain',
  'desert',
  'forest',
  'urban',
  'rural',
  'tiny',
  'giant',
  'soft',
  'sharp',
  'warm',
  'cold',
  'calm',
  'wild',
  'clever',
  'simple',
] as const;

const NOUNS = [
  'harbor',
  'lighthouse',
  'meadow',
  'river',
  'castle',
  'garden',
  'valley',
  'forest',
  'island',
  'bridge',
  'tower',
  'village',
  'canyon',
  'lake',
  'cottage',
  'station',
  'library',
  'market',
  'orchard',
  'glacier',
  'waterfall',
  'temple',
  'workshop',
  'observatory',
  'greenhouse',
  'train',
  'airship',
  'sailboat',
  'lantern',
  'teapot',
  'bicycle',
  'robot',
  'dragon',
  'fox',
  'owl',
  'whale',
  'cat',
  'dog',
  'horse',
  'butterfly',
  'mushroom',
  'cactus',
  'sunflower',
  'comet',
  'nebula',
  'planet',
  'moon',
  'cloud',
  'storm',
  'city',
] as const;

const STYLES = [
  'watercolor',
  'oil painting',
  'pixel art',
  'line art',
  'concept art',
  'isometric',
  'low poly',
  'photorealistic',
  'cinematic lighting',
  'studio lighting',
  'film grain',
  'bokeh',
  'macro',
  'long exposure',
  'double exposure',
  'flat colors',
  'cel shading',
  'ink wash',
  'charcoal sketch',
  'pencil sketch',
  'vaporwave',
  'cyberpunk',
  'steampunk',
  'art nouveau',
  'art deco',
  'ukiyo-e',
  'impressionism',
  'surrealism',
  'minimalism',
  'baroque',
  'gothic',
  'fantasy',
  'sci-fi',
  'retro',
  'vintage',
  'claymation',
  'papercraft',
  'stained glass',
  'mosaic',
  'blueprint',
] as const;

const MODEL_STEMS = [
  'Dream',
  'Vision',
  'Photon',
  'Juggernaut',
  'Proto',
  'Aurora',
  'Nova',
  'Atlas',
  'Pixel',
  'Canvas',
  'Lumen',
  'Prism',
  'Echo',
  'Zephyr',
  'Ember',
  'Horizon',
  'Mosaic',
  'Velvet',
  'Quartz',
  'Willow',
  'Orbit',
  'Cosmic',
  'Neon',
  'Sketch',
  'Studio',
] as const;
const MODEL_SUFFIXES = [
  'Shaper',
  'Mix',
  'Diffusion',
  'Merge',
  'Craft',
  'Forge',
  'Blend',
  'Engine',
  'Works',
  'Style',
] as const;
const MODEL_FAMILIES = ['SD 1.5', 'SDXL', 'Pony', 'Flux', 'Illustrious', 'SD 3.5'] as const;
const MODEL_KINDS = ['LoRA', 'Checkpoint', 'Embedding', 'LyCORIS', 'VAE'] as const;

const TITLE_TEMPLATES = [
  (a: string, n: string) => `The ${capitalize(a)} ${capitalize(n)}`,
  (a: string, n: string) => `A ${capitalize(a)} ${capitalize(n)} at Dawn`,
  (a: string, n: string) => `Journey to the ${capitalize(a)} ${capitalize(n)}`,
  (a: string, n: string) => `${capitalize(a)} ${capitalize(n)} Collection`,
  (a: string, n: string) => `Notes from the ${capitalize(n)}`,
  (a: string, n: string) => `My ${capitalize(a)} ${capitalize(n)} Series`,
  (a: string, n: string) => `${capitalize(n)} Study No. ${a.length}`,
  (a: string, n: string) => `Weekly Challenge: ${capitalize(a)} ${capitalize(n)}`,
] as const;

const SENTENCE_TEMPLATES = [
  (a: string, n: string, s: string) => `I really like how the ${n} turned out in ${s}.`,
  (a: string, n: string, s: string) => `Tried a ${a} ${n} with a ${s} look, what do you think?`,
  (a: string, n: string) => `This ${a} ${n} took me about three hours to finish.`,
  (a: string, n: string, s: string) => `Great work on the ${n}, the ${s} style fits it well.`,
  (a: string, n: string) => `Could you share the settings you used for the ${a} ${n}?`,
  (a: string, n: string) => `Voting for the ${a} ${n} this round.`,
  (a: string, n: string, s: string) =>
    `Next week the theme is ${s}, so start thinking about a ${n}.`,
  (a: string, n: string) => `Thanks for playing! Your ${n} scored well today.`,
  (a: string, n: string) => `The ${a} light on the ${n} is lovely.`,
  (a: string, n: string, s: string) => `Added a new ${n} to my ${s} board.`,
] as const;

// camelCase app-state field names: a verb/qualifier prefix and a noun, optionally a suffix.
const KEY_HEADS = [
  'user',
  'created',
  'updated',
  'last',
  'high',
  'total',
  'current',
  'next',
  'prev',
  'is',
  'has',
  'play',
  'vote',
  'score',
  'round',
  'game',
  'entry',
  'image',
  'model',
  'post',
  'collection',
  'tag',
  'theme',
  'display',
  'sort',
  'page',
  'max',
  'min',
  'avg',
  'selected',
] as const;
const KEY_TAILS = [
  'Id',
  'At',
  'Count',
  'Score',
  'Name',
  'Url',
  'Index',
  'Total',
  'Rank',
  'Votes',
  'Plays',
  'Order',
  'Status',
  'Version',
  'Seed',
  'Width',
  'Height',
  'Label',
  'Title',
  'Ids',
  'Enabled',
  'Visible',
  'Locked',
  'Played',
  'Updated',
  'Mode',
  'Size',
  'Offset',
  'Limit',
  'Color',
] as const;
const KEY_SUFFIXES = ['', '', '', 'Ms', 'List', 'Map', 'V2'] as const;

const COUNTER_PREFIXES = [
  'playcount',
  'votes',
  'likes',
  'views',
  'plays',
  'wins',
  'score',
  'entries',
  'picks',
  'clicks',
] as const;

/** The platform's own public hosts — the URLs an app on it links back to. */
const PLATFORM_HOSTS = ['civitai.com', 'civitai.green'] as const;

// ── Generators ─────────────────────────────────────────────────────────────────

/** A ULID: 10 Crockford chars of a 2020–2030 millisecond timestamp, then 16 random ones. */
function ulid(rng: Rng): string {
  let time = int(rng, Date.UTC(2020, 0, 1), Date.UTC(2030, 0, 1));
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  return head + chars(rng, CROCKFORD, 16);
}

/** A v4 UUID, lowercase, as `crypto.randomUUID()` writes it. */
function uuid(rng: Rng): string {
  const h = chars(rng, HEX, 32).split('');
  h[12] = '4';
  h[16] = '89ab'[int(rng, 0, 3)];
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** A numeric id as a string, 1–10 digits (spread over magnitudes, not uniform over the range). */
function numericId(rng: Rng): string {
  return String(int(rng, 1, 10 ** int(rng, 1, 10) - 1));
}

function slug(rng: Rng): string {
  return [pick(rng, ADJECTIVES), pick(rng, NOUNS), pick(rng, STYLES)]
    .join('-')
    .replace(/\s+/g, '-');
}

function counterKey(rng: Rng): string {
  const id = pick(rng, [numericId, ulid, uuid] as const)(rng);
  const prefix = pick(rng, COUNTER_PREFIXES);
  // Some apps nest a sub-key (`votes:<round>:<entry>`).
  return rng() < 0.25 ? `${prefix}:${int(rng, 1, 52)}:${id}` : `${prefix}:${id}`;
}

function platformUrl(rng: Rng): string {
  const host = `https://${pick(rng, PLATFORM_HOSTS)}`;
  const id = int(rng, 1, 2_500_000);
  const shapes = [
    () => `${host}/models/${id}/${slug(rng)}`,
    () => `${host}/models/${id}?modelVersionId=${int(rng, 1, 3_000_000)}`,
    () => `${host}/images/${int(rng, 1, 90_000_000)}`,
    () => `${host}/posts/${int(rng, 1, 20_000_000)}`,
    () => `${host}/articles/${id}/${slug(rng)}`,
    () => `${host}/collections/${id}`,
    () => `${host}/tag/${pick(rng, STYLES).replace(/\s+/g, '%20')}`,
    () => `${host}/apps/${pick(rng, NOUNS)}-${pick(rng, NOUNS)}`,
  ];
  return pick(rng, shapes)();
}

function modelName(rng: Rng): string {
  const name = `${pick(rng, MODEL_STEMS)}${pick(rng, MODEL_SUFFIXES)}`;
  const version = `v${int(rng, 1, 9)}.${int(rng, 0, 9)}`;
  const shapes = [
    () => `${name} ${pick(rng, MODEL_FAMILIES)} ${version}`,
    () => `${name} ${version}`,
    () =>
      `${capitalize(pick(rng, ADJECTIVES))} ${capitalize(pick(rng, NOUNS))} ${pick(
        rng,
        MODEL_KINDS
      )}`,
    // A checkpoint FILE name, as model resources are often referred to.
    () => `${name.charAt(0).toLowerCase()}${name.slice(1)}_${version.replace('.', '')}.safetensors`,
    () => `${pick(rng, STYLES)} style ${pick(rng, MODEL_KINDS)} (${pick(rng, MODEL_FAMILIES)})`,
  ];
  return pick(rng, shapes)();
}

function tagWord(rng: Rng): string {
  const shapes = [
    () => pick(rng, STYLES),
    () => pick(rng, NOUNS),
    () => pick(rng, ADJECTIVES),
    () => `${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)}`,
  ];
  return pick(rng, shapes)();
}

function title(rng: Rng): string {
  return pick(rng, TITLE_TEMPLATES)(pick(rng, ADJECTIVES), pick(rng, NOUNS));
}

function sentence(rng: Rng): string {
  return pick(rng, SENTENCE_TEMPLATES)(pick(rng, ADJECTIVES), pick(rng, NOUNS), pick(rng, STYLES));
}

function jsonKey(rng: Rng): string {
  return `${pick(rng, KEY_HEADS)}${pick(rng, KEY_TAILS)}${pick(rng, KEY_SUFFIXES)}`;
}

/**
 * Each kind, where it lives in shared storage, and its generator.
 *
 * `surface` decides which live entry point the test sends it through: `value` → a string leaf of a
 * `data` blob, `key` → an object key of a `data` blob, `counter` → a counter key.
 */
export const PROXY_CORPUS_KINDS = {
  ulid: { surface: 'value', generate: ulid },
  uuid: { surface: 'value', generate: uuid },
  sha1_hex: { surface: 'value', generate: (rng: Rng) => chars(rng, HEX, 40) },
  sha256_hex: { surface: 'value', generate: (rng: Rng) => chars(rng, HEX, 64) },
  numeric_id: { surface: 'value', generate: numericId },
  counter_key: { surface: 'counter', generate: counterKey },
  platform_url: { surface: 'value', generate: platformUrl },
  model_name: { surface: 'value', generate: modelName },
  tag_word: { surface: 'value', generate: tagWord },
  english_title: { surface: 'value', generate: title },
  english_sentence: { surface: 'value', generate: sentence },
  json_key: { surface: 'key', generate: jsonKey },
} as const;

export type ProxyCorpusKind = keyof typeof PROXY_CORPUS_KINDS;
export type ProxyCorpusSurface = (typeof PROXY_CORPUS_KINDS)[ProxyCorpusKind]['surface'];

/**
 * Up to `target` DISTINCT strings of one kind. A kind with a small space (tags, field names) can
 * run out before `target`; the attempt cap makes that a short corpus the test can see and assert
 * on, never a hang.
 */
export function generateKind(kind: ProxyCorpusKind, seed: number, target: number): string[] {
  // One stream per kind, so adding a kind (or changing one generator) leaves the others unchanged.
  const kindSalt = [...kind].reduce((acc, ch) => Math.imul(acc ^ ch.charCodeAt(0), 16777619), seed);
  const rng = seededRandom(kindSalt);
  const out = new Set<string>();
  const maxAttempts = target * 50;
  for (let attempt = 0; attempt < maxAttempts && out.size < target; attempt++) {
    out.add(PROXY_CORPUS_KINDS[kind].generate(rng));
  }
  return [...out];
}
