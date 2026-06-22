import { CIVITAI_OWNED_DOMAINS } from './constants';
import { isCivitaiOrigin } from './redirect';

// TRUSTED-DOMAIN REGISTRY — the in-memory-cached "is this one of our hosts" source, shared by every app that
// talks to the hub. The DB read is INJECTED (`load`) so the package keeps ZERO infra deps (same convention as
// createSessionRegistry / the verifier's isRevoked). One instance backs BOTH the hub's first-party OAuth client
// resolution AND the post-login redirect guard off a single cached snapshot — so a new spoke host is one
// registry row, never a code constant. Generalizes the hub's former bespoke `loadDomains` cache.

export interface TrustedDomain {
  domain: string; // bare host, lower-cased (no scheme/port) — e.g. civitai.com
  includeSubdomains: boolean; // also match *.domain (ephemeral PR-preview subdomains)
}

export interface TrustedDomainRegistryConfig {
  /** Load the trusted domains (e.g. the hub's `TrustedSpokeDomain` query). Called at most once per `ttlMs`. */
  load: () => Promise<TrustedDomain[]>;
  /** In-memory cache TTL in ms. Default 60_000 (one query per window). */
  ttlMs?: number;
  /** Hostnames trusted outright regardless of the registry (e.g. dev loopback `localhost`/`127.0.0.1`). */
  alwaysTrustHosts?: string[];
}

export interface TrustedDomainRegistry {
  /** Cached entries — refreshes past the TTL, serves the last-good list on a load error (fail-safe), and
   * coalesces concurrent refreshes into one load. */
  list(): Promise<TrustedDomain[]>;
  /** True when `hostname` is trusted: an always-trust host, an exact registry match, or a subdomain of an
   * `includeSubdomains` entry. This is the OAuth-trust check (NO owned-domain backstop). */
  matchesHost(hostname: string): Promise<boolean>;
  /**
   * Resolve the registry ONCE, then return a SYNCHRONOUS origin predicate for `buildPostLoginRedirect`'s
   * `isAllowedOrigin`. Allows: always-trust ∪ registry ∪ the owned-eTLD+1 backstop (`CIVITAI_OWNED_DOMAINS`).
   * The backstop is why a cold/erroring registry can't reject every cross-origin post-login redirect — and why
   * onboarding a brand-new registrable domain is a registry row, not an edit to the static constant.
   */
  ownedOriginCheck(): Promise<(origin: string) => boolean>;
  /** Force the next read to re-query (call after a write so edits take effect before the TTL elapses). */
  invalidate(): void;
}

const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const matchesEntries = (hostname: string, entries: TrustedDomain[]): boolean =>
  entries.some(
    (e) => hostname === e.domain || (e.includeSubdomains && hostname.endsWith(`.${e.domain}`))
  );

export function createTrustedDomainRegistry(
  config: TrustedDomainRegistryConfig
): TrustedDomainRegistry {
  const ttlMs = config.ttlMs ?? 60_000;
  const always = (config.alwaysTrustHosts ?? []).map((h) => h.toLowerCase());

  let cache: TrustedDomain[] | undefined;
  let fetchedAt = 0;
  let inflight: Promise<TrustedDomain[]> | undefined;

  async function list(): Promise<TrustedDomain[]> {
    if (cache && Date.now() - fetchedAt < ttlMs) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const rows = await config.load();
        cache = rows.map((r) => ({
          domain: r.domain.toLowerCase(),
          includeSubdomains: r.includeSubdomains,
        }));
        fetchedAt = Date.now();
      } catch {
        // Fail-safe: serve the last good list, or empty (→ the backstop covers it) if never populated. A DB
        // outage must not throw on the auth path.
        if (!cache) cache = [];
      } finally {
        inflight = undefined;
      }
      return cache as TrustedDomain[];
    })();
    return inflight;
  }

  async function matchesHost(hostname: string): Promise<boolean> {
    const h = hostname.toLowerCase();
    return always.includes(h) || matchesEntries(h, await list());
  }

  async function ownedOriginCheck(): Promise<(origin: string) => boolean> {
    const entries = await list();
    return (origin: string): boolean => {
      const host = hostOf(origin);
      if (!host) return false;
      return always.includes(host) || matchesEntries(host, entries) || isCivitaiOrigin(origin);
    };
  }

  function invalidate(): void {
    fetchedAt = 0; // next list() sees the entry as stale and re-queries
  }

  return { list, matchesHost, ownedOriginCheck, invalidate };
}
