import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import { TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { logToAxiom } from '$lib/server/axiom';
import { carriesNonUserScope } from './scope';

// The resources a user access token can be exchanged for (RFC 8693 `resource`), from
// OAUTH_EXCHANGE_RESOURCES. Each lists the scopes it may receive and three client lists:
//   apps          — clients whose user tokens may be exchanged for this resource;
//   relays        — clients that may exchange another listed app's token (the JWT names them in `act`);
//   introspectors — clients that may introspect the resulting JWTs.
// Validation is all or nothing: one bad entry and no resource is registered.

export interface ExchangeResource {
  resource: string;
  /** Bitmask of the scopes the resource may receive. */
  scopes: number;
  apps: string[];
  relays: string[];
  introspectors: string[];
}

const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const LIST_KEYS = ['apps', 'relays', 'introspectors'] as const;

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

/** Whether http://localhost resources may be registered: a dev server or a hub issuing as localhost. */
function allowsLocalResources(): boolean {
  if (dev) return true;
  try {
    return isLocalHost(new URL(env.AUTH_JWT_ISSUER ?? '').hostname);
  } catch {
    return false;
  }
}

function resourceError(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return 'resource must be a non-empty string';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `resource ${value} is not an absolute URL`;
  }
  if (url.search || url.hash || value.includes('#') || value.includes('?')) {
    return `resource ${value} has a query or fragment`;
  }
  if (value.endsWith('/')) return `resource ${value} ends with a slash`;
  if (url.username || url.password) return `resource ${value} carries credentials`;
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLocalHost(url.hostname) && allowsLocalResources()) return null;
  return `resource ${value} must be https`;
}

function scopesFrom(value: unknown): number | string {
  if (!Array.isArray(value) || value.length === 0) return 'scopes must be a non-empty list';
  let bits = 0;
  for (const name of value) {
    if (typeof name !== 'string' || name === 'None' || !Object.hasOwn(TokenScope, name)) {
      return `unknown scope ${String(name)}`;
    }
    bits |= TokenScope[name as keyof typeof TokenScope];
  }
  // A resource never receives UserRead or a scope only a client acting as itself can hold.
  if (bits & TokenScope.UserRead) return 'scopes may not include UserRead';
  if (carriesNonUserScope(bits)) return 'scopes may not include a client-only scope';
  return bits;
}

/** The registry parsed from `raw`, or the first reason it is invalid. */
export function parseExchangeResources(
  raw: string | undefined
): { resources: ExchangeResource[] } | { error: string } {
  if (!raw?.trim()) return { resources: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'OAUTH_EXCHANGE_RESOURCES is not valid JSON' };
  }
  if (!Array.isArray(parsed)) return { error: 'OAUTH_EXCHANGE_RESOURCES must be a JSON array' };

  const resources: ExchangeResource[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') return { error: 'each entry must be an object' };
    const e = entry as Record<string, unknown>;
    const urlError = resourceError(e.resource);
    if (urlError) return { error: urlError };
    const resource = e.resource as string;
    if (seen.has(resource)) return { error: `resource ${resource} is listed twice` };
    seen.add(resource);

    const scopes = scopesFrom(e.scopes);
    if (typeof scopes === 'string') return { error: `${resource}: ${scopes}` };

    const lists = {} as Record<(typeof LIST_KEYS)[number], string[]>;
    for (const key of LIST_KEYS) {
      const list = e[key] ?? [];
      if (!Array.isArray(list)) return { error: `${resource}: ${key} must be a list` };
      const bad = list.find((id) => typeof id !== 'string' || !CLIENT_ID.test(id));
      if (bad !== undefined) return { error: `${resource}: ${key} has an invalid client id` };
      lists[key] = list as string[];
    }
    if (lists.apps.length === 0) return { error: `${resource}: apps must not be empty` };

    resources.push({ resource, scopes, ...lists });
  }
  return { resources };
}

let cache: { raw: string | undefined; resources: Promise<ExchangeResource[]> } | undefined;

async function load(raw: string | undefined): Promise<ExchangeResource[]> {
  const parsed = parseExchangeResources(raw);
  if ('error' in parsed) {
    void logToAxiom({
      type: 'error',
      name: 'oauth-exchange-resources-invalid',
      message: parsed.error,
    }).catch(() => undefined);
    return [];
  }
  if (parsed.resources.length === 0) return [];
  // A resource string must never also be a client id: an `aud` names one or the other.
  const collisions = await db
    .selectFrom('OauthClient')
    .select('id')
    .where(
      'id',
      'in',
      parsed.resources.map((r) => r.resource)
    )
    .execute();
  if (collisions.length > 0) {
    void logToAxiom({
      type: 'error',
      name: 'oauth-exchange-resources-invalid',
      message: `resource ${collisions[0].id} is also an OAuth client id`,
    }).catch(() => undefined);
    return [];
  }
  return parsed.resources;
}

/**
 * The registered resources. Parsed and checked once per distinct env value; a failed client-id check
 * throws and is retried on the next call.
 */
export async function getExchangeResources(): Promise<ExchangeResource[]> {
  const raw = env.OAUTH_EXCHANGE_RESOURCES;
  if (cache && cache.raw === raw) return cache.resources;
  const resources = load(raw);
  cache = { raw, resources };
  resources.catch(() => {
    if (cache?.resources === resources) cache = undefined;
  });
  return resources;
}

/** The entry registered for exactly `resource`, or undefined. */
export async function findExchangeResource(
  resource: string
): Promise<ExchangeResource | undefined> {
  return (await getExchangeResources()).find((r) => r.resource === resource);
}
