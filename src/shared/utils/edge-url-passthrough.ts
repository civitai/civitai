/**
 * Does `getEdgeUrl` forward this `src` UNMODIFIED?
 *
 * When this is false, `getEdgeUrl` prefixes `NEXT_PUBLIC_IMAGE_LOCATION`, so the result
 * can only ever land on our own storage edge. When it is true, the string reaches the
 * consumer — including the orchestrator's server-side fetch — exactly as the caller wrote it.
 *
 * 🔴 Single-sourced deliberately: this is the boundary the image-scan ingestion allowlist
 * (`~/server/utils/image-scan-url`) has to gate. While the two were open-coded separately
 * they disagreed — the allowlist tested `/^https?:\/\//`, which requires the `//`, so a
 * URL like `http:/127.0.0.1:6379/` was classified a relative key and allowed, then
 * forwarded unmodified here, then normalized back to `http://127.0.0.1:6379/` by WHATWG
 * URL parsing at the fetch. Keep the allowlist and both `getEdgeUrl` call sites on this
 * one predicate.
 *
 * This module imports NOTHING on purpose: the server-side allowlist consumes it, and
 * pulling `~/env/client` (which throws on validation) into that import graph breaks the
 * suites that mock `~/client-utils/edge-url` specifically to keep it out of their worker.
 */
export function isEdgeUrlPassthrough(src: string): boolean {
  return !src || src.startsWith('http') || src.startsWith('blob');
}
