import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { recordBlockMediaInputRefused } from '~/server/metrics/app-block-runtime.metrics';
import {
  BLOCK_MEDIA_PATH,
  BLOCK_MEDIA_TOKEN_PREFIX,
} from '~/server/services/blocks/block-media-token';

/**
 * Host media urls and refs are viewer-bound bearer values, never workflow inputs: an output is
 * reused through `persistGenerationSource`, which reads the viewer's own workflow under their token.
 */
export const BLOCK_MEDIA_INPUT_MESSAGE =
  'Host media urls cannot be used as workflow inputs. Save the output with persistGenerationSource and use the url it returns.';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// Both derived from the mint, so a change there cannot leave this guard matching nothing.
const MEDIA_PATH = new RegExp(`${escape(BLOCK_MEDIA_PATH.toLowerCase())}(?:[/?#]|$)`);
// The segment minimums (12-byte iv, 16-byte tag) keep a version string like `bm1.2.3.4` out.
const MEDIA_TOKEN = new RegExp(
  `(?:^|[^a-z0-9_-])${escape(
    BLOCK_MEDIA_TOKEN_PREFIX.toLowerCase()
  )}\\.[a-z0-9_-]{16,}\\.[a-z0-9_-]{16,}\\.[a-z0-9_-]{20,}`
);
const MAX_DECODE_ROUNDS = 4;
// Past these bounds the body is refused.
const MAX_DEPTH = 256;
const MAX_VISITS = 524_288;

/** Every spelling the match must see through: percent-encoding (repeated), case, backslashes, doubled slashes. */
function spellings(raw: string): string[] {
  const out: string[] = [];
  let current = raw;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round++) {
    out.push(
      current
        .toLowerCase()
        .replace(/\\/g, '/')
        .replace(/\/{2,}/g, '/')
    );
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      next = current.replace(/%2f/gi, '/');
    }
    if (next === current) break;
    current = next;
  }
  return out;
}

export function isBlockMediaReference(value: string): boolean {
  return spellings(value).some((s) => MEDIA_PATH.test(s) || MEDIA_TOKEN.test(s));
}

/** Whether any string anywhere in `value` names host media. Past the walk bounds it answers yes. */
export function containsBlockMediaReference(value: unknown): boolean {
  let visits = 0;
  const walk = (item: unknown, depth: number): boolean => {
    if (++visits > MAX_VISITS || depth > MAX_DEPTH) return true;
    if (typeof item === 'string') return isBlockMediaReference(item);
    if (Array.isArray(item)) return item.some((child) => walk(child, depth + 1));
    if (item && typeof item === 'object')
      return Object.values(item).some((child) => walk(child, depth + 1));
    return false;
  };
  return walk(value, 0);
}

/** Refuses a workflow body that carries host media anywhere, before any orchestrator call. */
export function assertNoBlockMediaInputs(
  body: unknown,
  log: { appBlockId: string; phase: 'estimate' | 'submit' }
) {
  if (!containsBlockMediaReference(body)) return;
  recordBlockMediaInputRefused(log.phase);
  logToAxiom({
    type: 'info',
    name: 'app-block-media-input-refused',
    appBlockId: log.appBlockId,
    phase: log.phase,
  });
  throw new TRPCError({ code: 'BAD_REQUEST', message: BLOCK_MEDIA_INPUT_MESSAGE });
}
