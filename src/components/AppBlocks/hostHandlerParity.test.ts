import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVENTORY,
  checkReplyKeys,
  parseDeclaredKeys,
  type HostFile,
  type InventoryType,
  type MessageSpec,
} from './hostHandlerParity';
import { buildBridgeNackReply } from './bridgeNackReply';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { REPLY_TYPE, ROWS, replyKeysProblems } from '../../../test/bridgeForwardMatrix';
import { BRIDGE_BUDGET_EXEMPT_TYPES } from './usePostMessage';
import { stripSourceComments } from './stripSourceComments';

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
 *     published dist. It reads the INSTALLED dist, so it is only as current as
 *     the `@civitai/app-sdk` range in `package.json`.)
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
 * Delegates to the shared quote-aware scanner (`stripSourceComments.ts`).
 *
 * This used to be a local regex. It was the SAME rule as
 * `blockStorageCacheParity.test.ts`'s, duplicated — and when that copy was
 * fixed, this one silently kept the defect: an unanchored line-comment rule
 * truncates real code containing `//`. One rule, one place.
 */
function stripComments(src: string): string {
  return stripSourceComments(src);
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
  const re = new RegExp(String.raw`onMessage\s*(?:<[\s\S]*?>)?\s*\(\s*` + `'${type}'`, 'm');
  return re.test(src);
}

const HOSTS: HostFile[] = ['IframeHost.tsx', 'PageBlockHost.tsx', 'InlineHost.tsx'];

/**
 * Types whose replies are pinned in a test of a SHARED module, not a host test. A pin there
 * counts for each host, because both hosts reply through that module. A host whose own source
 * also sends the reply (`sendsOf`, below) needs a pin from its own test as well.
 */
const SHARED_MODULE_PINS: Partial<Record<InventoryType, string>> = {
  // handleEstimateBatch hands the no-token case back to the host (`onNoToken`).
  ESTIMATE_WORKFLOW_BATCH: 'both hosts reply through handleEstimateBatch (estimateBatchGate.ts)',
};

/**
 * The `send('<reply>', …)` calls in a host's own source, comments stripped. `count` is every
 * such call; `literals` is the text of each one whose payload is an object literal. Only a
 * quoted reply type is seen, so a test below requires every `send(` in a host's source to quote
 * its type. (The shared modules send through a variable, but they are not host source.)
 */
function sendsOf(
  host: 'IframeHost' | 'PageBlockHost',
  reply: string
): { count: number; literals: string[] } {
  const src = HOST_SRC[`${host}.tsx`];
  return {
    count: (src.match(new RegExp(`send\\(\\s*'${reply}'`, 'g')) ?? []).length,
    literals: [...src.matchAll(new RegExp(`send\\(\\s*'${reply}',\\s*\\{[\\s\\S]*?\\);`, 'g'))].map(
      (m) => m[0]
    ),
  };
}

/**
 * Types that get no error reply except the shared dispatcher's NACK. Their error shape is
 * pinned by the NACK sweep, so they need no host error pin. A test below checks that neither
 * host writes an error on their reply.
 */
const NACK_ONLY_ERRORS: Partial<Record<InventoryType, string>> = {
  OPEN_BUZZ_PURCHASE: 'a refused or dismissed purchase replies { purchased: false }',
  OPEN_CHECKPOINT_PICKER: 'a dismiss replies a bare { requestId }',
};

type ReplyPin = {
  type: InventoryType;
  outcome: 'success' | 'error';
  keys: string[];
  host: 'IframeHost' | 'PageBlockHost' | 'shared';
};

/**
 * Every `expectReplyKeys(...)` call in the test files under this directory, comments stripped,
 * so a commented-out pin is no pin. A file that skips or focuses tests is rejected, since a
 * pin there may never run.
 */
function pinsFromTestSources(): ReplyPin[] {
  const pins: ReplyPin[] = [];
  const re = /expectReplyKeys\(\s*'([A-Z_]+)',\s*'(success|error)',\s*\[([^\]]*)\]/g;
  for (const entry of readdirSync(HOST_DIR, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.test\.tsx?$/.test(entry.name)) continue;
    const src = stripComments(readFileSync(join(entry.parentPath, entry.name), 'utf8'));
    const found = [...src.matchAll(re)];
    if (found.length === 0) continue;
    expect(src, `${entry.name}: pins in a file with skipped or focused tests`).not.toMatch(
      /\.(skip|only|todo|skipIf|runIf)\b/
    );
    const host = entry.name.startsWith('IframeHost')
      ? 'IframeHost'
      : entry.name.startsWith('PageBlockHost')
      ? 'PageBlockHost'
      : 'shared';
    for (const [, type, outcome, keys] of found) {
      pins.push({
        type: type as InventoryType,
        outcome: outcome as 'success' | 'error',
        keys: [...keys.matchAll(/'([^']+)'/g)].map((m) => m[1]),
        host,
      });
    }
  }
  return pins;
}

describe('App Blocks host↔SDK handler parity (gotcha-#73 "spins forever" guard)', () => {
  // Per-host × per-message: a 'required' entry MUST have a registered handler.
  for (const host of HOSTS) {
    describe(host, () => {
      for (const [type, spec] of Object.entries(INVENTORY)) {
        const req = spec[host.replace('.tsx', '') as 'IframeHost' | 'PageBlockHost' | 'InlineHost'];
        if (req === 'required') {
          it(`handles '${type}'${
            spec.request ? ` (REQUEST → ${spec.reply})` : ' (fire-and-forget)'
          }`, () => {
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
          // The other direction: an entry left N/A for a type the host handles takes that handler
          // out of the 'required' guard above, so its removal would go unnoticed.
          it(`registers no handler for exempted '${type}'`, () => {
            expect(
              handlesMessage(HOST_SRC[host], type),
              `${host} registers onMessage('${type}') but INVENTORY declares it N/A`
            ).toBe(false);
          });
        }
      }
    });
  }

  it('only fire-and-forget messages skip the shared inbound budget', () => {
    // Exempt types also skip requestId dedup, which only a fire-and-forget type can afford.
    expect(BRIDGE_BUDGET_EXEMPT_TYPES.size).toBeGreaterThan(0);
    for (const type of BRIDGE_BUDGET_EXEMPT_TYPES) expect(INVENTORY[type].request).toBe(false);
  });

  describe('replyKeys / errorKeys', () => {
    const entries = Object.entries(INVENTORY) as Array<[InventoryType, MessageSpec]>;
    const requestTypes = entries.filter(([, s]) => s.request).map(([t]) => t);
    const forwarded = new Set(Object.keys(REPLY_TYPE));

    it('declares a reply shape for exactly the REQUEST-style types', () => {
      expect(requestTypes.length).toBeGreaterThanOrEqual(43);
      for (const [type, spec] of entries) {
        if (spec.request) {
          expect(Array.isArray(spec.replyKeys), `${type}.replyKeys`).toBe(true);
          expect(spec.errorKeys, `${type}.errorKeys`).not.toBeNull();
        } else {
          expect(spec.replyKeys, `${type}.replyKeys`).toBeNull();
          expect(spec.errorKeys, `${type}.errorKeys`).toBeNull();
        }
      }
    });

    it('keeps the two lists distinguishable and free of requestId', () => {
      for (const [type, spec] of entries) {
        const lists = [spec.replyKeys, spec.errorKeys].filter(Array.isArray);
        for (const list of lists) {
          const names = list.map((k) => k.replace(/\?$/, ''));
          expect(new Set(names).size, `${type}: duplicate key in ${list}`).toBe(names.length);
          expect(names, `${type}: requestId is implied`).not.toContain('requestId');
        }
        // A success shape with `error` would be classified as an error reply.
        if (Array.isArray(spec.replyKeys)) {
          expect(spec.replyKeys.map((k) => k.replace(/\?$/, ''))).not.toContain('error');
        }
        if (Array.isArray(spec.errorKeys)) {
          expect(parseDeclaredKeys(spec.errorKeys).required, type).toContain('error');
        }
      }
    });

    it('checkReplyKeys classifies on a top-level `error` and reports both directions', () => {
      expect(checkReplyKeys('GET_VIEWER', { requestId: 'r', viewer: { id: 1 } })).toEqual({
        outcome: 'success',
        problems: [],
      });
      expect(checkReplyKeys('GET_VIEWER', { requestId: 'r', error: 'boom' })).toEqual({
        outcome: 'error',
        problems: [],
      });
      // The reply `@civitai/sdk`'s raw transport waits for: `{ result }`. The host sends
      // `{ viewer }`.
      expect(checkReplyKeys('GET_VIEWER', { requestId: 'r', result: { id: 1 } })).toEqual({
        outcome: 'success',
        problems: [
          'GET_VIEWER: replyKeys requires `viewer`; the reply lacks it',
          'GET_VIEWER: the reply carries `result`, which replyKeys does not declare',
        ],
      });
      expect(checkReplyKeys('OPEN_CHECKPOINT_PICKER', { requestId: 'r' }).problems).toEqual([]);
      expect(checkReplyKeys('APP_STORAGE_GET', { requestId: 'r', error: 'x' }).problems).toEqual(
        []
      );
      expect(checkReplyKeys('SUBMIT_WORKFLOW', { requestId: 'r', error: 'x' }).problems).toEqual([
        "SUBMIT_WORKFLOW: the reply has a top-level `error`, but errorKeys is 'none'",
      ]);
    });

    it('the forward matrix rows agree with the declared shapes, on each host', () => {
      // The same check as each forward matrix's premise test, run here as well. The matrices are
      // browser tests, and this file runs in the unit tier, so a wrong declaration for a
      // forwarded type fails here too.
      for (const host of ['IframeHost', 'PageBlockHost'] as const) {
        const rows = ROWS.filter((r) => r.hosts.includes(host));
        expect(rows.length, `${host}: positive control, the matrix has rows`).toBeGreaterThan(0);
        expect(replyKeysProblems(rows), host).toEqual([]);
      }
    });

    it("the shared dispatcher's NACK matches every type's declared error shape", () => {
      // The NACK (`buildBridgeNackReply`) is the one error reply every NACKable type can get,
      // whichever host and handler. It must satisfy `errorKeys`. For the workflow family
      // (`errorKeys: 'none'`) it must instead satisfy `replyKeys`.
      let nacked = 0;
      for (const type of requestTypes) {
        const reply = buildBridgeNackReply(type, 'rq_nack', 'boom');
        if (!reply) continue;
        nacked += 1;
        const expected = INVENTORY[type].errorKeys === 'none' ? 'success' : 'error';
        expect(checkReplyKeys(type, reply.payload), type).toEqual({
          outcome: expected,
          problems: [],
        });
      }
      // Three types are NACK-exempt (BRIDGE_NACK_EXEMPT); every other request type is NACKable.
      expect(nacked).toBe(requestTypes.length - 3);
    });

    it('every REQUEST type outside the forward matrix has its replies pinned in a host test', () => {
      // The forward matrix pins the forwarded types (`REPLY_TYPE`) in its premise tests. Every
      // other request type is pinned by `expectReplyKeys(...)` calls on replies a real host
      // sent. Per type, this requires:
      //   - at least one pin from EACH host that must handle it, since each host writes its
      //     own reply;
      //   - the pinned key sets, taken together, to name every declared `replyKeys` key;
      //   - the same for `errorKeys`, and at least one error pin, unless the type is in
      //     NACK_ONLY_ERRORS. Those get no error reply except the dispatcher's NACK, which the
      //     sweep above pins.
      const unforwarded = requestTypes.filter((t) => !forwarded.has(t)).sort();
      expect(unforwarded).toHaveLength(20);
      const pins = pinsFromTestSources();
      expect(pins.length).toBeGreaterThanOrEqual(30);
      expect([...new Set(pins.map((p) => p.type))].sort()).toEqual(unforwarded);

      const names = (list: readonly string[]) => parseDeclaredKeys(list);
      let ownSharedSends = 0;
      for (const type of unforwarded) {
        const spec = INVENTORY[type];
        const mine = pins.filter((p) => p.type === type);
        for (const host of ['IframeHost', 'PageBlockHost'] as const) {
          if (spec[host] !== 'required') continue;
          const fromHost = mine.some(
            (p) => p.host === host || (p.host === 'shared' && type in SHARED_MODULE_PINS)
          );
          expect(fromHost, `${type}: no pin from a ${host} test`).toBe(true);
          if (type in SHARED_MODULE_PINS) {
            // A reply the host writes itself is not the shared module's, so the shared pin does
            // not cover it.
            const own = sendsOf(host, spec.reply);
            expect(
              own.literals.length,
              `${type}: ${host} sends ${spec.reply} a non-literal payload`
            ).toBe(own.count);
            ownSharedSends += own.literals.length;
            for (const call of own.literals) {
              // A spread could carry an `error` this classification cannot see.
              expect(call, `${type}: ${host} spreads into the payload`).not.toContain('...');
              const outcome = /\berror\b/.test(call) ? 'error' : 'success';
              expect(
                mine.some((p) => p.host === host && p.outcome === outcome),
                `${type}: ${host} writes its own ${outcome} ${spec.reply}, and no ${host} test pins one`
              ).toBe(true);
            }
          }
        }
        for (const outcome of ['success', 'error'] as const) {
          const declared = outcome === 'success' ? spec.replyKeys : spec.errorKeys;
          const seen = new Set(mine.filter((p) => p.outcome === outcome).flatMap((p) => p.keys));
          if (!Array.isArray(declared)) {
            expect(
              mine.some((p) => p.outcome === outcome),
              `${type}: ${outcome} pin for a type that declares none`
            ).toBe(false);
            continue;
          }
          if (outcome === 'error' && type in NACK_ONLY_ERRORS) {
            expect(
              mine.some((p) => p.outcome === 'error'),
              `${type} is NACK-only`
            ).toBe(false);
            expect(declared, `${type}: a NACK-only error is a bare { error }`).toEqual(['error']);
            continue;
          }
          const { required, optional } = names(declared);
          expect([...seen].sort(), `${type}: ${outcome} keys the pins cover`).toEqual(
            [...required, ...optional].sort()
          );
        }
      }
      // Positive control for the host-written check above: IframeHost writes the batch
      // no-token reply inline. If no host writes one any more, delete this line.
      expect(ownSharedSends, 'host-written replies of SHARED_MODULE_PINS types').toBeGreaterThan(0);
    });

    it("every send in a host's own source names its reply type with a quoted literal", () => {
      // The source checks around this one find a host's replies by their quoted type. A send
      // whose type is a variable or a constant, such as `send(ESTIMATE_BATCH_REPLY, …)`, would
      // be invisible to them.
      for (const host of ['IframeHost', 'PageBlockHost'] as const) {
        const src = HOST_SRC[`${host}.tsx`];
        const all = src.match(/\bsend\(/g) ?? [];
        const quoted = src.match(/\bsend\(\s*'/g) ?? [];
        expect(all.length, `${host}: positive control, the host sends replies`).toBeGreaterThan(0);
        expect(quoted.length, `${host}: a send( whose reply type is not a quoted literal`).toBe(
          all.length
        );
      }
    });

    it('a NACK_ONLY_ERRORS type has no host-written error reply', () => {
      // The exemption above holds only while neither host sends its own error on the reply.
      // Each `send('<REPLY>', …)` must pass an object literal with no spread, so a payload built
      // elsewhere cannot hide one. A send whose type is not a quoted literal is not seen.
      for (const type of Object.keys(NACK_ONLY_ERRORS) as InventoryType[]) {
        const reply = INVENTORY[type].reply;
        for (const host of ['IframeHost', 'PageBlockHost'] as const) {
          if (INVENTORY[type][host] !== 'required') continue;
          const sends = sendsOf(host, reply);
          expect(sends.count, `${type}: positive control, ${host} sends ${reply}`).toBeGreaterThan(
            0
          );
          expect(
            sends.literals.length,
            `${type}: ${host} sends ${reply} a non-literal payload`
          ).toBe(sends.count);
          for (const call of sends.literals) {
            expect(call, `${type}: ${host} writes an error`).not.toMatch(/\berror\b/);
            expect(call, `${type}: ${host} spreads into the payload`).not.toContain('...');
          }
        }
        expect(buildBridgeNackReply(type, 'r', 'x')).not.toBeNull();
      }
    });

    it('the reply-key fields stay single-line literals that a regex reader recovers exactly', () => {
      // Tooling outside this repo reads `replyKeys` / `errorKeys` out of the source text.
      const src = readFileSync(join(HOST_DIR, 'hostHandlerParity.ts'), 'utf8');
      const entry = /^ {2}([A-Z_]+): \{\n([\s\S]*?)^ {2}\},$/gm;
      const parse = (lit: string) =>
        lit === 'null'
          ? null
          : lit === "'none'"
          ? 'none'
          : [...lit.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      let seen = 0;
      for (const [, type, body] of src.matchAll(entry)) {
        const r = body.match(/^ {4}replyKeys: (null|\[[^\]\n]*\]),$/m);
        const e = body.match(/^ {4}errorKeys: (null|'none'|\[[^\]\n]*\]),$/m);
        expect(r && e, `${type}: replyKeys/errorKeys not on one line each`).toBeTruthy();
        const spec = INVENTORY[type as InventoryType];
        expect(parse(r![1]), type).toEqual(spec.replyKeys);
        expect(parse(e![1]), type).toEqual(spec.errorKeys);
        seen += 1;
      }
      expect(seen).toBe(Object.keys(INVENTORY).length);
    });
  });

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
