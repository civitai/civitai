import { readFile } from 'node:fs/promises';
import { BlocklistType } from '~/server/common/enums';
import {
  countQueryRuleRead,
  setQueryRuleFallback,
  setQueryRuleInertTerms,
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
 * A last good copy can only lack rules added since it was read, never be looser than what this pod
 * already enforced, so it outranks the hand-sealed file at any age; a rule removed during an
 * outage lingers until the blocklist reads again. The file is never held, so a re-sealed Secret
 * applies at the next read.
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
// Terms are literal text a moderator typed, but `checkable` builds regex source from its words: an
// unescaped "(" would throw on every query and a "." or "|" would match far more than the term.
// The type's preprocessor strips the query (POI drops most punctuation), so it strips the term too,
// or a hyphenated or apostrophised name could never match.
function prepareTerm(type: QueryRuleType, term: string) {
  const stripped = (MATCH_OPTIONS[type]?.preprocessor?.(term) ?? term).trim();
  return stripped.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function matcherFor(type: QueryRuleType, terms: string[]) {
  const key = terms.join('\n');
  const known = matchers.get(type);
  if (known?.key === key) return known.check;
  // A term the preprocessor empties (one written wholly in a non-Latin script, for POI) would
  // compile to an empty pattern that matches nearly every query, so it is dropped and counted.
  const prepared = terms.map((term) => prepareTerm(type, term));
  const usable = prepared.filter((term) => term.length > 0);
  setQueryRuleInertTerms(type, prepared.length - usable.length);
  const check = checkable(usable, MATCH_OPTIONS[type]);
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
