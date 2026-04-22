/**
 * Cross-domain generation form handoff.
 *
 * Encodes the current graph snapshot into a base64 URL parameter so a user
 * jumping from .com to .red (or vice-versa) lands on the form pre-populated
 * with the same workflow, prompt, resources, etc. The receiving side decodes
 * the param and pushes it through `generationGraphStore.setData` as a remix.
 */

import type { GenerationResource } from '~/shared/types/generation.types';
import { combineResources } from '~/shared/utils/resource.utils';

export const GENERATION_HANDOFF_PARAM = 'gen';

/** Output settings the receiver shouldn't override on the destination form. */
const OUTPUT_KEYS = new Set(['quantity', 'priority', 'outputFormat']);

/** Resource-bearing keys that get hoisted into the resources array on encode. */
const RESOURCE_KEYS = ['model', 'upscaler', 'vae'] as const;

interface DecodedHandoff {
  params: Record<string, unknown>;
  resources: GenerationResource[];
}

/**
 * Build a `?gen=...` payload from the current graph snapshot.
 * Returns undefined when the snapshot has nothing meaningful to transfer.
 */
export function encodeGenerationHandoff(
  snapshot: Record<string, unknown>,
  options: { computedKeys?: string[] } = {}
): string | undefined {
  const { computedKeys = [] } = options;

  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (computedKeys.includes(key)) continue;
    if (OUTPUT_KEYS.has(key)) continue;
    if (RESOURCE_KEYS.includes(key as (typeof RESOURCE_KEYS)[number])) continue;
    if (key === 'resources') continue;
    if (value === undefined || value === null) continue;
    params[key] = value;
  }

  const resources = combineResources({
    model: snapshot.model as GenerationResource | undefined,
    upscaler: snapshot.upscaler as GenerationResource | undefined,
    vae: snapshot.vae as GenerationResource | undefined,
    resources: (snapshot.resources as GenerationResource[] | undefined) ?? [],
  });

  if (Object.keys(params).length === 0 && resources.length === 0) return undefined;

  const payload: DecodedHandoff = { params, resources };
  const json = JSON.stringify(payload);
  return toBase64Url(json);
}

/** Decode a `?gen=...` payload back into params + resources. Returns null on any failure. */
export function decodeGenerationHandoff(value: string | null | undefined): DecodedHandoff | null {
  if (!value) return null;
  try {
    const json = fromBase64Url(value);
    const parsed = JSON.parse(json) as DecodedHandoff;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.params || typeof parsed.params !== 'object') return null;
    if (!Array.isArray(parsed.resources)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// URL-safe base64 — replace +/= with -_ and strip padding so the value
// survives URL params without escaping.
function toBase64Url(input: string): string {
  const utf8 = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(input) : null;
  const binary = utf8
    ? String.fromCharCode(...utf8)
    : unescape(encodeURIComponent(input));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + padding);
  if (typeof TextDecoder !== 'undefined') {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return decodeURIComponent(escape(binary));
}
