/**
 * The canonical model document: one text per model, embedded for semantic search and stored as
 * `search_text` for phrase filters. Until a changed document's re-embed lands, the vector is the
 * previous text's. Ported from
 * civitai/model-search-demo catalog_demo/common.py `document()`.
 */
import { createHash } from 'crypto';

export type ModelVersionSource = {
  id: number;
  name: string;
  description: string | null;
  baseModel: string | null;
  trainedWords: string[] | null;
};

export type ModelSource = {
  id: number;
  name: string;
  type: string;
  username: string | null;
  description: string | null;
  tags: string[];
  /** Published, searchable versions in display order. */
  versions: ModelVersionSource[];
};

export const DOCUMENT_MAX_CHARS = 5_000;
const MAX_TRIGGER_WORDS = 64;
const VERSIONS_IN_TEXT = 3;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

// shortcut: decodes numeric references and the common named ones only. Python's HTMLParser
// knows all of HTML5's; an unknown name stays as written. Widen it if one shows up in documents.
function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, ref: string) => {
    if (ref[0] !== '#') return ENTITIES[ref.toLowerCase()] ?? match;
    const code =
      ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    // A lone surrogate is invalid JSON to Qdrant and would fail the whole upsert batch, every
    // retry; Python's html.unescape maps these, NUL and out-of-range codes to U+FFFD too.
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : '\ufffd';
  });
}

const BLOCK_TAGS =
  /<\/?(p|br|li|ul|ol|div|h[1-6]|td|th|tr|table|blockquote|pre|hr|section|article)\b[^>]*>/gi;

/** Rich-text HTML to one line of plain text: block tags become spaces, script and style vanish. */
export function cleanHtml(value: string | null | undefined) {
  if (!value) return '';
  const text = value
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    // `$`: the description is read truncated, which can end inside a script.
    .replace(/<(script|style)(?=[\s>/])[^>]*>[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
    .replace(BLOCK_TAGS, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

// Python str.isspace(), which `str.split()` splits on. JS `\s` differs: it adds U+FEFF and
// lacks U+001C-U+001F and U+0085. The search service normalises queries in Python.
const PY_WHITESPACE =
  // eslint-disable-next-line no-control-regex -- the control characters are the point
  /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/**
 * The exact-title key. Must equal the search service's
 * `' '.join(unicodedata.normalize('NFKC', s).lower().split())`; punctuation and accents stay.
 */
export function normalizeTitle(name: string) {
  return name.normalize('NFKC').toLowerCase().split(PY_WHITESPACE).filter(Boolean).join(' ');
}

const unique = (values: string[]) => [...new Set(values)];

export function modelDocument(model: ModelSource) {
  const name = cleanHtml(model.name);
  const tags = unique(model.tags.map(cleanHtml).filter(Boolean));
  const triggers = unique(model.versions.flatMap((v) => v.trainedWords ?? [])).slice(
    0,
    MAX_TRIGGER_WORDS
  );
  const baseModels = unique(
    model.versions.map((v) => v.baseModel).filter((b): b is string => !!b)
  ).sort();
  const versionText = model.versions
    .slice(0, VERSIONS_IN_TEXT)
    .map((v) => `${cleanHtml(v.name)}: ${cleanHtml(v.description)}`)
    .join(' ');
  const text = [
    `Name: ${name}`,
    `Type: ${model.type}`,
    `Creator: ${model.username ?? ''}`,
    `Tags: ${tags.join(', ')}`,
    `Base models: ${baseModels.join(', ')}`,
    `Trigger words: ${triggers.join(', ')}`,
    `Description: ${cleanHtml(model.description)}`,
    `Versions: ${versionText}`,
  ]
    .join('\n')
    // Code points, as Python slices; a UTF-16 slice could split a surrogate pair.
    .match(/[\s\S]/gu)!
    .slice(0, DOCUMENT_MAX_CHARS)
    .join('');
  return {
    text,
    baseModels,
    tags,
    triggerWords: triggers,
    docHash: createHash('sha256').update(text).digest('hex'),
  };
}

/** The set bits of a browsing-level bitmask: a model can carry several levels. */
export function nsfwLevels(mask: number) {
  const levels: number[] = [];
  for (let bit = 1; bit > 0 && bit <= mask; bit *= 2) if (mask & bit) levels.push(bit);
  return levels;
}
