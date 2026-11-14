import { readFile } from 'node:fs/promises';
import { BlocklistType } from '~/server/common/enums';
import {
  countQueryRuleRead,
  setQueryRuleFallback,
  setQueryRuleStaleAge,
} from '~/server/metrics/semantic-search.metrics';
import {
  readBlocklistWithSource,
  type BlocklistReadSource,
} from '~/server/services/blocklist.service';
import { checkable, poiCheckOptions } from '~/utils/metadata/audit';

export const QUERY_RULE_TYPES = [
  BlocklistType.SemanticSearchPoiRefuse,
  BlocklistType.SemanticSearchMinorSafe,
] as const;
export type QueryRuleType = (typeof QUERY_RULE_TYPES)[number];
export type QueryRuleSource = BlocklistReadSource | 'stale' | 'fallback';

export interface QueryRuleReader {
  read(type: QueryRuleType): Promise<{ terms: string[]; source: QueryRuleSource }>;
}

/** Mounted read-only from a sealed Secret; read only while the blocklist cannot be. */
export const FALLBACK_RULES_PATH = '/etc/search-rules/fallback-rules.txt';

/**
 * One rule per line, `<type> <term>`: the type, then whitespace, then the term to its end of line.
 * Blank lines and `#` lines are skipped. An unknown type or an empty term throws, so a typo fails
 * the read closed rather than dropping a rule.
 */
export function parseFallbackRules(text: string): Map<QueryRuleType, string[]> {
  const rules = new Map<QueryRuleType, string[]>(QUERY_RULE_TYPES.map((t) => [t, []]));
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const match = /^(\S+)\s+(.+)$/.exec(line);
    const terms = match && rules.get(match[1] as QueryRuleType);
    if (!match || !terms) throw new Error(`fallback rules: line ${i + 1} is malformed`);
    terms.push(match[2].trim());
  });
  return rules;
}

/**
 * In order: the blocklist (Redis, then its short-lived last-known copy, then the row); this reader's
 * own last good copy, at any age; the fallback file; else the error propagates and the caller
 * refuses. A stale copy can only lack rules added since it was read, never be looser than what this
 * pod already enforced, so it outranks the hand-sealed file. `semantic_search_query_rule_stale_seconds`
 * carries its age, and `semantic_search_query_rule_fallback` is 1 while the file answers; a rule
 * removed during the outage lingers until the blocklist reads again.
 * The file is read on every fallback, never held, so a re-sealed Secret applies at the next read.
 */
export function createQueryRuleReader({
  fallbackPath = FALLBACK_RULES_PATH,
}: { fallbackPath?: string } = {}): QueryRuleReader {
  const lastGood = new Map<QueryRuleType, { terms: string[]; at: number }>();
  return {
    async read(type) {
      try {
        const { dto, source } = await readBlocklistWithSource(type);
        lastGood.set(type, { terms: dto.data, at: Date.now() });
        setQueryRuleStaleAge(type, 0);
        setQueryRuleFallback(type, false);
        return { terms: dto.data, source };
      } catch {
        const known = lastGood.get(type);
        if (known) {
          setQueryRuleStaleAge(type, (Date.now() - known.at) / 1000);
          return { terms: known.terms, source: 'stale' };
        }
        const rules = parseFallbackRules(await readFile(fallbackPath, 'utf8'));
        setQueryRuleFallback(type, true);
        return { terms: rules.get(type) ?? [], source: 'fallback' };
      }
    },
  };
}

// Matching mirrors the audit list each type adds to: POI names as `poi`, minor terms as `young`.
const MATCH_OPTIONS: Record<QueryRuleType, Parameters<typeof checkable>[1]> = {
  [BlocklistType.SemanticSearchPoiRefuse]: poiCheckOptions,
  [BlocklistType.SemanticSearchMinorSafe]: { pluralize: true },
};

const matchers = new Map<QueryRuleType, { key: string; check: ReturnType<typeof checkable> }>();
// Terms are literal text a moderator typed. `checkable` builds regex source from its words, so an
// unescaped "(" would throw on every query and a "." or "|" would match far more than the term.
const escapeTerm = (term: string) => term.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function matcherFor(type: QueryRuleType, terms: string[]) {
  const key = terms.join('\n');
  const known = matchers.get(type);
  if (known?.key === key) return known.check;
  const check = checkable(terms.map(escapeTerm), MATCH_OPTIONS[type]);
  matchers.set(type, { key, check });
  return check;
}

let defaultReader: QueryRuleReader = createQueryRuleReader();
/** Tests only. */
export function setQueryRuleReaderForTests(reader?: QueryRuleReader) {
  defaultReader = reader ?? createQueryRuleReader();
}

/** Whether `query` matches a rule of `type`. Throws when no copy of the rules can be read. */
export async function matchesQueryRule(query: string, type: QueryRuleType): Promise<boolean> {
  const { terms, source } = await defaultReader.read(type);
  countQueryRuleRead(type, source);
  if (!terms.length) return false;
  return matcherFor(type, terms).inPrompt(query) !== false;
}
