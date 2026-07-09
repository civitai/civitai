import { ModelType } from '~/shared/utils/prisma/enums';

const p = {
  textualInversion: `[\\w\\_\\.-]+`,
  fileName: `[\\w\\_\\.-]+`,
  strength: `[0-9.]+`,
};

const regexSplitPatterns = {
  lora: `<lora:${p.fileName}:${p.strength}>`,
  lyco: `<lyco:${p.fileName}:${p.strength}>`,
  textualInversion: `#${p.textualInversion}`,
};
const splitRegExp = new RegExp(`(${Object.values(regexSplitPatterns).join('|')})`, 'g');

const regexGroupPatterns = {
  assertion: /<(lora|lyco):([a-zA-Z0-9_\.-]+):([0-9.]+)>/g,
  textualInversion: /#([a-zA-Z0-9_\.-]+)/g,
};

type PromptResource = {
  type: ModelType;
  name: string;
  strength?: string;
};

type PromptResourceType = 'lora' | 'lyco';
const typeConversions: Record<PromptResourceType, ModelType> = {
  lora: ModelType.LORA,
  lyco: ModelType.LoCon,
};

const convertType = (type: string) => {
  return typeConversions[type as PromptResourceType];
};

export const splitPromptResources = (value: string) => {
  return value.split(splitRegExp);
};

export const parsePromptResources = (value: string) => {
  const assertions = [...value.matchAll(regexGroupPatterns.assertion)].reduce<PromptResource[]>(
    (acc, [, type, name, strength]) => [
      ...acc,
      { type: convertType(type), name, strength } as PromptResource,
    ],
    []
  );
  const textualInversions = [...value.matchAll(regexGroupPatterns.textualInversion)].map(
    ([, name]) => ({
      type: ModelType.TextualInversion,
      name,
    })
  ) as PromptResource[];
  return [...assertions, ...textualInversions];
};

// Character set for a wildcard category name — the SINGLE source of truth shared by:
//   - the prompt `#ref` parser (here, `snippetReferencePattern`),
//   - the import `__nested__` parser (`NESTED_REFERENCE_PATTERN` in wildcard-set-provisioning.service.ts),
//   - the save-time validator (`categoryNameSchema` in wildcard-set.schema.ts).
// Those three differ only in their delimiter (`#…`, `__…__`, `^…$`) — the charset MUST stay
// identical across them, or a name becomes importable but unreferenceable (the `#80s` bug).
//
// Path-style names allow `/`, `.`, `-` (wider than the textual-inversion charset above, which
// forbids `/`) so refs like `#character/female` are unambiguously snippets. The first char may be
// any letter or DIGIT (e.g. `80s`); only leading `_`/`.`/`/`/`-` are excluded — a leading `_`
// would make the `__…__` import delimiter ambiguous.
export const WILDCARD_CATEGORY_NAME = String.raw`[A-Za-z0-9][\w./-]*`;

// Server-side, snippet expansion runs first; unmatched `#tokens` then fall through to the TI
// parser. A `#name` that matches both regexes resolves to the snippet when the user has a category
// named `name` and to the TI when they don't (per the product doc's collision-resolution rule).
export const snippetReferencePattern = new RegExp(`#(${WILDCARD_CATEGORY_NAME})`, 'g');

export type SnippetReference = {
  /** The captured name without the leading `#`, e.g. `character` or `BoChars/female/modern`. */
  category: string;
  /** Inclusive index of the leading `#` in the source string. */
  start: number;
  /** Exclusive index one past the last character of the match. */
  end: number;
};

/**
 * Parse `#category` references from a prompt template. Each occurrence is
 * returned as a separate entry in document order — repeated references are
 * NOT deduplicated, because slot-counting (`"#character fights #character"`
 * = two slots, no-repeat rule) needs to see each one individually. Callers
 * that want unique names can pull them with `new Set(refs.map((r) => r.category))`.
 *
 * Names are returned exactly as captured. Case-folding for category lookup
 * happens at the DB layer (citext on `WildcardSetCategory.name`); preserving
 * casing here lets editors render the chip with the user's spelling.
 */
export const parsePromptSnippetReferences = (value: string): SnippetReference[] => {
  const out: SnippetReference[] = [];
  for (const match of value.matchAll(snippetReferencePattern)) {
    if (match.index === undefined) continue;
    out.push({
      category: match[1],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return out;
};
