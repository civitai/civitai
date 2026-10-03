import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every entry in the two target arrays `processUserContentRemovalQueue` filter-deletes from —
 * `mainIndexConfigs` and `metricsIndexConfigs`, named literally below — must be a LIVE search index
 * whose declared filterable attributes include EVERY attribute its filter names.
 *
 * 🔴 WHY. The purge is how a banned user's content leaves search. Its `processIndex` swallows
 * every failure into a log line, so a target that cannot accept the filter is silent: the batch
 * reports success and the content stays indexed. Two ways a target stops accepting it, both
 * invisible to any suite that mocks Meilisearch:
 *
 *   - the index is RETIRED. A retired processor returns early from `reset`, which is the only
 *     path that configures an index's settings, so nothing ever gives the live index its
 *     filterable attributes and every filtered delete is rejected. `getOrCreateIndex` in the
 *     purge will happily create the index bare in the process.
 *   - an attribute the filter names is not declared filterable for that index at all. ANY one of
 *     them is enough: Meilisearch rejects the whole filter, not the offending clause.
 *
 * The images entry was the first case for two weeks and nothing went red.
 *
 * 🔴 WHAT THIS DOES NOT CHECK, stated so nobody reads it as wider than it is. These are the blind
 * spots known when it was written, audited against what the body below actually does — but the
 * list is NOT asserted exhaustive, so read it as the floor and not the boundary. The one property
 * that IS closed: nothing is skipped quietly. Every entry the parse cannot decide is reported, so
 * no hole here is a target this guard looked at and waved through.
 *
 *   - It compares the purge's targets against what the REPO DECLARES — the `retired` flag on the
 *     owning processor and the filterable-attribute arrays. It cannot see the live backend, so an
 *     index whose declared settings were never applied still passes. Declared state is the half a
 *     commit can regress, and the only half a test can hold.
 *   - It reads the two array literals named above and nothing else. A third list, a `.push` onto
 *     one of them, an entry spread in from elsewhere, or a target passed straight to
 *     `processIndex` is invisible to it. If you add a purge target by any route other than a
 *     literal entry in those two arrays, this guard will not see it — and the counts below will
 *     not move either. RENAMING or RELOCATING either array is NOT in this hole: the declaration
 *     then resolves to nothing, the lists parse to zero entries, and the exact counts go red.
 *   - It reads `retired: true` as a line of its own, so the same flag written inline beside
 *     another field — `retired: true, indexName: INDEX_ID,` — is not seen and the index reads as
 *     LIVE. Left textual on purpose: deciding it structurally means parsing the processor config
 *     object, widening this guard for a case the repo's own formatter already normalises —
 *     prettier 2.8.8 (`package.json`) puts the flag back on its own line, and `prettier --check`
 *     fails the inline form rather than accepting it.
 *   - It does not check WHICH client an entry is routed through. `mainIndexConfigs` is handed the
 *     main search client and `metricsIndexConfigs` the metrics one; an entry in the wrong array is
 *     parsed, resolved and checked identically here, and passes.
 *   - It checks only that each attribute a filter NAMES is declared filterable. It says nothing
 *     about whether the filter selects the right documents (that the stored value matches the
 *     interpolated one, or that the username escaping is correct), and nothing about whether the
 *     queue is drained at all — remove every caller of `processUserContentRemovalQueue` and every
 *     assertion below still passes.
 *
 * Within those two arrays the parse is STRUCTURAL, not shape-spelled: entries are found by brace
 * matching and their fields by key, so key order, line breaks (prettier reformats past
 * `printWidth: 100`) and trailing commas are all handled. Each filter is split on its top-level
 * `AND`/`OR` connectives and EVERY attribute it names is checked, so a compound filter cannot
 * carry an undeclared attribute past on the back of a declared first one. An entry whose `name`
 * or `filter` the parser cannot resolve to a literal, and a filter clause whose operator shape it
 * does not recognise, are both REPORTED, never skipped — a skip is how the counts below would
 * silently go short again.
 *
 * The entry counts are asserted exactly, so an entry added beside a guarded one in either of those
 * two arrays cannot arrive unreviewed: the count has to move in the same commit.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PURGE_FILE = 'src/server/meilisearch/util.ts';
const ATTR_FILE = 'src/server/search-index/filterable-attributes.ts';
const INDEX_DIR = 'src/server/search-index';

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/**
 * A slice of source paired with a length-preserving MASK of itself: the mask keeps every
 * structural character (braces, brackets, commas, colons, quote delimiters, newlines) and blanks
 * the CONTENTS of comments and of string/template literals to spaces.
 *
 * Everything structural below is scanned on `masked` and sliced out of `text` at the same offsets.
 * That is what makes the parse immune to a `//` comment containing a brace, an apostrophe in
 * prose, or a `[` inside a filter template.
 */
type Source = { text: string; masked: string };

const slice = (src: Source, from: number, to: number): Source => ({
  text: src.text.slice(from, to),
  masked: src.masked.slice(from, to),
});

/**
 * Blank comment and literal CONTENTS from `text`, preserving length, newlines and delimiters.
 *
 * Deliberately started at a known-code offset by every caller (an array's `[`), because a regex
 * literal containing a quote — `.replace(/"/g, …)` appears in the purge file — would otherwise be
 * misread as opening a string. A nested template (`${`…`}`) is not modelled; one would derail the
 * parse into an unresolvable entry or a moved count, i.e. loudly, which is the point.
 */
function maskLiterals(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '//') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (text[i] === `'` || text[i] === '"' || text[i] === '`') {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === quote) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join('');
}

/** The body of an array literal, by bracket depth on the mask. */
function arrayBody(text: string, declaration: RegExp): Source | null {
  const m = declaration.exec(text);
  if (!m) return null;
  const open = text.indexOf('[', m.index + m[0].length - 1);
  if (open === -1) return null;
  const masked = maskLiterals(text.slice(open));
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '[') depth++;
    else if (masked[i] === ']' && --depth === 0)
      return { text: text.slice(open + 1, open + i), masked: masked.slice(1, i) };
  }
  return null;
}

/** Single-quoted literals in an array body, located on the mask so comments cannot contribute. */
function stringLiterals(body: Source): string[] {
  const found: string[] = [];
  for (let i = 0; i < body.masked.length; i++) {
    if (body.masked[i] !== `'`) continue;
    const close = body.masked.indexOf(`'`, i + 1);
    if (close === -1) break;
    found.push(body.text.slice(i + 1, close));
    i = close;
  }
  return found;
}

/** Top-level `{...}` spans of an array body — one per entry, however it is laid out. */
function objectSpans(body: Source): Source[] {
  const spans: Source[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.masked.length; i++) {
    const c = body.masked[i];
    if (c === '{') {
      if (depth++ === 0) start = i;
    } else if (c === '}' && depth > 0 && --depth === 0 && start !== -1) {
      spans.push(slice(body, start, i + 1));
      start = -1;
    }
  }
  return spans;
}

/** `key: value` fields of one `{...}` span, plus anything in it that is not a keyed field. */
function fields(span: Source): { keys: Record<string, string>; extras: string[] } {
  const inner = slice(span, 1, span.masked.length - 1);
  const parts: Source[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.masked.length; i++) {
    const c = inner.masked[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(slice(inner, start, i));
      start = i + 1;
    }
  }
  parts.push(slice(inner, start, inner.masked.length));

  const keys: Record<string, string> = {};
  const extras: string[] = [];
  for (const part of parts) {
    if (!part.text.trim()) continue; // whitespace, or what a trailing comma leaves behind
    const colon = part.masked.indexOf(':');
    const key = colon === -1 ? '' : part.text.slice(0, colon).trim();
    if (!key || !/^[A-Za-z_$][\w$]*$/.test(key)) {
      extras.push(part.text.replace(/\s+/g, ' ').trim());
      continue;
    }
    keys[key] = part.text.slice(colon + 1).trim();
  }
  return { keys, extras };
}

const ATTRIBUTE_PATH = '[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*';

/**
 * One filter clause, with the attribute it constrains captured first.
 *
 * The operator set is Meilisearch's, narrowed to the forms this repo actually writes:
 * `IN [...]` / `NOT IN [...]` (every purge entry, and `user.service.ts`), the comparisons and
 * equality (`makeMeiliImageSearchFilter('sortAtUnix', '<= …')`), `EXISTS` / `IS NULL` and their
 * negations (`'publishedAtUnix NOT EXISTS'`, `'postId IS NOT NULL'`), and a `… TO …` range.
 * A clause outside it is REPORTED, not skipped — see `filterAttributes`.
 */
const CLAUSE = new RegExp(
  `^(${ATTRIBUTE_PATH})\\s+(?:` +
    `(?:NOT\\s+)?IN\\s*\\[[\\s\\S]*\\]` +
    `|(?:NOT\\s+)?EXISTS` +
    `|IS\\s+(?:NOT\\s+)?(?:NULL|EMPTY)` +
    `|(?:=|!=|>=|<=|>|<)\\s*[\\s\\S]+` +
    `|\\S+\\s+TO\\s+\\S+` +
    `)$`,
  'i'
);

/**
 * Top-level `AND`/`OR` connectives of a filter. Depth tracks `[]`, `()` and `{}` so a connective
 * inside an interpolated value list or a parenthesised group cannot split the filter. A quoted
 * value containing the word is not modelled: a wrong split leaves clauses that fail `CLAUSE`,
 * i.e. it fails loudly as unresolvable rather than resolving to the wrong attribute.
 */
function splitClauses(literal: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < literal.length) {
    const c = literal[i];
    if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') depth--;
    else if (depth === 0) {
      // `(?=\s)` so an attribute merely BEGINNING with the word (`orderedAt`) cannot split.
      const connective = /^\s+(?:AND|OR)(?=\s)/i.exec(literal.slice(i));
      if (connective) {
        parts.push(literal.slice(start, i));
        i += connective[0].length;
        start = i;
        continue;
      }
    }
    i++;
  }
  parts.push(literal.slice(start));
  return parts;
}

/**
 * EVERY attribute a filter references, or `null` when this guard cannot decide what they are.
 *
 * 🔴 Every one, not the first. Meilisearch rejects the WHOLE filter if any attribute in it is not
 * filterable, and `processIndex` swallows that rejection — so resolving on the first clause alone
 * passed `user.id IN [...] OR nope IN [...]`, which is exactly the silent failure this file
 * exists to stop. `null` is reported as a violation by `violations`, never skipped.
 */
function filterAttributes(literal: string): string[] | null {
  const found: string[] = [];
  for (const raw of splitClauses(literal)) {
    let clause = raw.trim();
    const negated = /^NOT\s+/i.exec(clause);
    if (negated) clause = clause.slice(negated[0].length).trim();
    if (clause.length > 1 && clause.startsWith('(') && clause.endsWith(')')) {
      const nested = filterAttributes(clause.slice(1, -1));
      if (nested === null) return null;
      found.push(...nested);
      continue;
    }
    const m = CLAUSE.exec(clause);
    if (!m) return null;
    found.push(m[1]);
  }
  return found.length ? found : null;
}

type Target = { constName: string; filter: string };
/** One parsed entry: either a resolved target, or the reason the parser could not resolve it. */
type Entry = { source: string } & ({ target: Target } | { unresolved: string });

/** Wrap a hand-written target so the controls below exercise the same `violations` path. */
const synthetic = (target: Target): Entry => ({ source: '<synthetic>', target });

function parseEntry(span: Source): Entry {
  const source = span.text.replace(/\s+/g, ' ').trim();
  const { keys, extras } = fields(span);
  const at = (why: string): Entry => ({ source, unresolved: why });

  if (extras.length) return at(`not readable as \`key: value\` fields: ${extras.join(' | ')}`);

  const unexpected = Object.keys(keys).filter((k) => k !== 'name' && k !== 'filter');
  if (unexpected.length)
    return at(`carries field(s) this guard does not model: ${unexpected.join(', ')}`);

  const name = keys.name;
  if (name === undefined) return at('declares no `name`');
  if (!/^[A-Z][A-Z0-9_]*$/.test(name))
    return at(`\`name: ${name}\` is not a bare index constant this guard can resolve`);

  const filter = keys.filter;
  if (filter === undefined) return at(`${name}: declares no \`filter\``);
  if (filter.length < 2 || !filter.startsWith('`') || !filter.endsWith('`'))
    return at(
      `${name}: \`filter: ${filter}\` is not a template literal, so the attribute it filters on ` +
        `cannot be read here. Inline the filter, or teach this guard to follow the reference — ` +
        `do not leave the entry unchecked.`
    );

  // The attributes the filter names are resolved in `violations`, so a hand-written control can
  // feed a raw filter string through the same derivation the real entries get.
  return { source, target: { constName: name, filter: filter.slice(1, -1) } };
}

function entries(arrayName: string): Entry[] {
  const body = arrayBody(read(PURGE_FILE), new RegExp(`const\\s+${arrayName}\\s*=\\s*\\[`));
  if (body === null) return [];
  return objectSpans(body).map(parseEntry);
}

/** Index constant -> the `*.search-index.ts` processors that build it. */
const processorsByConst: Record<string, string[]> = {};
for (const entry of readdirSync(path.join(REPO_ROOT, INDEX_DIR))) {
  if (!entry.endsWith('.search-index.ts')) continue;
  const rel = `${INDEX_DIR}/${entry}`;
  const m = read(rel).match(/const\s+INDEX_ID\s*=\s*([A-Z][A-Z0-9_]*)\s*;/);
  if (m) (processorsByConst[m[1]] ??= []).push(rel);
}

/** `retired: true` on the processor config — the state, not the word appearing somewhere. */
const isRetired = (constName: string) =>
  (processorsByConst[constName] ?? []).some((rel) =>
    /^\s*retired:\s*true\s*,?\s*$/m.test(read(rel))
  );

/**
 * Declared filterable attributes for an index constant: the `filterableAttributesByIndex` map
 * where it is listed, otherwise the owning processor's own `filterableAttributes` export (the
 * metrics index declares its own and is not in the map).
 */
function declaredFilterable(constName: string): string[] | null {
  const attrText = read(ATTR_FILE);
  const mapped = attrText.match(new RegExp(`\\[\\s*${constName}\\s*\\]\\s*:\\s*(\\w+)`));
  if (mapped) {
    const body = arrayBody(attrText, new RegExp(`export\\s+const\\s+${mapped[1]}\\s*=\\s*\\[`));
    if (body !== null) return stringLiterals(body);
  }
  for (const rel of processorsByConst[constName] ?? []) {
    const body = arrayBody(read(rel), /export\s+const\s+filterableAttributes\s*=\s*\[/);
    if (body !== null) return stringLiterals(body);
  }
  return null;
}

/** The whole rule, so the controls below can run it over synthetic targets. */
function violations(list: Entry[]): string[] {
  const found: string[] = [];
  for (const entry of list) {
    if ('unresolved' in entry) {
      found.push(`unresolvable purge entry — ${entry.unresolved} — in \`${entry.source}\``);
      continue;
    }
    const { constName, filter } = entry.target;
    if (!processorsByConst[constName])
      found.push(`${constName}: no search-index processor declares it`);
    else if (isRetired(constName))
      found.push(`${constName}: the index is retired, so a filtered delete cannot succeed`);
    const attributes = filterAttributes(filter);
    if (attributes === null || attributes.some((a) => /[`${}]/.test(a)))
      found.push(
        `${constName}: could not read the filter attributes out of \`${filter}\`. Every attribute ` +
          `a filter names has to be checkable here, because Meilisearch rejects the whole filter ` +
          `if any one of them is not filterable — write the filter in a clause shape this guard ` +
          `recognises, or teach it the shape; do not leave the entry unchecked.`
      );
    else {
      const declared = declaredFilterable(constName);
      if (declared === null) found.push(`${constName}: no declared filterable attributes found`);
      // EVERY attribute, not just the first: one undeclared clause rejects the entire filter.
      else
        for (const attribute of attributes)
          if (!declared.includes(attribute))
            found.push(`${constName}: \`${attribute}\` is not declared filterable`);
    }
  }
  return found;
}

const mainEntries = entries('mainIndexConfigs');
const metricsEntries = entries('metricsIndexConfigs');

describe('the ban purge only targets live, filterable search indexes', () => {
  // 🔴 POSITIVE CONTROLS, first. Every prohibition below reads a list that a broken parse renders
  // EMPTY, and an empty list passes silently.
  //
  // 🔴 `toBe`, not `toBeGreaterThan`: the counts are exact in BOTH directions. An entry added
  // beside a guarded one has to move the number in the same commit, so it is reviewed rather than
  // arriving unnoticed; and a parse that stops seeing an entry cannot hide behind the rest.
  const countMessage = (arrayName: string) =>
    `${arrayName} in ${PURGE_FILE} no longer parses to the recorded number of entries. If you ` +
    `added or removed a purge target, update this count in the same commit — if you did not, the ` +
    `parse has broken and every check below is reading a short list.`;

  it('reads the recorded number of targets out of both lists', () => {
    expect(mainEntries.length, countMessage('mainIndexConfigs')).toBe(6);
    expect(metricsEntries.length, countMessage('metricsIndexConfigs')).toBe(1);
  });

  it('resolves every entry it found to a name and a literal filter', () => {
    // An entry the parser cannot read must not be able to leave the list silently short.
    expect(
      [...mainEntries, ...metricsEntries].flatMap((e) =>
        'unresolved' in e ? [`${e.unresolved} — in \`${e.source}\``] : []
      ),
      `Every entry in mainIndexConfigs / metricsIndexConfigs in ${PURGE_FILE} must spell its ` +
        'index constant and its filter inline, so the checks below can read them.'
    ).toEqual([]);
  });

  it('parses an entry whatever its layout, key order or trailing comma', () => {
    // Shape independence is the property the counts rest on: prettier reformats an entry past
    // `printWidth: 100` into the multi-line form, which an entry-shaped regex stops matching.
    const parse = (body: string) =>
      objectSpans({ text: body, masked: maskLiterals(body) }).map(parseEntry);

    const oneLine = parse('{ name: MODELS_SEARCH_INDEX, filter: `user.id IN [1]` }');
    const multiLine = parse('{\n  name: MODELS_SEARCH_INDEX,\n  filter: `user.id IN [1]`,\n}');
    const reversed = parse('{ filter: `user.id IN [1]`, name: MODELS_SEARCH_INDEX }');
    for (const parsed of [oneLine, multiLine, reversed]) {
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(
        expect.objectContaining({
          target: { constName: 'MODELS_SEARCH_INDEX', filter: 'user.id IN [1]' },
        })
      );
    }

    // A comment, an apostrophe in prose and a `[` inside a template must not shift the parse.
    const commented = parse(
      "// it's the comics index's entry — [not] an entry\n" +
        '{ name: COMICS_SEARCH_INDEX, filter: `user.username IN ["a"]` }'
    );
    expect(commented).toHaveLength(1);

    // And a filter that is not a literal must come back unresolvable, not absent.
    const indirect = parse('{ name: MODELS_SEARCH_INDEX, filter: modelsPurgeFilter }');
    expect(indirect).toHaveLength(1);
    expect(violations(indirect)).toHaveLength(1);
    expect(violations(indirect)[0]).toContain('unresolvable purge entry');
  });

  it('reads EVERY attribute a filter names, not just the first clause', () => {
    // 🔴 The hole this closes: resolving on the first attribute passed a compound filter whose
    // SECOND attribute was undeclared, which Meilisearch rejects outright and `processIndex`
    // swallows. Both connectives, either case, parenthesised groups and negation.
    expect(filterAttributes('user.id IN [1, 2]')).toEqual(['user.id']);
    expect(filterAttributes('user.id IN [1] OR nope IN [1]')).toEqual(['user.id', 'nope']);
    expect(filterAttributes('user.id IN [1] AND nope IN [1]')).toEqual(['user.id', 'nope']);
    expect(filterAttributes('user.id IN [1] and nope IN [1]')).toEqual(['user.id', 'nope']);
    expect(filterAttributes('(a IN [1] OR b IN [1]) AND c IN [1]')).toEqual(['a', 'b', 'c']);
    expect(filterAttributes('NOT a IN [1] AND b NOT IN [1]')).toEqual(['a', 'b']);

    // The other clause shapes this repo writes, so a legitimate filter is not forced to be a lie.
    expect(filterAttributes('sortAtUnix <= 10 AND postId IS NOT NULL')).toEqual([
      'sortAtUnix',
      'postId',
    ]);
    expect(filterAttributes('publishedAtUnix NOT EXISTS AND userId = 5')).toEqual([
      'publishedAtUnix',
      'userId',
    ]);
    expect(filterAttributes('rank 1 TO 9')).toEqual(['rank']);

    // An attribute merely BEGINNING with a connective must not split the filter.
    expect(filterAttributes('orderedAt >= 1')).toEqual(['orderedAt']);

    // 🔴 And anything undecidable must come back null — reported by `violations`, never skipped.
    expect(filterAttributes('user.id')).toBeNull(); // no operator at all
    expect(filterAttributes('user.id IN [1] OR fnord(2)')).toBeNull(); // unrecognised clause
    expect(filterAttributes('${interpolatedAttr} IN [1]')).toBeNull();
    expect(filterAttributes('')).toBeNull();
  });

  it('still resolves every target to a processor and a declared attribute list', () => {
    for (const entry of [...mainEntries, ...metricsEntries]) {
      if ('unresolved' in entry) continue; // reported by its own test above
      const { constName } = entry.target;
      expect(processorsByConst[constName], `${constName} resolved to no processor`).toBeTruthy();
      expect(
        declaredFilterable(constName)?.length,
        `${constName} resolved to no attributes`
      ).toBeGreaterThan(0);
    }
  });

  it('still tells a retired index from a live one', () => {
    // Both directions: a resolver stuck on either answer makes the prohibition useless.
    expect(isRetired('IMAGES_SEARCH_INDEX'), 'the images index is retired in this tree').toBe(true);
    expect(isRetired('MODELS_SEARCH_INDEX'), 'the models index is not retired').toBe(false);
  });

  it('reports a retired target and an undeclared attribute when handed one', () => {
    expect(
      violations([synthetic({ constName: 'IMAGES_SEARCH_INDEX', filter: 'user.username IN [x]' })])
    ).toEqual(['IMAGES_SEARCH_INDEX: the index is retired, so a filtered delete cannot succeed']);
    expect(
      violations([synthetic({ constName: 'MODELS_SEARCH_INDEX', filter: 'nope IN [x]' })])
    ).toEqual(['MODELS_SEARCH_INDEX: `nope` is not declared filterable']);
    // 🔴 The compound case, which resolved clean while only the first clause was read. The first
    // attribute here IS declared, so nothing but reading the second one can catch it.
    expect(
      violations([
        synthetic({ constName: 'MODELS_SEARCH_INDEX', filter: 'user.id IN [x] OR nope IN [x]' }),
      ])
    ).toEqual(['MODELS_SEARCH_INDEX: `nope` is not declared filterable']);
    // An unreadable filter must be reported, not skipped.
    expect(
      violations([synthetic({ constName: 'MODELS_SEARCH_INDEX', filter: 'user.id' })])
    ).toHaveLength(1);
  });

  it('no purge target is a retired index or filters on an undeclared attribute', () => {
    expect(
      violations([...mainEntries, ...metricsEntries]),
      `Each entry in mainIndexConfigs / metricsIndexConfigs in ${PURGE_FILE} must name a search\n` +
        'index that is not retired and must filter on an attribute that index declares\n' +
        'filterable. A retired index has never had its settings applied, so the delete is\n' +
        'rejected and the banned user stays in search — silently, because processIndex logs the\n' +
        'failure and returns.\n' +
        'Three ways out. Prefer the first:\n' +
        '  1. make the target work — reset the index in this change so its filterable attributes\n' +
        '     exist, and keep the entry.\n' +
        '  2. drop the entry because a filtered delete against a retired, settings-less index\n' +
        '     cannot succeed at all, so keeping it buys nothing but a swallowed error. Legitimate,\n' +
        '     and the reason option 1 is not always available: re-establishing an index can be a\n' +
        '     planned reindex rather than a one-line change (see `imageSearch` in\n' +
        '     `src/server/services/feature-flags.service.ts`). This is the branch the images entry\n' +
        '     took, and a retired index can still hold documents, so it is NOT option 3.\n' +
        '  3. drop the entry because that content type genuinely has nothing left to purge.\n' +
        'Either drop ends ban purge for that content type with no other record, so if you drop\n' +
        'one, say in a comment beside the list what is left unpurged and what re-adds it.'
    ).toEqual([]);
  });
});
