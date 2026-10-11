import { HARNESS_LIMITS } from './limits';
import type { LabEntityType } from './types';

export const MAX_INPUT_IDS = HARNESS_LIMITS.textsPerRequest;
const MAX_INT4 = 2_147_483_647;

export type CheckInput =
  | { kind: 'empty' }
  | { kind: 'entity'; entityType: LabEntityType; ids: number[] }
  /** A profile link names the account, not its id; the caller resolves it. */
  | { kind: 'user'; username: string }
  | { kind: 'ids'; ids: number[] }
  | { kind: 'too-many-ids'; count: number; max: number }
  | { kind: 'text'; text: string }
  /** A link the checker doesn't know; the caller judges `text` as text and shows the notice. */
  | { kind: 'unknown-url'; text: string; notice: string }
  /** Links that can't be checked together (different kinds of content, several profiles). */
  | { kind: 'refused'; notice: string };

type UrlMatch = { entityType: LabEntityType; id: number } | { username: string };

const CIVITAI_HOSTS = new Set(['civitai.com', 'civitai.red', 'civitai.green']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

const toId = (s: string | null | undefined): number | null => {
  if (!s || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= MAX_INT4 ? n : null;
};

const isCivitaiHost = (host: string) =>
  CIVITAI_HOSTS.has(host.replace(/^www\./, '')) || LOCAL_HOSTS.has(host);

function toUrl(raw: string): URL | null {
  const token = raw.replace(/^[(<'"]+/, '').replace(/[.;:!?)>\]}'"]+$/, '');
  const withScheme = /^https?:\/\//i.test(token)
    ? token
    : /^(www\.)?(civitai\.(com|red|green)|localhost|127\.0\.0\.1)([:/]|$)/i.test(token)
    ? `https://${token}`
    : null;
  if (!withScheme) return null;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

// The main app's own pages under src/pages/user, which take precedence over /user/[username].
const USER_STATIC_PAGES = new Set([
  'account',
  'buzz-dashboard',
  'downloads',
  'earn-potential',
  'membership',
  'notifications',
  'placements',
  'pool-estimate',
  'referrals',
  'remix-submissions',
  'sticker-placements',
  'stripe-connect',
  'transactions',
  'vault',
]);

const SIMPLE_PATHS: Record<string, LabEntityType> = {
  articles: 'Article',
  posts: 'Post',
  challenges: 'Challenge',
  collections: 'Collection',
  crucibles: 'Crucible',
};

// Mirrors the main app's routes under src/pages.
function matchCivitaiPath(url: URL): UrlMatch | null {
  const segs = url.pathname.split('/').filter(Boolean);
  const [root, a, b, c] = segs;
  if (!root) return null;
  if (root === 'models') {
    const modelId = toId(a);
    if (!modelId) return null;
    const commentId =
      url.searchParams.get('dialog') === 'commentThread'
        ? toId(url.searchParams.get('highlight'))
        : null;
    return commentId
      ? { entityType: 'Comment', id: commentId }
      : { entityType: 'Model', id: modelId };
  }
  if (root === 'bounties') {
    if (a === 'entries') {
      const id = toId(b);
      return id ? { entityType: 'BountyEntry', id } : null;
    }
    const entryId = b === 'entries' ? toId(c) : null;
    if (entryId) return { entityType: 'BountyEntry', id: entryId };
    const id = toId(a);
    return id ? { entityType: 'Bounty', id } : null;
  }
  if (root === 'comments' && a === 'v2') {
    const id = toId(b);
    return id ? { entityType: 'CommentV2', id } : null;
  }
  if (root === 'user' && a && !USER_STATIC_PAGES.has(a)) {
    try {
      return { username: decodeURIComponent(a) };
    } catch {
      return null;
    }
  }
  const entityType = SIMPLE_PATHS[root];
  const id = toId(a);
  return entityType && id ? { entityType, id } : null;
}

const UNKNOWN_LINK = "That isn't a Civitai link the checker knows, so it is judged as text.";
const MIXED_LINKS = 'Those links point at different kinds of content; paste one kind at a time.';
const SEVERAL_PROFILES = 'Paste one profile link at a time.';

function idList(ids: number[]): number[] | { count: number } {
  const unique = [...new Set(ids)];
  return unique.length > MAX_INPUT_IDS ? { count: unique.length } : unique;
}

export function parseCheckInput(raw: string): CheckInput {
  const text = raw.trim();
  if (!text) return { kind: 'empty' };
  const tokens = text.split(/[\s,]+/).filter(Boolean);

  if (tokens.every((t) => /^\d+$/.test(t))) {
    const ids = tokens.map(toId);
    if (ids.every((id): id is number => id !== null)) {
      const list = idList(ids);
      return Array.isArray(list)
        ? { kind: 'ids', ids: list }
        : { kind: 'too-many-ids', count: list.count, max: MAX_INPUT_IDS };
    }
    return { kind: 'text', text };
  }

  const urls = tokens.map(toUrl);
  if (!urls.every((u): u is URL => u !== null)) return { kind: 'text', text };

  const matches = urls.map((u) => (isCivitaiHost(u.hostname) ? matchCivitaiPath(u) : null));
  if (!matches.every((m): m is UrlMatch => m !== null))
    return { kind: 'unknown-url', text, notice: UNKNOWN_LINK };

  const users = matches.filter((m) => 'username' in m);
  if (users.length) {
    if (users.length < matches.length) return { kind: 'refused', notice: MIXED_LINKS };
    const names = new Set(users.map((m) => m.username.toLowerCase()));
    return names.size === 1
      ? { kind: 'user', username: users[0].username }
      : { kind: 'refused', notice: SEVERAL_PROFILES };
  }

  const entities = matches as { entityType: LabEntityType; id: number }[];
  const entityType = entities[0].entityType;
  if (entities.some((m) => m.entityType !== entityType))
    return { kind: 'refused', notice: MIXED_LINKS };
  const list = idList(entities.map((m) => m.id));
  return Array.isArray(list)
    ? { kind: 'entity', entityType, ids: list }
    : { kind: 'too-many-ids', count: list.count, max: MAX_INPUT_IDS };
}
