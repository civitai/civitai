import { isIP } from 'node:net';

/**
 * Client-IP derivation for security controls (abuse blocklists, per-client
 * quotas).
 *
 * A control that keys on a client IP is only as strong as the provenance of
 * that IP. This module derives it from the two sources the origin can attest:
 *
 *  1. The Cloudflare edge — `cf-connecting-ip`, accepted ONLY when `cf-ray` is
 *     also present. Cloudflare stamps `cf-ray` on every request it proxies and
 *     its value identifies a specific edge datacenter request, so its presence
 *     is what establishes that the pair actually came from the edge rather than
 *     from the caller.
 *  2. The transport peer — `req.socket.remoteAddress`, which is observed from
 *     the connection itself and is not part of the request the caller composes.
 *
 * Nothing else is consulted. Any other forwarding header is, by definition, a
 * value chosen by whoever composed the request, and a control keyed on such a
 * value can be re-pointed at will by the party it is meant to constrain.
 *
 * The trade this makes deliberately: traffic that reaches the origin without
 * edge transit is attributed to the connection peer (in this deployment, the
 * load balancer) rather than to a self-declared address. That collapses such
 * traffic into one bucket, which is the correct direction to fail for an
 * enforcement control. Full rationale and threat model live in the internal
 * infra security report (same one PR #3627's comment points at); they are
 * deliberately not restated in this public repo.
 *
 * This is the SINGLE predicate for that derivation. Do not re-derive a client
 * IP inline at a call site; import from here.
 */

type IpSourceRequest = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string } | null;
};

/**
 * True when `value` is a syntactically valid IPv4 or IPv6 address.
 *
 * Backed by node's `net.isIP`, so it is the same parser the runtime uses. This
 * is the validation every consumer of a client IP should apply before the value
 * is allowed to reach a query, a cache key, or a comparison — see
 * `fetchDownloadCount` for a call site that depends on it.
 */
export function isIpAddress(value: unknown): value is string {
  return typeof value === 'string' && isIP(value) !== 0;
}

/** First value of a header that may arrive repeated, trimmed; `undefined` when absent/blank. */
function headerValue(raw: string | string[] | undefined): string | undefined {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') return undefined;
  const trimmed = first.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * IPv4-mapped IPv6 (`::ffff:203.0.113.7`) → dotted quad (`203.0.113.7`).
 *
 * Node reports an IPv4 peer on a dual-stack listener in the mapped form. An
 * operator maintaining a blocklist writes the dotted quad, so without this
 * normalization a socket-derived address would never match a list entry.
 */
function normalizeIp(ip: string): string {
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(ip);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  return ip;
}

/**
 * Resolve the client IP for a security control.
 *
 * Returns `null` when neither source yields a valid address — callers must
 * treat that as "unknown", never as a match.
 */
export function getTrustedClientIp(req: IpSourceRequest): string | null {
  const headers = req.headers ?? {};

  // Edge-attested: cf-connecting-ip is meaningful only alongside cf-ray.
  const cfRay = headerValue(headers['cf-ray']);
  if (cfRay) {
    const cfIp = headerValue(headers['cf-connecting-ip']);
    if (isIpAddress(cfIp)) return normalizeIp(cfIp);
  }

  // Transport peer.
  const socketIp = req.socket?.remoteAddress?.trim();
  if (isIpAddress(socketIp)) return normalizeIp(socketIp);

  return null;
}
