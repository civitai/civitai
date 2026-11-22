import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import { TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { logToAxiom } from '$lib/server/axiom';
import { SERVICE_GRANT, SYSTEM_USER_ID } from './constants';
import { carriesNonUserScope } from './scope';

// The resources a user access token can be exchanged for (RFC 8693 `resource`), from
// OAUTH_EXCHANGE_RESOURCES. Each lists the scopes it may receive and three client lists:
//   apps          — clients whose user tokens may be exchanged for this resource;
//   relays        — clients that may exchange another listed app's token (the JWT names them in `act`);
//   introspectors — clients that may introspect the resulting JWTs;
//   services      — service clients that may get a token for the resource as themselves (optional);
//   serviceSubjects — service clients whose own token (no user) a relay may exchange for this resource
//                   (client-exchange.ts; optional, default none, so by default no such token is exchanged).
// and one capability:
//   narrowsBlockClaims — `true` when the resource holds a block-exchange token's reads to its binding claims
//                   (the ceiling, block and install; block-exchange.ts). Optional, default false: a resource
//                   that does not declare it is only sent block-exchange tokens whose ceiling admits every
//                   mature rating. Anything but `true` or `false` is a bad entry.
// Validation is all or nothing: one bad entry and no resource is registered. `services` and
// `serviceSubjects` are the exception: a bad one empties that resource's list only.

export interface ExchangeResource {
  resource: string;
  /** Bitmask of the scopes the resource may receive. */
  scopes: bigint;
  apps: string[];
  relays: string[];
  introspectors: string[];
  services: ServiceEntry[];
  /**
   * Service clients whose own tokens (a client as itself, no user) may be exchanged for this resource
   * by one of its relays (client-exchange.ts). Empty unless listed.
   */
  serviceSubjects: string[];
  /**
   * Whether the resource narrows a block-exchange token by its binding claims (`civitai_max_browsing_level`,
   * `civitai_app_block_id`, `civitai_block_instance_id`). Only such a resource is sent a block-exchange
   * token whose ceiling leaves out a mature rating (block-exchange.ts). False unless declared.
   */
  narrowsBlockClaims: boolean;
}

/** A service client's token for one resource: what it may hold, and the identity its tokens carry. */
export interface ServiceEntry {
  client: string;
  /** Bitmask, within the resource's scopes. */
  scopes: bigint;
  /** Passed through to the resource as the token's `roles`, in this order. */
  roles: string[];
  /** The service's user id at the resource: at most -1000, and one service's only. */
  uid: number;
}

const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const LIST_KEYS = ['apps', 'relays', 'introspectors'] as const;
// Service client ids are random UUIDs: never numeric like a user id, never another id family's shape.
const SERVICE_CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether `id` has the shape every service client id has. */
export const isServiceClientId = (id: string) => SERVICE_CLIENT_ID.test(id);
const ROLE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const MAX_ROLES = 16;
const MAX_SERVICE_UID = -1000;
const MIN_INT32 = -(2 ** 31);

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

function scopesFrom(value: unknown): bigint | string {
  if (!Array.isArray(value) || value.length === 0) return 'scopes must be a non-empty list';
  let bits = 0n;
  for (const name of value) {
    if (typeof name !== 'string' || name === 'None' || !Object.hasOwn(TokenScope, name)) {
      return `unknown scope ${String(name)}`;
    }
    bits |= TokenScope[name as keyof typeof TokenScope];
  }
  // A resource never receives UserRead or a scope only a client acting as itself can hold. The Apps
  // scopes (`AppsRead`, `AppDataRead`) are user scopes, so a resource may list them.
  if ((bits & TokenScope.UserRead) !== 0n) return 'scopes may not include UserRead';
  if (carriesNonUserScope(bits)) return 'scopes may not include a client-only scope';
  return bits;
}

function serviceEntryError(value: unknown, resourceScopes: bigint): string | ServiceEntry {
  if (!value || typeof value !== 'object') return 'each service must be an object';
  const e = value as Record<string, unknown>;
  if (typeof e.client !== 'string' || !SERVICE_CLIENT_ID.test(e.client)) {
    return 'a service client id must be a lowercase random UUID';
  }
  const scopes = scopesFrom(e.scopes);
  if (typeof scopes === 'string') return `service ${e.client}: ${scopes}`;
  if ((scopes & ~resourceScopes) !== 0n) {
    return `service ${e.client}: scopes must be within the resource's`;
  }
  const roles = e.roles ?? [];
  if (!Array.isArray(roles) || roles.length > MAX_ROLES) {
    return `service ${e.client}: roles must be a list of at most ${MAX_ROLES}`;
  }
  if (roles.some((r) => typeof r !== 'string' || !ROLE.test(r))) {
    return `service ${e.client}: invalid role`;
  }
  const uid = e.uid;
  if (
    typeof uid !== 'number' ||
    !Number.isInteger(uid) ||
    uid > MAX_SERVICE_UID ||
    uid < MIN_INT32
  ) {
    return `service ${e.client}: uid must be an integer from ${MIN_INT32} to ${MAX_SERVICE_UID}`;
  }
  return { client: e.client, scopes, roles: roles as string[], uid };
}

/**
 * Fill in each resource's `services` from the raw entries. A resource whose list is invalid gets none,
 * and the reason is returned; the other resources and lists are untouched.
 */
function attachServices(resources: ExchangeResource[], rawServices: unknown[]): string[] {
  const errors: string[] = [];
  const userClients = new Set(resources.flatMap((r) => [...r.apps, ...r.relays]));
  // A uid names one service everywhere. The first resource to use it keeps it; a later one that repeats
  // it loses its services.
  const takenUids = new Set<number>();
  for (const [i, resource] of resources.entries()) {
    const raw = rawServices[i] ?? [];
    const fail = (why: string) => errors.push(`${resource.resource}: services ignored: ${why}`);
    if (!Array.isArray(raw)) {
      fail('services must be a list');
      continue;
    }
    const entries: ServiceEntry[] = [];
    let error: string | null = null;
    for (const value of raw) {
      const entry = serviceEntryError(value, resource.scopes);
      if (typeof entry === 'string') error = entry;
      else if (userClients.has(entry.client)) {
        error = `service ${entry.client} is also an app or relay`;
      } else if (entries.some((s) => s.client === entry.client)) {
        error = `service ${entry.client} is listed twice`;
      } else if (takenUids.has(entry.uid) || entries.some((s) => s.uid === entry.uid)) {
        error = `uid ${entry.uid} is used more than once`;
      } else entries.push(entry);
      if (error) break;
    }
    if (error) fail(error);
    else {
      resource.services = entries;
      for (const s of entries) takenUids.add(s.uid);
    }
  }
  return errors;
}

/**
 * Fill in each resource's `serviceSubjects` from the raw lists. A list that is not a list of service client
 * ids, repeats one, or names an app or relay of any resource is dropped (that resource gets none), and the
 * reason is returned; the other resources and lists are untouched.
 */
function attachServiceSubjects(resources: ExchangeResource[], rawLists: unknown[]): string[] {
  const errors: string[] = [];
  const userClients = new Set(resources.flatMap((r) => [...r.apps, ...r.relays]));
  for (const [i, resource] of resources.entries()) {
    const raw = rawLists[i] ?? [];
    const fail = (why: string) =>
      errors.push(`${resource.resource}: serviceSubjects ignored: ${why}`);
    if (!Array.isArray(raw)) {
      fail('serviceSubjects must be a list');
      continue;
    }
    const bad = raw.find((id) => typeof id !== 'string' || !SERVICE_CLIENT_ID.test(id));
    if (bad !== undefined) {
      fail('a service client id must be a lowercase random UUID');
      continue;
    }
    const ids = raw as string[];
    const user = ids.find((id) => userClients.has(id));
    if (user !== undefined) {
      fail(`${user} is also an app or relay`);
      continue;
    }
    if (new Set(ids).size !== ids.length) {
      fail('a client is listed twice');
      continue;
    }
    resource.serviceSubjects = ids;
  }
  return errors;
}

/**
 * The registry parsed from `raw`, or the first reason it is invalid. `serviceErrors` lists the resources
 * whose `services` were dropped, and why.
 */
export function parseExchangeResources(
  raw: string | undefined
): { resources: ExchangeResource[]; serviceErrors: string[] } | { error: string } {
  if (!raw?.trim()) return { resources: [], serviceErrors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'OAUTH_EXCHANGE_RESOURCES is not valid JSON' };
  }
  if (!Array.isArray(parsed)) return { error: 'OAUTH_EXCHANGE_RESOURCES must be a JSON array' };

  const resources: ExchangeResource[] = [];
  const rawServices: unknown[] = [];
  const rawServiceSubjects: unknown[] = [];
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

    // Absent is false; any other non-boolean (null included) is a bad entry.
    const narrowsBlockClaims = e.narrowsBlockClaims === undefined ? false : e.narrowsBlockClaims;
    if (typeof narrowsBlockClaims !== 'boolean') {
      return { error: `${resource}: narrowsBlockClaims must be true or false` };
    }

    resources.push({
      resource,
      scopes,
      ...lists,
      services: [],
      serviceSubjects: [],
      narrowsBlockClaims,
    });
    rawServices.push(e.services);
    rawServiceSubjects.push(e.serviceSubjects);
  }
  const serviceErrors = [
    ...attachServices(resources, rawServices),
    ...attachServiceSubjects(resources, rawServiceSubjects),
  ];
  return { resources, serviceErrors };
}

/**
 * Warn about service clients whose row cannot get a token: missing, not owned by the system account, any
 * grant but the service grant, no secret, or disabled. Only a warning: the token route and introspection
 * check the row on every request, so a database error here never turns a service off.
 */
async function warnOnServiceClients(resources: ExchangeResource[]): Promise<void> {
  const ids = [...new Set(resources.flatMap((r) => r.services.map((s) => s.client)))];
  if (ids.length === 0) return;
  try {
    const rows = await db
      .selectFrom('OauthClient')
      .select(['id', 'userId', 'grants', 'isConfidential', 'secret', 'accessMode'])
      .where('id', 'in', ids)
      .execute();
    for (const id of ids) {
      const row = rows.find((r) => r.id === id);
      const problem = !row
        ? 'not found'
        : !isServiceClient(row)
        ? 'not a system-owned service client'
        : !row.isConfidential || !row.secret
        ? 'has no secret'
        : null;
      if (problem) {
        void logToAxiom({
          type: 'warning',
          name: 'oauth-exchange-service-client',
          message: `service client ${id} ${problem}`,
        });
      }
    }
  } catch (err) {
    void logToAxiom({
      type: 'warning',
      name: 'oauth-exchange-service-client',
      message: `service clients not checked: ${String(err)}`,
    });
  }
}

/**
 * Whether the client row may hold service tokens: owned by the system account, holding the service grant and
 * no other, and not disabled.
 */
export function isServiceClient(row: {
  userId: number;
  grants: string[];
  accessMode: string;
}): boolean {
  return (
    row.userId === SYSTEM_USER_ID &&
    row.grants.length === 1 &&
    row.grants[0] === SERVICE_GRANT &&
    row.accessMode !== 'disabled'
  );
}

let cache: { raw: string | undefined; resources: Promise<ExchangeResource[]> } | undefined;

async function load(raw: string | undefined): Promise<ExchangeResource[]> {
  const parsed = parseExchangeResources(raw);
  if ('error' in parsed) {
    void logToAxiom({
      type: 'error',
      name: 'oauth-exchange-resources-invalid',
      message: parsed.error,
    });
    return [];
  }
  for (const message of parsed.serviceErrors) {
    void logToAxiom({ type: 'error', name: 'oauth-exchange-services-invalid', message });
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
    });
    return [];
  }
  void warnOnServiceClients(parsed.resources);
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
