import { isRank, rankIndex, type Rank } from '../ranks';
import type { UpdateEntry } from '$lib/whats-new';

/** One file under `apps/knights/whats-new/`, as parsed. The format is in that folder's README. */
export type ParsedEntry = UpdateEntry & { minRank: Rank | null };

const NAME = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELDS = new Set(['title', 'minRank', 'link', 'linkText']);

/** Throws on anything the dialog could not show as written, so a bad file fails the build and the test, not a player. */
export function parseEntry(id: string, raw: string): ParsedEntry {
  const fail = (why: string): never => {
    throw new Error(`whats-new/${id}.md: ${why}`);
  };
  const name = NAME.exec(id) ?? fail('name it YYYY-MM-DD-slug, in lowercase');
  if (Number.isNaN(Date.parse(name[1]))) fail(`${name[1]} is not a date`);
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw.replace(/\r\n/g, '\n'));
  if (!match) fail('start with a --- block of fields');
  const [, head, rest] = match as RegExpExecArray;

  const fields = new Map<string, string>();
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    const pair = /^(\w+):\s*(.*)$/.exec(line) ?? fail(`"${line}" is not a field`);
    const key = pair[1];
    if (!FIELDS.has(key)) fail(`unknown field "${key}"`);
    if (fields.has(key)) fail(`"${key}" is given twice`);
    fields.set(key, pair[2].trim());
  }

  const title = fields.get('title') || fail('a title is required');
  const body = rest.trim().replace(/\s*\n\s*/g, ' ');
  if (!body) fail('write a sentence or two under the fields');
  if (/[<>]/.test(`${title}${body}`)) fail('HTML is not allowed');

  const minRankField = fields.get('minRank');
  let minRank: Rank | null = null;
  if (minRankField) {
    if (!isRank(minRankField)) fail(`minRank "${minRankField}" is not a rank`);
    minRank = minRankField as Rank;
  }

  const href = fields.get('link');
  const text = fields.get('linkText');
  if (!href !== !text) fail('link and linkText go together');
  // A path inside the game only: "//host" would leave it.
  if (href && !/^\/(?!\/)[\w\-./?=&#]*$/.test(href))
    fail(`link "${href}" must be a path in the game`);

  return { id, title, body, minRank, link: href && text ? { href, text } : null };
}

const files = import.meta.glob('../../../../whats-new/[0-9]*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Every entry, newest first. Entries sort by file name, so a later entry needs a later name. */
export const UPDATE_ENTRIES: readonly ParsedEntry[] = Object.entries(files)
  .map(([path, raw]) => parseEntry(path.slice(path.lastIndexOf('/') + 1, -'.md'.length), raw))
  .sort((a, b) => (a.id < b.id ? 1 : -1));

/** The newest entry's id: what a player has seen once they close the dialog. Null while there are none. */
export const LATEST_UPDATE_ID: string | null = UPDATE_ENTRIES[0]?.id ?? null;

/** The entries a player of this rank can use, newest first. */
export const updatesFor = (rank: string, entries: readonly ParsedEntry[] = UPDATE_ENTRIES) =>
  entries.filter((entry) => !entry.minRank || rankIndex(rank) >= rankIndex(entry.minRank));

/** How many of those are newer than the one the player saw last; null means they have seen none. */
export const unseenCount = (entries: readonly UpdateEntry[], seen: string | null) =>
  entries.filter((entry) => seen === null || entry.id > seen).length;
