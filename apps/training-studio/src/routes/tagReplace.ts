import { splitTags } from './trainingFlow';

export interface ReplaceOptions {
  find: string;
  replace: string;
  /** `find` is a regular expression (and `replace` may use $1, $&); otherwise both are literal text. */
  regex: boolean;
  matchCase: boolean;
}

export interface ReplaceChange {
  id: number;
  before: string[];
  after: string[];
}

export interface ReplacePlan {
  /** Inline message when the pattern is unusable; `changes` is then empty and nothing may be applied. */
  error: string | null;
  changes: ReplaceChange[];
  /** Labeled images this replace would leave with no tags at all — they become unlabeled. */
  emptied: number;
}

const EMPTY_MATCH = 'This pattern matches empty text, so it would match everywhere.';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pattern for these options, or an error to show inline. An empty find, an invalid regex and a
 *  regex that matches the empty string (it would match between every character) are all refused. */
export function compileFind(
  o: Pick<ReplaceOptions, 'find' | 'regex' | 'matchCase'>
): { re: RegExp; error: null } | { re: null; error: string | null } {
  if (o.find === '') return { re: null, error: null };
  const flags = o.matchCase ? 'g' : 'gi';
  let re: RegExp;
  try {
    re = new RegExp(o.regex ? o.find : escapeRegex(o.find), flags);
  } catch (e) {
    return {
      re: null,
      error: `Invalid pattern: ${
        e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : String(e)
      }`,
    };
  }
  if (new RegExp(re.source, re.flags).test('')) {
    return { re: null, error: EMPTY_MATCH };
  }
  return { re, error: null };
}

/** Map each tag through the replace, then split the result (a replacement may add commas) and dedupe in
 *  order, like a rename. Images whose tags don't change are left out of `changes`; unlabeled images are
 *  never touched. An empty find box yields no error and no changes. */
export function planReplace(
  images: { id: number; tags: string[] }[],
  o: ReplaceOptions
): ReplacePlan {
  const { re, error } = compileFind(o);
  if (!re) return { error, changes: [], emptied: 0 };
  const changes: ReplaceChange[] = [];
  let emptied = 0;
  for (const img of images) {
    if (img.tags.length === 0) continue;
    const seen = new Set<string>();
    const after: string[] = [];
    for (const tag of img.tags) {
      // A tag the pattern doesn't touch is kept verbatim: only matched tags go through splitTags, or an
      // image holding an unnormalised tag would count as "affected" by a find that matches nothing.
      if (tag.search(re) === -1) {
        if (!seen.has(tag)) {
          seen.add(tag);
          after.push(tag);
        }
        continue;
      }
      // A zero-width match (\b, a lookahead) passes the compile-time empty check but still hits everywhere.
      if (Array.from(tag.matchAll(re)).some((m) => m[0] === ''))
        return { error: EMPTY_MATCH, changes: [], emptied: 0 };
      // Function replacer for plain text so a "$&" the user typed stays literal.
      const mapped = o.regex ? tag.replace(re, o.replace) : tag.replace(re, () => o.replace);
      for (const t of splitTags(mapped)) {
        if (!seen.has(t)) {
          seen.add(t);
          after.push(t);
        }
      }
    }
    if (after.length === img.tags.length && after.every((t, i) => t === img.tags[i])) continue;
    changes.push({ id: img.id, before: [...img.tags], after });
    if (after.length === 0) emptied++;
  }
  return { error: null, changes, emptied };
}

/** A dataset tag with its casings folded together (`Orange hair`, `orange hair`). `tag` is the most-used
 *  casing (first seen on a tie) and `count` the images carrying any of `variants`. */
export interface TagGroup {
  tag: string;
  count: number;
  variants: string[];
}

/** The dataset's tags grouped case-insensitively, most-used first — so one tag typed two ways is one row. */
export function groupTags(images: { tags: string[] }[]): TagGroup[] {
  const groups = new Map<string, { count: number; casings: Map<string, number> }>();
  for (const img of images) {
    const seen = new Set<string>();
    for (const t of img.tags) {
      const key = t.toLowerCase();
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { count: 0, casings: new Map() }));
      g.casings.set(t, (g.casings.get(t) ?? 0) + 1);
      if (!seen.has(key)) {
        seen.add(key);
        g.count++;
      }
    }
  }
  return [...groups.values()]
    .map(({ count, casings }) => {
      const variants = [...casings.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
      return { tag: variants[0]!, count, variants };
    })
    .sort((a, b) => b.count - a.count);
}

/** `tags` with every casing of `from` replaced in place by `to`. Deduped case-insensitively, keeping the
 *  first position; a tag named in `to` takes the casing typed there, so renaming a group to its own name
 *  merges its casings into that one. Tags without `from` come back as the same array, untouched. */
export function renameTag(tags: string[], from: string, to: string[]): string[] {
  const fromKey = from.toLowerCase();
  if (!tags.some((t) => t.toLowerCase() === fromKey)) return tags;
  const typed = new Map(to.map((t) => [t.toLowerCase(), t]));
  const seen = new Set<string>();
  const next: string[] = [];
  for (const t of tags) {
    for (const mapped of t.toLowerCase() === fromKey ? to : [t]) {
      const key = mapped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(typed.get(key) ?? mapped);
    }
  }
  return next;
}

/** `tags` without any casing of `tag`. */
export function removeTag(tags: string[], tag: string): string[] {
  const key = tag.toLowerCase();
  return tags.filter((t) => t.toLowerCase() !== key);
}

/** `tags` with each of `add` it lacks in every casing prepended — where a trigger-like tag belongs. */
export function prependTags(tags: string[], add: string[]): string[] {
  const have = new Set(tags.map((t) => t.toLowerCase()));
  const missing = add.filter((t) => {
    const key = t.toLowerCase();
    if (have.has(key)) return false;
    have.add(key);
    return true;
  });
  return missing.length ? [...missing, ...tags] : tags;
}
