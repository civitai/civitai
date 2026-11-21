import {
  isUsableBlockedEntry,
  MIN_MANAGED_PROFANITY_ENTRIES,
} from '@civitai/mod-utils/profanity/word-rules';
import { createProfanityFilter, type SimpleProfanityFilter } from '~/libs/profanity-simple';
import { BlocklistType } from '~/server/common/enums';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import {
  ensureRegisterProfanityListMetrics,
  type ProfanityHitSurface,
} from '~/server/metrics/profanity-list.metrics';
import { readBlocklistWithSource } from '~/server/services/blocklist.service';

/**
 * Which list a server profanity check enforced: `managed` the moderator row; `stale` this pod's
 * last good list while the row cannot be read; `fallback` the shipped list in place of a row that
 * is missing, below the floor, or unreadable with nothing held; `shipped` the flag is off.
 */
export type ProfanityListSource = 'managed' | 'stale' | 'fallback' | 'shipped';

/** `null` in `blocked` or `allowed` means the shipped list for that slot. */
export type ProfanityLists = {
  blocked: string[] | null;
  allowed: string[] | null;
  source: ProfanityListSource;
};

type Held = { blocked: string[] | null; allowed: string[] | null };

export interface ProfanityListReader {
  read(): Promise<ProfanityLists>;
}

const LOG_INTERVAL_MS = 60_000;

/**
 * 🔴 The held copy is the list this pod ENFORCED, never the raw row: after a fallback it is the
 * shipped list (`null`). Holding a missing or tiny row as "last good" would serve it in the next
 * outage, which is exactly what the floor exists to stop.
 */
export function createProfanityListReader({
  readRow,
}: { readRow?: typeof readBlocklistWithSource } = {}): ProfanityListReader {
  // Resolved per read, not at construction: this module builds its reader on import.
  const read = (type: BlocklistType) => (readRow ?? readBlocklistWithSource)(type);
  let held: Held | null = null;
  const metrics = () => ensureRegisterProfanityListMetrics();
  // Every server check reads the list, so a lasting fault would log once per comment thread.
  const loggedAt = new Map<string, number>();
  const logDue = (name: string) => {
    const now = Date.now();
    if (now - (loggedAt.get(name) ?? 0) < LOG_INTERVAL_MS) return false;
    loggedAt.set(name, now);
    return true;
  };
  // A held list of `null` is the shipped one: reported as the fallback it is, not as stale.
  const fromHeld = (copy: Held): ProfanityLists => {
    metrics().fallback.set(copy.blocked === null ? 1 : 0);
    return { ...copy, source: copy.blocked === null ? 'fallback' : 'stale' };
  };

  return {
    async read() {
      if (!(await isFlipt(FLIPT_FEATURE_FLAGS.PROFANITY_MANAGED_LIST))) {
        // Flag off: the shipped block and allow lists. Held as what this pod enforces, so an outage
        // after the flag returns falls back to them.
        held = { blocked: null, allowed: null };
        metrics().fallback.set(0);
        return { blocked: null, allowed: null, source: 'shipped' };
      }
      let blockedRow, allowedRow;
      try {
        [blockedRow, allowedRow] = await Promise.all([
          read(BlocklistType.ProfanityWord),
          read(BlocklistType.ProfanityBenignWord),
        ]);
      } catch (error) {
        if (held) return fromHeld(held);
        metrics().fallback.set(1);
        if (logDue('profanity-list-unreadable'))
          logToAxiom({
            name: 'profanity-list-unreadable',
            type: 'error',
            message: 'Enforcing the shipped profanity list; the managed list could not be read',
            details: { error: error instanceof Error ? error.message : String(error) },
          });
        return { blocked: null, allowed: null, source: 'fallback' };
      }

      // A MISSING allow row is the shipped allow list; an EMPTY one is honoured (`moderatorWhitelist`, src/libs/profanity-simple/index.ts).
      const allowed = allowedRow.dto.id == null ? null : allowedRow.dto.data;
      const usable =
        blockedRow.dto.id == null ? [] : blockedRow.dto.data.filter(isUsableBlockedEntry);
      // Unlike the allow list, an empty or tiny block list is NOT honoured: it would filter nothing.
      if (usable.length < MIN_MANAGED_PROFANITY_ENTRIES) {
        held = { blocked: null, allowed };
        metrics().fallback.set(1);
        if (blockedRow.dto.id != null) {
          if (logDue('profanity-blocklist-below-floor'))
            logToAxiom({
              name: 'profanity-blocklist-below-floor',
              type: 'error',
              message: 'Managed profanity list is below the floor; enforcing the shipped list',
              payload: { usable: usable.length, floor: MIN_MANAGED_PROFANITY_ENTRIES },
            });
        }
        return { blocked: null, allowed, source: 'fallback' };
      }
      held = { blocked: usable, allowed };
      metrics().fallback.set(0);
      return { blocked: usable, allowed, source: 'managed' };
    },
  };
}

let reader: ProfanityListReader = createProfanityListReader();

// One list read is shared for a few seconds: a page masks many texts and a chat list many previews,
// and each would otherwise read both rows again. Edits already take up to the Redis TTL to land.
const READ_SHARE_MS = 5_000;
let readShareMs = READ_SHARE_MS;
let shared: { at: number; lists: Promise<ProfanityLists> } | null = null;
function readShared(): Promise<ProfanityLists> {
  const now = Date.now();
  if (shared && now - shared.at < readShareMs) return shared.lists;
  const lists = reader.read();
  const entry = { at: now, lists };
  shared = entry;
  lists.catch(() => {
    if (shared === entry) shared = null;
  });
  return lists;
}

/** Tests only. Reads are not shared unless `shareMs` says so. */
export function setProfanityListReaderForTests(next?: ProfanityListReader, shareMs = 0) {
  reader = next ?? createProfanityListReader();
  readShareMs = shareMs;
  shared = null;
}

export type ServerProfanityFilter = {
  filter: SimpleProfanityFilter;
  source: ProfanityListSource;
  /** Counts a match against this filter's list source. */
  countHit(surface: ProfanityHitSurface): void;
};

// One slot, keyed on the lists' CONTENT: every read parses fresh arrays, so an identity key would
// rebuild (several ms) on every call. Not `getProfanityFilter`'s shared two-entry map, which SSR
// masking also fills and would evict this between calls.
let slot: { key: string; filter: SimpleProfanityFilter; buildFailed: boolean } | null = null;

function filterFor({ blocked, allowed }: ProfanityLists) {
  const part = (list: string[] | null) => (list === null ? 'shipped' : `list:${list.join('\n')}`);
  const key = `${part(allowed)}|${part(blocked)}`;
  if (slot?.key === key) return slot;
  let filter: SimpleProfanityFilter;
  let buildFailed = false;
  try {
    filter = createProfanityFilter({ moderatorWhitelist: allowed, moderatorBlocklist: blocked });
  } catch (error) {
    // An entry the pattern parser rejects must not take every check down with it.
    logToAxiom({
      name: 'profanity-list-build-failed',
      type: 'error',
      message: 'Managed profanity list failed to build; enforcing the shipped list',
      // The parser's message can quote the entry it rejected; the list is not for logs.
      details: { error: error instanceof Error ? error.name : 'unknown' },
    });
    filter = createProfanityFilter({ moderatorWhitelist: allowed });
    buildFailed = true;
  }
  slot = { key, filter, buildFailed };
  return slot;
}

/**
 * The one profanity filter every server check uses: one list, and the moderators' allow list
 * everywhere (#9952). Flag off: the shipped block and allow lists, as before this existed.
 */
export async function getServerProfanityFilter(): Promise<ServerProfanityFilter> {
  const lists = await readShared();
  const { filter, buildFailed } = filterFor(lists);
  const source = buildFailed ? 'fallback' : lists.source;
  const metrics = ensureRegisterProfanityListMetrics();
  metrics.reads.inc({ source });
  return { filter, source, countHit: (surface) => metrics.hits.inc({ surface, source }) };
}

/** The typed query of each search in a site search request body, read leniently. */
export function siteSearchQueries(body: unknown): string[] {
  const read = (search: unknown) =>
    search && typeof search === 'object' && typeof (search as { q?: unknown }).q === 'string'
      ? [(search as { q: string }).q]
      : [];
  const queries =
    body && typeof body === 'object' ? (body as { queries?: unknown }).queries : undefined;
  return Array.isArray(queries) ? queries.flatMap(read) : read(body);
}

/**
 * Whether a site search must be refused for profanity (civitai.com only; the caller decides the
 * domain), against the same lists the browser checks. Fails OPEN: a broken check must
 * not refuse every search, and the domain's browsing-level filter still applies.
 *
 * With `profanity-managed-list` off it refuses nothing: the browser's own check is today's rule,
 * and its allow list (the moderators') is not the shipped one the server reads with the flag off,
 * so a server refusal could reject a search the page let through.
 */
export async function isProfaneSearch(queries: string[]): Promise<boolean> {
  const texts = queries.filter((query) => query.trim().length > 0);
  if (!texts.length) return false;
  try {
    const profanity = await getServerProfanityFilter();
    if (profanity.source === 'shipped') return false;
    const refused = texts.some((text) => profanity.filter.analyze(text).isProfane);
    if (refused) profanity.countHit('search');
    return refused;
  } catch (error) {
    logToAxiom({
      name: 'profanity-search-check-failed',
      type: 'error',
      message: 'Site search profanity check failed; the search ran unchecked',
      details: { error: error instanceof Error ? error.message : String(error) },
    });
    return false;
  }
}
