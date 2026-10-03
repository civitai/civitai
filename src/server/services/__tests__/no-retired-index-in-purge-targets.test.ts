import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every index `processUserContentRemovalQueue` filter-deletes from must be a LIVE search index
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
 * 🔴 WHAT THIS DOES NOT CHECK, stated so nobody reads it as wider than it is. It compares the
 * purge's targets against what the REPO DECLARES — the `retired` flag on the owning processor and
 * the filterable-attribute arrays. It cannot see the live backend, so an index whose declared
 * settings were never applied still passes. Declared state is the half a commit can regress, and
 * the only half a test can hold.
 *
 * The entry counts are asserted exactly, so a target added beside a guarded one cannot arrive
 * unreviewed: the count has to move in the same commit.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PURGE_FILE = 'src/server/meilisearch/util.ts';
const ATTR_FILE = 'src/server/search-index/filterable-attributes.ts';
const INDEX_DIR = 'src/server/search-index';

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** `{ name: SOME_SEARCH_INDEX, filter: `attr IN [...]` }` */
const ENTRY_RE = /\{\s*name:\s*([A-Z][A-Z0-9_]*)\s*,\s*filter:\s*`([^`]*)`\s*\}/g;

/** The body of an array literal, by brace depth — the arrays carry comments and nested `[...]`. */
function arrayBody(text: string, declaration: RegExp): string | null {
  const m = declaration.exec(text);
  if (!m) return null;
  const open = text.indexOf('[', m.index + m[0].length - 1);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/**
 * Single-quoted literals in an array body. Comment LINES are dropped first and trailing `//`
 * comments trimmed when what follows carries no quote of its own — several of these arrays are
 * commented, and one comment contains an apostrophe.
 */
function stringLiterals(body: string): string[] {
  const code = body
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .map((line) => line.replace(/\s\/\/[^'"\n]*$/, ''))
    .join('\n');
  return [...code.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

type Target = { constName: string; filter: string; attribute: string };

function targets(arrayName: string): Target[] {
  const body = arrayBody(read(PURGE_FILE), new RegExp(`const\\s+${arrayName}\\s*=\\s*\\[`));
  if (body === null) return [];
  return [...body.matchAll(ENTRY_RE)].map(([, constName, filter]) => ({
    constName,
    filter,
    // `user.username IN [...]`, `id IN [...]` — the attribute Meilisearch must have declared
    // filterable. An unparseable filter is reported rather than skipped.
    attribute: filter.split(' IN ')[0].trim(),
  }));
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
function violations(list: Target[]): string[] {
  const found: string[] = [];
  for (const { constName, filter, attribute } of list) {
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

const mainTargets = targets('mainIndexConfigs');
const metricsTargets = targets('metricsIndexConfigs');

describe('the ban purge only targets live, filterable search indexes', () => {
  // 🔴 POSITIVE CONTROLS, first. Every prohibition below reads a list that a broken parse renders
  // EMPTY, and an empty list passes silently.
  //
  // 🔴 `toBe`, not `toBeGreaterThan`: the counts are exact in BOTH directions. A target added
  // beside a guarded one has to move the number in the same commit, so it is reviewed rather than
  // arriving unnoticed; and a parse that stops seeing an entry cannot hide behind the rest.
  const countMessage = (arrayName: string) =>
    `${arrayName} in ${PURGE_FILE} no longer parses to the recorded number of entries. If you ` +
    `added or removed a purge target, update this count in the same commit — if you did not, the ` +
    `parse has broken and every check below is reading a short list.`;

  it('reads the recorded number of targets out of both lists', () => {
    expect(mainTargets.length, countMessage('mainIndexConfigs')).toBe(6);
    expect(metricsTargets.length, countMessage('metricsIndexConfigs')).toBe(1);
  });

  it('still resolves every target to a processor and a declared attribute list', () => {
    for (const { constName } of [...mainTargets, ...metricsTargets]) {
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
        {
          constName: 'IMAGES_SEARCH_INDEX',
          filter: 'user.username IN [x]',
          attribute: 'user.username',
        },
      ])
    ).toEqual(['IMAGES_SEARCH_INDEX: the index is retired, so a filtered delete cannot succeed']);
    expect(
      violations([{ constName: 'MODELS_SEARCH_INDEX', filter: 'nope IN [x]', attribute: 'nope' }])
    ).toEqual(['MODELS_SEARCH_INDEX: `nope` is not declared filterable']);
    // An unreadable filter must be reported, not skipped.
    expect(
      violations([{ constName: 'MODELS_SEARCH_INDEX', filter: 'user.id', attribute: 'user.id' }])
    ).toHaveLength(1);
  });

  it('no purge target is a retired index or filters on an undeclared attribute', () => {
    expect(
      violations([...mainTargets, ...metricsTargets]),
      `Each entry in mainIndexConfigs / metricsIndexConfigs in ${PURGE_FILE} must name a search\n` +
        'index that is not retired and must filter on an attribute that index declares\n' +
        'filterable. A retired index has never had its settings applied, so the delete is\n' +
        'rejected and the banned user stays in search — silently, because processIndex logs the\n' +
        'failure and returns. Drop the entry until the index is reset, or reset it in this change.'
    ).toEqual([]);
  });
});
