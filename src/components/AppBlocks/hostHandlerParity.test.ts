import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INVENTORY, type HostFile } from './hostHandlerParity';

/**
 * App Blocks host↔SDK handler PARITY guard (runtime half).
 *
 * What is enforced, and by WHAT:
 *
 *  1. COMPILE-TIME (in the sibling NON-test module `hostHandlerParity.ts`): a
 *     type-level assertion that every message type in the PUBLISHED
 *     `@civitai/app-sdk/blocks` `BlockToParentMessage` union is a key of
 *     `INVENTORY`. A future PUBLISHED SDK message that INVENTORY doesn't list
 *     becomes a TypeScript error in civitai's Tekton typecheck / `next build`.
 *     That is the ONE manual step this runtime test cannot catch. (It is
 *     one-directional: INVENTORY may carry forward-looking entries ahead of the
 *     published dist — e.g. CANCEL_WORKFLOW / REQUEST_SIGN_IN / REQUEST_CONSENT.)
 *
 *  2. RUNTIME (this file): for each `'required'` INVENTORY entry, grep the host
 *     SOURCE for an `onMessage('<TYPE>', …)` registration and FAIL if missing.
 *     This catches the "handler removed / new host surface not wired" case for
 *     the messages we already know about.
 *
 * THE BUG CLASS (gotcha-#73, the "spins forever, no network call, no console
 * error" class): a REQUEST-style block→host message with NO host handler never
 * gets its `*_RESULT`/ack reply → the block hangs to its SDK request timeout →
 * the UI spins forever. The dev:live SDK host serves these messages, so authors
 * test green locally then break in prod (this exact gap bit
 * OPEN_CHECKPOINT_PICKER on pages, fixed in civitai #2799).
 *
 * This is a deliberately DUMB structural grep — it asserts a handler is
 * REGISTERED, not that it's correct. Behavioral correctness lives in the
 * per-message browser tests (PageBlockHost*.browser.test.tsx).
 */

const HOST_DIR = join(__dirname);

// Read each host source once. (InlineHost is a v2 stub that throws on render and
// runs NO message bridge in v1 — see the N/A exemptions in INVENTORY; we still
// read it so a future activation is forced through this guard.)
const HOST_SRC: Record<HostFile, string> = {
  'IframeHost.tsx': stripComments(readFileSync(join(HOST_DIR, 'IframeHost.tsx'), 'utf8')),
  'PageBlockHost.tsx': stripComments(readFileSync(join(HOST_DIR, 'PageBlockHost.tsx'), 'utf8')),
  'InlineHost.tsx': stripComments(readFileSync(join(HOST_DIR, 'InlineHost.tsx'), 'utf8')),
};

/**
 * Strip `/* *​/` block comments and `//` line comments from a source string so
 * the handler grep can't FALSE-POSITIVE on a `'TYPE'` mention that merely sits
 * in a comment/JSDoc next to the word `onMessage` (which would mark a message
 * "covered" with no real handler).
 *
 * SAFETY: this is a deliberately naive strip (it does not parse strings/regex
 * literals), so it could over-strip in a pathological case — but an over-strip
 * can only REMOVE a real `onMessage('TYPE'` and cause a spurious FAILURE
 * (safe-fail, a human investigates), never a false PASS. It never adds coverage.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (keep `://` in URLs)
}

/**
 * True if `src` registers a handler for `type`. Handler registrations span
 * multiple lines and may carry an inline generic, e.g.:
 *
 *     const off = onMessage<{ requestId?: unknown } | undefined>(
 *       'SET_USER_CHECKPOINT',
 *       async (raw) => { … }
 *     );
 *
 * or a one-liner `onMessage<unknown>('OPEN_CHECKPOINT_PICKER', (raw) => …)`. So
 * we DON'T require the `'TYPE'` literal to sit on the same line as `onMessage(`;
 * we require an `onMessage` call (optionally with a `<…>` type arg) followed,
 * across any whitespace/newlines, by the quoted type literal as its FIRST
 * argument. The literal is matched whole (`'TYPE'`) so `OPEN_CHECKPOINT_PICKER`
 * can't be satisfied by a substring of another type. Comments are stripped from
 * `src` before this runs (see stripComments) so a commented mention can't pass.
 */
function handlesMessage(src: string, type: string): boolean {
  // onMessage  [<...generic...>]  (  [ws/newlines]  'TYPE'
  // The generic arg can itself contain `>` (union types), so match it
  // non-greedily up to the opening `(` rather than a naive `<[^>]*>`.
  const re = new RegExp(
    String.raw`onMessage\s*(?:<[\s\S]*?>)?\s*\(\s*` + `'${type}'`,
    'm'
  );
  return re.test(src);
}

const HOSTS: HostFile[] = ['IframeHost.tsx', 'PageBlockHost.tsx', 'InlineHost.tsx'];

describe('App Blocks host↔SDK handler parity (gotcha-#73 "spins forever" guard)', () => {
  // Per-host × per-message: a 'required' entry MUST have a registered handler.
  for (const host of HOSTS) {
    describe(host, () => {
      for (const [type, spec] of Object.entries(INVENTORY)) {
        const req = spec[host.replace('.tsx', '') as 'IframeHost' | 'PageBlockHost' | 'InlineHost'];
        if (req === 'required') {
          it(`handles '${type}'${spec.request ? ` (REQUEST → ${spec.reply})` : ' (fire-and-forget)'}`, () => {
            // If this fails: the host is MISSING an onMessage('<TYPE>', …)
            // registration. For a REQUEST-style message that means a block
            // calling the corresponding hook HANGS to its SDK timeout (spins
            // forever, no network call). Port a handler (mirror the other host),
            // OR if it's genuinely N/A here, change INVENTORY[<TYPE>][<host>] to
            // a short N/A rationale string.
            expect(
              handlesMessage(HOST_SRC[host], type),
              `${host} is missing onMessage('${type}')`
            ).toBe(true);
          });
        } else {
          // N/A — assert the exemption is a non-empty human-readable rationale,
          // so an exemption can't be a silent `''` or `true`.
          it(`exempts '${type}' with a rationale`, () => {
            expect(typeof req).toBe('string');
            expect((req as string).length).toBeGreaterThan(10);
          });
        }
      }
    });
  }

  it('every REQUEST-style message is handled by PageBlockHost (the page hang surface)', () => {
    // Focused invariant: REQUEST-style messages are the ones that HANG when
    // unhandled. The page host is the surface most likely to drift (it's newer
    // and hand-mirrors IframeHost). Require an explicit decision for each — a
    // registered handler OR a documented N/A — never an accidental gap.
    const requestMessages = Object.entries(INVENTORY).filter(([, s]) => s.request);
    for (const [type, spec] of requestMessages) {
      if (spec.PageBlockHost === 'required') {
        expect(
          handlesMessage(HOST_SRC['PageBlockHost.tsx'], type),
          `PageBlockHost must register onMessage('${type}') — REQUEST-style messages hang the block when unhandled`
        ).toBe(true);
      } else {
        expect(
          typeof spec.PageBlockHost === 'string' && (spec.PageBlockHost as string).length > 10,
          `REQUEST-style '${type}' is exempted from PageBlockHost — it MUST carry a rationale`
        ).toBe(true);
      }
    }
  });
});
