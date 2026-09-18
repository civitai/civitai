import { describe, expect, test } from 'vitest';
import { INVENTORY } from '~/components/AppBlocks/hostHandlerParity';
import {
  BRIDGE_HOSTS,
  BRIDGE_MESSAGE_BATCH_MAX,
  BRIDGE_MESSAGE_COUNT_MAX,
  BRIDGE_MESSAGE_OUTCOMES,
  BRIDGE_NACK_EXEMPT,
  BRIDGE_NACK_SNAPSHOT_REPLIES,
  boundBridgeMessageType,
  isBareReplyType,
  nackReplyTypeFor,
} from '~/components/AppBlocks/bridgeTelemetry';
import { blockMessageBatchSchema } from '~/server/schema/track.schema';
import { buildBridgeNackReply } from '~/components/AppBlocks/bridgeNackReply';

/**
 * The BOUNDING + NACK-RESOLUTION rules behind
 * `civitai_app_block_bridge_messages_total` and the unhandled-message reply.
 *
 * 🔴 `boundBridgeMessageType` IS A CARDINALITY BOUND ON A PUBLIC BEACON, not a
 * tidiness helper. The beacon body is client-supplied and its route is
 * unauthenticated, and prom-client retains every distinct label set in the Node
 * heap forever across ~130 scraped pods — so an unbounded `type` is an exit-139
 * OOM vector. The `other` bucket is what makes it safe, and these tests are what
 * make the `other` bucket real.
 */
describe('boundBridgeMessageType (the `type` label bound)', () => {
  test('keeps a type the protocol inventory declares', () => {
    expect(boundBridgeMessageType('GET_VIEWER')).toBe('GET_VIEWER');
    expect(boundBridgeMessageType('SUBMIT_WORKFLOW')).toBe('SUBMIT_WORKFLOW');
  });

  test('buckets an unknown type to `other`', () => {
    expect(boundBridgeMessageType('TOTALLY_MADE_UP')).toBe('other');
    expect(boundBridgeMessageType('')).toBe('other');
  });

  test('buckets a PROTOTYPE key to `other` rather than passing it through', () => {
    // A dispatch table indexed with an untrusted key FAILS OPEN when the lookup
    // is `key in obj` or `obj[key]`: `'toString'`, `'constructor'` and
    // `'__proto__'` are all truthy on a plain object literal, so a naive bound
    // would let those three through as prom labels — and `INVENTORY` is a plain
    // object literal. `hasOwnProperty.call` is what closes it.
    for (const key of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(boundBridgeMessageType(key)).toBe('other');
    }
  });

  test('every declared protocol type survives the bound (the positive control)', () => {
    // A bound that returned 'other' for EVERYTHING would pass every negative
    // assertion above. This is the arm that proves it can ever say yes.
    const kept = Object.keys(INVENTORY).filter((t) => boundBridgeMessageType(t) === t);
    expect(kept).toHaveLength(Object.keys(INVENTORY).length);
    expect(kept.length).toBeGreaterThan(40);
  });
});

describe('the label enums are closed', () => {
  test('outcomes are exactly the five the dispatcher can produce', () => {
    expect([...BRIDGE_MESSAGE_OUTCOMES]).toEqual([
      'handled',
      'no_handler',
      'rate_limited',
      'deduped',
      'no_token',
    ]);
  });

  test("hosts are the parity inventory's own host keys, so a series joins to it", () => {
    // The `host` label exists to be read against INVENTORY[type][host]. If these
    // drift apart, a `no_handler` series can no longer be told apart from a
    // DECLARED N/A, which is the single most important read on this counter.
    for (const host of BRIDGE_HOSTS) {
      expect(INVENTORY.GET_VIEWER).toHaveProperty(host);
    }
  });
});

describe('nackReplyTypeFor', () => {
  test('resolves a REQUEST-style type to its declared reply', () => {
    expect(nackReplyTypeFor('GET_VIEWER')).toBe('VIEWER_RESULT');
    expect(nackReplyTypeFor('GET_IMAGES_BY_IDS')).toBe('IMAGES_RESULT');
    expect(nackReplyTypeFor('SUBMIT_WORKFLOW')).toBe('WORKFLOW_SUBMITTED');
  });

  test('refuses a FIRE-AND-FORGET type — nothing is awaiting, so a reply is junk', () => {
    // A NACK for these would arrive at the SDK as an unsolicited push with no
    // registered listener: pure noise, and it would make the wire harder to read
    // while fixing nothing.
    expect(nackReplyTypeFor('BLOCK_READY')).toBeNull();
    expect(nackReplyTypeFor('TRACK_EVENT')).toBeNull();
    expect(nackReplyTypeFor('NAVIGATE')).toBeNull();
  });

  test('refuses an unknown type and a prototype key', () => {
    expect(nackReplyTypeFor('TOTALLY_MADE_UP')).toBeNull();
    expect(nackReplyTypeFor('toString')).toBeNull();
    expect(nackReplyTypeFor('__proto__')).toBeNull();
  });

  test('REQUEST_TOKEN — whose reply is PROSE — is refused', () => {
    // `MessageSpec.reply` is documentation; its own docstring says nothing
    // enforces it, and exactly one entry spells a sentence. Dispatching that
    // string verbatim would put a message on the wire whose `type` matches
    // nothing, i.e. today's silence with extra steps.
    //
    // 🔴 THIS TEST DOES NOT EXERCISE `isBareReplyType`, AND SAYING SO IS THE
    // POINT. `REQUEST_TOKEN` is caught two lines earlier by `BRIDGE_NACK_EXEMPT`,
    // so deleting the `isBareReplyType` call from `nackReplyTypeFor` leaves this
    // assertion GREEN — an earlier check always wins, and the mutant would die for
    // the wrong reason. The predicate is therefore tested on its own below.
    expect(INVENTORY.REQUEST_TOKEN.reply).toMatch(/\s/);
    expect(nackReplyTypeFor('REQUEST_TOKEN')).toBeNull();
  });

  test('refuses every explicitly exempt type', () => {
    for (const type of Object.keys(BRIDGE_NACK_EXEMPT)) {
      expect(nackReplyTypeFor(type)).toBeNull();
    }
  });
});

describe('isBareReplyType — tested directly, because no caller can reach it today', () => {
  test('accepts a bare message type and rejects prose or an empty reply', () => {
    expect(isBareReplyType('VIEWER_RESULT')).toBe(true);
    expect(isBareReplyType('APP_STORAGE_GET_RESULT')).toBe(true);
    expect(isBareReplyType('')).toBe(false);
    expect(isBareReplyType('lowercase_result')).toBe(false);
    expect(
      isBareReplyType('TOKEN_REFRESH_RESPONSE (or a TOKEN_REFRESH push when no requestId was sent)')
    ).toBe(false);
  });

  test('the inventory has exactly ONE prose reply today, and it is already exempt', () => {
    // The reachability claim, measured rather than asserted in prose. If a SECOND
    // prose entry ever appears that is not exempt, the predicate stops being
    // defence-in-depth and starts being load-bearing — and this test is what says
    // so, by failing.
    const proseRequestTypes = Object.entries(INVENTORY)
      .filter(([, spec]) => spec.request && !isBareReplyType(spec.reply))
      .map(([type]) => type);
    expect(proseRequestTypes).toEqual(['REQUEST_TOKEN']);
    for (const type of proseRequestTypes) {
      expect(Object.keys(BRIDGE_NACK_EXEMPT)).toContain(type);
    }
  });
});

describe('the wire schema is built FROM these constants, not re-spelled', () => {
  // 🔴 A zod array rejects WHOLESALE. An outcome added to the emitter but not to
  // the schema would 400 every batch carrying it and take every good row with it,
  // silently — the client never retries. So the relationship is pinned in BOTH
  // directions rather than trusted to two edits landing together.
  const eventShape = blockMessageBatchSchema.shape.events.element.shape;

  test('the outcome enum equals BRIDGE_MESSAGE_OUTCOMES', () => {
    expect([...eventShape.outcome.options]).toEqual([...BRIDGE_MESSAGE_OUTCOMES]);
  });

  test('the host enum equals BRIDGE_HOSTS', () => {
    expect([...eventShape.host.options]).toEqual([...BRIDGE_HOSTS]);
  });

  test('a batch at the client cap is accepted and one row past it is not', () => {
    const row = {
      appBlockId: 'apb',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'handled',
      count: 1,
    };
    const at = Array.from({ length: BRIDGE_MESSAGE_BATCH_MAX }, () => row);
    expect(blockMessageBatchSchema.safeParse({ events: at }).success).toBe(true);
    expect(blockMessageBatchSchema.safeParse({ events: [...at, row] }).success).toBe(false);
  });

  test('a count at the client clamp is accepted and one past it is not', () => {
    const row = (count: number) => ({
      appBlockId: 'apb',
      type: 'GET_VIEWER',
      host: 'IframeHost',
      outcome: 'handled',
      count,
    });
    expect(
      blockMessageBatchSchema.safeParse({ events: [row(BRIDGE_MESSAGE_COUNT_MAX)] }).success
    ).toBe(true);
    expect(
      blockMessageBatchSchema.safeParse({ events: [row(BRIDGE_MESSAGE_COUNT_MAX + 1)] }).success
    ).toBe(false);
  });
});

describe('the exemption ledger cannot outlive what it exempts', () => {
  test('every exempt key is a real REQUEST-style inventory entry with a reason', () => {
    for (const [type, reason] of Object.entries(BRIDGE_NACK_EXEMPT)) {
      expect(Object.keys(INVENTORY)).toContain(type);
      expect((INVENTORY as Record<string, { request: boolean }>)[type].request).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  test('the ledger is exactly the two types whose failure reply the SDK would DROP', () => {
    // Pinned as a SET, failing in both directions. A shrink means someone removed
    // an exemption without the SDK change that makes the NACK land; a growth means
    // a new dead end was accepted, and that should be a deliberate, reviewed act
    // rather than something that happens by editing a map.
    expect(Object.keys(BRIDGE_NACK_EXEMPT).sort()).toEqual(['GET_WILDCARD_PACK', 'REQUEST_TOKEN']);
  });
});

describe('buildBridgeNackReply', () => {
  test('a workflow reply carries a failureSnapshot, NOT a bare error', () => {
    // `isValidWorkflowReply` checks `isValidWorkflowSnapshot(p.snapshot)` and has
    // NO early-accept on `error`, so a bare `{requestId, error}` is dropped at the
    // block's trust boundary and the block hangs to its 120s workflow timeout —
    // the exact failure `failureSnapshot.ts`'s own header records. A NACK that is
    // dropped is indistinguishable from no NACK at all.
    const reply = buildBridgeNackReply('SUBMIT_WORKFLOW', 'rq_1', 'nope');
    expect(reply).not.toBeNull();
    expect(reply!.type).toBe('WORKFLOW_SUBMITTED');
    expect(reply!.payload.requestId).toBe('rq_1');
    expect(reply!.payload.snapshot).toEqual({
      workflowId: 'failed',
      status: 'failed',
      error: 'nope',
    });
    // 🔴 A non-empty workflowId is load-bearing: the SDK validator drops a
    // snapshot whose workflowId is ''.
    expect((reply!.payload.snapshot as { workflowId: string }).workflowId).not.toBe('');
  });

  test('every snapshot-shaped reply routes through the snapshot branch', () => {
    const byReply = new Map<string, string>();
    for (const [type, spec] of Object.entries(INVENTORY)) {
      const r = nackReplyTypeFor(type);
      if (r && BRIDGE_NACK_SNAPSHOT_REPLIES.has(r)) byReply.set(r, type);
      void spec;
    }
    expect([...byReply.keys()].sort()).toEqual([...BRIDGE_NACK_SNAPSHOT_REPLIES].sort());
    for (const type of byReply.values()) {
      const reply = buildBridgeNackReply(type, 'rq', 'boom');
      expect(reply!.payload).toHaveProperty('snapshot');
      expect(reply!.payload).not.toHaveProperty('error');
    }
  });

  test('every other REQUEST-style reply carries a bare `{requestId, error}`', () => {
    const reply = buildBridgeNackReply('GET_VIEWER', 'rq_2', 'unsupported on this host');
    expect(reply).toEqual({
      type: 'VIEWER_RESULT',
      payload: { requestId: 'rq_2', error: 'unsupported on this host' },
    });
  });

  test('returns null — never a malformed message — for anything unresolvable', () => {
    expect(buildBridgeNackReply('BLOCK_READY', 'rq', 'x')).toBeNull();
    expect(buildBridgeNackReply('TOTALLY_MADE_UP', 'rq', 'x')).toBeNull();
    expect(buildBridgeNackReply('GET_WILDCARD_PACK', 'rq', 'x')).toBeNull();
  });
});
