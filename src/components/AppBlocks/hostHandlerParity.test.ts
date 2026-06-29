import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * App Blocks host↔SDK handler PARITY guard.
 *
 * THE BUG CLASS this encodes (gotcha-#73, the "spins forever, no network call,
 * no console error" class):
 *
 *   App Blocks has multiple host components that each register their own
 *   `onMessage('<TYPE>', …)` handlers BY HAND to bridge a block's postMessages:
 *     - IframeHost.tsx     — model-slot host (model.sidebar slots)
 *     - PageBlockHost.tsx  — full-page run host (civitai.com/apps/run/<slug>)
 *     - InlineHost.tsx     — inline host (v2 stub, not active in prod)
 *
 *   The SDK (`@civitai/app-sdk` / `@civitai/blocks-react`) sends two flavours of
 *   block→host message: REQUEST-style (`sendTypedRequest`, AWAITS a specific
 *   `*_RESULT` / ack reply) and fire-and-forget (`sendMessage`, no reply). When
 *   a block sends a REQUEST-style message and the host has NO handler, the
 *   request never gets a reply → the block hangs to its SDK request timeout →
 *   the UI spins forever with no network call and no error. The dev:live SDK
 *   host serves these messages, so authors test green locally then break in
 *   prod — a fidelity gap (this exact gap bit OPEN_CHECKPOINT_PICKER on pages,
 *   fixed in civitai #2799).
 *
 * THIS TEST converts that whole class into a BUILD-TIME error: it hard-codes
 * the inventory of every block→host message `type` the SDK can send, and per
 * type which host files MUST register an `onMessage('<TYPE>'` handler (or an
 * explicit `N/A: <reason>` exemption). It then greps each required host source
 * for the registration. If someone adds an SDK message — or a new host surface
 * — without wiring the host, this FAILS CI instead of silently shipping a
 * spin-forever block.
 *
 * SOURCE OF TRUTH for the inventory: the SDK message protocol
 * `@civitai/app-sdk` `blocks/messages.ts` `BlockToParentMessage` union, cross-
 * referenced with the `@civitai/blocks-react` hooks (which `type` each posts and
 * whether it uses `sendTypedRequest` [REQUEST] or `sendMessage` [fire-forget]).
 * When the SDK adds a block→host message, add it here with its hosts/exemptions.
 *
 * Maintenance: this is a deliberately DUMB structural grep — it asserts a
 * handler is REGISTERED, not that it's correct. Behavioral correctness lives in
 * the per-message browser tests (PageBlockHost*.browser.test.tsx). The value
 * here is catching the MISSING-handler case the next time the protocol grows.
 */

const HOST_DIR = join(__dirname);

type HostFile = 'IframeHost.tsx' | 'PageBlockHost.tsx' | 'InlineHost.tsx';

// Read each host source once. (InlineHost is a v2 stub that throws on render and
// runs NO message bridge in v1 — see the N/A exemptions below; we still read it
// so a future activation is forced through this guard.)
const HOST_SRC: Record<HostFile, string> = {
  'IframeHost.tsx': readFileSync(join(HOST_DIR, 'IframeHost.tsx'), 'utf8'),
  'PageBlockHost.tsx': readFileSync(join(HOST_DIR, 'PageBlockHost.tsx'), 'utf8'),
  'InlineHost.tsx': readFileSync(join(HOST_DIR, 'InlineHost.tsx'), 'utf8'),
};

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
 * can't be satisfied by a substring of another type.
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

/**
 * The authoritative inventory: every block→host message the SDK can send, with
 * per-host requirements. `request: true` = REQUEST-style (awaits a reply; an
 * unhandled one HANGS the block — this is the dangerous class). For each host,
 * `'required'` means the host MUST register a handler; a string is an explicit
 * `N/A` rationale (the host legitimately doesn't handle it).
 *
 * Keep one-line rationales human-readable — they ARE the documentation a future
 * maintainer reads when this test fails.
 */
type HostReq = 'required' | string; // string = N/A reason

interface MessageSpec {
  /** REQUEST-style (sendTypedRequest, awaits a *_RESULT/ack). Unhandled ⇒ hang. */
  request: boolean;
  /** Reply type the SDK awaits (REQUEST-style only); '' for fire-and-forget. */
  reply: string;
  IframeHost: HostReq;
  PageBlockHost: HostReq;
  InlineHost: HostReq;
}

// InlineHost is a v1 STUB that throws on render and wires NO message bridge
// (BlockHost never routes inline installs in v1 — `canUseInline` is always
// false). So EVERY message is N/A for it today; the shared reason is below.
const INLINE_STUB = 'InlineHost is a v1 stub (throws on render, no message bridge in v1)';

const INVENTORY: Record<string, MessageSpec> = {
  // ── Lifecycle / fire-and-forget (no reply ⇒ unhandled never HANGS, but a
  //    page that ignores them just no-ops; documented per host) ───────────────
  BLOCK_READY: {
    request: false,
    reply: '',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  BLOCK_ERROR: {
    request: false,
    reply: '',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  RESIZE_IFRAME: {
    request: false,
    reply: '',
    IframeHost: 'required',
    // N/A: the page renders the iframe full-viewport (height:100%); a page block
    // fills the surface and does NOT size-to-content, so there is nothing to
    // resize. Fire-and-forget ⇒ an ignored RESIZE_IFRAME never hangs the block.
    PageBlockHost:
      'page iframe is full-viewport (height:100%); no size-to-content, fire-and-forget so no hang',
    InlineHost: INLINE_STUB,
  },
  NAVIGATE: {
    request: false,
    reply: '',
    // N/A: the model slot is an embedded panel inside the model page — a block
    // navigating the host away from the model page is out of its remit; the
    // model host intentionally does not bridge NAVIGATE.
    IframeHost: 'model slot is an embedded panel; host-navigation is out of remit (no NAVIGATE bridge)',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  TRACK_EVENT: {
    request: false,
    reply: '',
    // N/A (both real hosts): TRACK_EVENT is fire-and-forget analytics and is
    // currently NOT bridged by EITHER host (no host-side analytics sink wired).
    // Unhandled ⇒ silently dropped, never a hang. If a sink is added, flip the
    // relevant host(s) to 'required' here so coverage is enforced.
    IframeHost: 'analytics fire-and-forget; no host-side sink wired (dropped, never hangs)',
    PageBlockHost: 'analytics fire-and-forget; no host-side sink wired (dropped, never hangs)',
    InlineHost: INLINE_STUB,
  },
  REQUEST_SIGN_IN: {
    request: false,
    reply: '',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  REQUEST_CONSENT: {
    request: false,
    reply: '',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },

  // ── REQUEST-style (await a reply ⇒ unhandled HANGS the block) ───────────────
  REQUEST_TOKEN: {
    request: true,
    reply: 'TOKEN_REFRESH_RESPONSE',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SUBMIT_WORKFLOW: {
    request: true,
    reply: 'WORKFLOW_SUBMITTED',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  ESTIMATE_WORKFLOW: {
    request: true,
    reply: 'ESTIMATE_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  POLL_WORKFLOW: {
    request: true,
    reply: 'WORKFLOW_STATUS',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  CANCEL_WORKFLOW: {
    request: true,
    reply: 'WORKFLOW_CANCELED',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  OPEN_BUZZ_PURCHASE: {
    request: true,
    reply: 'BUZZ_PURCHASE_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  OPEN_CHECKPOINT_PICKER: {
    request: true,
    reply: 'CHECKPOINT_PICKER_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required', // ported in #2799
    InlineHost: INLINE_STUB,
  },
  SET_USER_CHECKPOINT: {
    request: true,
    reply: 'USER_CHECKPOINT_SET',
    IframeHost: 'required',
    // PAGE: persists to block_user_settings keyed by a model-bound install;
    // updateUserSettings HARD-REQUIRES modelId in the token ctx, which a page
    // token (entityType:'none') lacks. The page host registers a FAIL-FAST NACK
    // (USER_CHECKPOINT_SET ok:false) so persist() rejects immediately instead of
    // hanging — see the handler comment + the parity doc's OPEN DECISION.
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_GET: {
    request: true,
    reply: 'APP_STORAGE_GET_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_SET: {
    request: true,
    reply: 'APP_STORAGE_SET_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_DELETE: {
    request: true,
    reply: 'APP_STORAGE_DELETE_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_LIST: {
    request: true,
    reply: 'APP_STORAGE_LIST_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_QUOTA: {
    request: true,
    reply: 'APP_STORAGE_QUOTA_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
};

// The exact set of block→host message types in the SDK `BlockToParentMessage`
// union (@civitai/app-sdk blocks/messages.ts). Pinned here so that if the SDK
// adds a message and someone updates the union without updating this test, the
// "inventory matches the SDK union" assertion below fails — forcing the new
// message to be triaged through INVENTORY (and thus through host coverage).
const SDK_BLOCK_TO_PARENT_TYPES = [
  'BLOCK_READY',
  'BLOCK_ERROR',
  'REQUEST_TOKEN',
  'RESIZE_IFRAME',
  'SUBMIT_WORKFLOW',
  'ESTIMATE_WORKFLOW',
  'POLL_WORKFLOW',
  'CANCEL_WORKFLOW',
  'OPEN_BUZZ_PURCHASE',
  'OPEN_CHECKPOINT_PICKER',
  'SET_USER_CHECKPOINT',
  'NAVIGATE',
  'REQUEST_SIGN_IN',
  'REQUEST_CONSENT',
  'TRACK_EVENT',
  'APP_STORAGE_GET',
  'APP_STORAGE_SET',
  'APP_STORAGE_DELETE',
  'APP_STORAGE_LIST',
  'APP_STORAGE_QUOTA',
] as const;

const HOSTS: HostFile[] = ['IframeHost.tsx', 'PageBlockHost.tsx', 'InlineHost.tsx'];

describe('App Blocks host↔SDK handler parity (gotcha-#73 "spins forever" guard)', () => {
  it('the inventory covers EXACTLY the SDK BlockToParentMessage union (no drift)', () => {
    // If this fails: the SDK added/removed a block→host message. Update
    // INVENTORY (with per-host required/N-A) AND SDK_BLOCK_TO_PARENT_TYPES, then
    // wire any new REQUEST-style message into the hosts it applies to.
    expect([...Object.keys(INVENTORY)].sort()).toEqual([...SDK_BLOCK_TO_PARENT_TYPES].sort());
  });

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
