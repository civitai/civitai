import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every entry in the two target arrays `processUserContentRemovalQueue` filter-deletes from —
 * `mainIndexConfigs` and `metricsIndexConfigs`, named literally below — must be a LIVE search index
 * whose declared filterable attributes include the attribute the purge filters on.
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
 *   - the attribute is not declared filterable for that index at all.
 *
 * The images entry was the first case for two weeks and nothing went red.
 *
 * 🔴 WHAT THIS DOES NOT CHECK, stated so nobody reads it as wider than it is.
 *
 *   - It compares the purge's targets against what the REPO DECLARES — the `retired` flag on the
 *     owning processor and the filterable-attribute arrays. It cannot see the live backend, so an
 *     index whose declared settings were never applied still passes. Declared state is the half a
 *     commit can regress, and the only half a test can hold.
 *   - It reads the two array literals named above and nothing else. A third list, a `.push` onto
 *     one of them, an entry spread in from elsewhere, or a target passed straight to
 *     `processIndex` is invisible to it. If you add a purge target by any route other than a
 *     literal entry in those two arrays, this guard will not see it — and the counts below will
 *     not move either.
 *
 * Within those two arrays the parse is STRUCTURAL, not shape-spelled: entries are found by brace
 * matching and their fields by key, so key order, line breaks (prettier reformats past
 * `printWidth: 100`) and trailing commas are all handled. An entry whose `name` or `filter` the
 * parser cannot resolve to a literal is REPORTED as unresolvable, never skipped — a skip is how
 * the counts below would silently go short again.
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

type Target = { constName: string; filter: string; attribute: string };
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

  const literal = filter.slice(1, -1);
  return {
    source,
    // `user.username IN [...]`, `id IN [...]` — the attribute Meilisearch must have declared
    // filterable. An unparseable filter is reported rather than skipped.
    target: { constName: name, filter: literal, attribute: literal.split(' IN ')[0].trim() },
  };
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
    const { constName, filter, attribute } = entry.target;
    if (!processorsByConst[constName])
      found.push(`${constName}: no search-index processor declares it`);
    else if (isRetired(constName))
      found.push(`${constName}: the index is retired, so a filtered delete cannot succeed`);
    if (!attribute || /[`${}]/.test(attribute) || attribute === filter)
      found.push(`${constName}: could not read a filter attribute out of \`${filter}\``);
    else {
      const declared = declaredFilterable(constName);
      if (declared === null) found.push(`${constName}: no declared filterable attributes found`);
      else if (!declared.includes(attribute))
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
          target: {
            constName: 'MODELS_SEARCH_INDEX',
            filter: 'user.id IN [1]',
            attribute: 'user.id',
          },
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
      violations([
        synthetic({
          constName: 'IMAGES_SEARCH_INDEX',
          filter: 'user.username IN [x]',
          attribute: 'user.username',
        }),
      ])
    ).toEqual(['IMAGES_SEARCH_INDEX: the index is retired, so a filtered delete cannot succeed']);
    expect(
      violations([
        synthetic({ constName: 'MODELS_SEARCH_INDEX', filter: 'nope IN [x]', attribute: 'nope' }),
      ])
    ).toEqual(['MODELS_SEARCH_INDEX: `nope` is not declared filterable']);
    // An unreadable filter must be reported, not skipped.
    expect(
      violations([
        synthetic({ constName: 'MODELS_SEARCH_INDEX', filter: 'user.id', attribute: 'user.id' }),
      ])
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
        'Fix it by making the target work: reset the index in this change so its filterable\n' +
        'attributes exist. Only drop the entry if that content type genuinely has nothing left to\n' +
        'purge — a dropped entry ends ban purge for it with no other record, so if you drop one,\n' +
        'say in a comment beside the list what is left unpurged and what re-adds it.'
    ).toEqual([]);
  });
});
