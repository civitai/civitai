import { useEffect, useRef, useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { usePostMessage } from '~/components/AppBlocks/usePostMessage';
import type { BridgeMessageOutcome } from '~/components/AppBlocks/bridgeTelemetry';

/**
 * The BRIDGE OUTCOME COUNTER, driven through the real dispatcher.
 *
 * 🔴 THIS FILE IS THE NEGATIVE CONTROL THE WHOLE CARD RESTS ON. A counter nobody
 * has watched go non-zero ON A DELIBERATE FAULT is a claim about the code, not a
 * measurement — a `no_handler` series flat at zero is indistinguishable from a
 * probe wired to nothing. So the control here is not "assert `no_handler` for a
 * type that was never registered": it is REGISTER a handler, prove `handled`,
 * then UNREGISTER it and prove the SAME message now reports `no_handler`. One
 * variable moves, both arms are read, and the before/after pair is the evidence.
 *
 * The four DISPATCHER outcomes are all exercised against the real hook. The fifth,
 * `no_token`, is a HANDLER-side report and is pinned on the hosts themselves, in
 * `PageBlockHostNoTokenNack.browser.test.tsx` — which asserts BOTH the reply the
 * handler sends and the row that reaches the real beacon buffer, because those
 * are produced by different lines and a test of one says nothing about the other.
 */

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

type Recorded = { type: string; outcome: BridgeMessageOutcome; appBlockId: string; host: string };

function Harness({
  onOutcome,
  registered: initiallyRegistered,
}: {
  onOutcome: (e: Recorded) => void;
  registered: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [handledPayloads, setHandledPayloads] = useState(0);
  // 🔴 REGISTRATION IS TOGGLED IN-PLACE, NOT BY RE-RENDERING THE HARNESS. A
  // `rerender()` remounts the iframe, so `event.source === contentWindow` stops
  // matching and every subsequent message is dropped by the AUTHENTICATING PIN
  // rather than by the branch under test — the control arm would then read zero
  // for a reason that has nothing to do with handler registration, and it would
  // look exactly like a working assertion. Measured: that spelling reported
  // `no_handler: 0` with no error.
  const [registered, setRegistered] = useState(initiallyRegistered);
  const { onMessage } = usePostMessage({
    iframeRef,
    expectedOrigin: window.location.origin,
    host: 'IframeHost',
    appBlockId: 'apb_test',
    onOutcome,
  });

  useEffect(() => {
    if (!registered) return;
    return onMessage('GET_VIEWER', () => setHandledPayloads((n) => n + 1));
  }, [onMessage, registered]);

  return (
    <div>
      <iframe ref={iframeRef} data-testid="harness-iframe" src={SAME_ORIGIN_SRC} title="harness" />
      <span data-testid="handled-count">{handledPayloads}</span>
      <button data-testid="unregister" onClick={() => setRegistered(false)}>
        unregister
      </button>
    </div>
  );
}

function iframeEl() {
  return page.getByTestId('harness-iframe').element() as HTMLIFrameElement;
}

/** Deliver a block→host message that satisfies BOTH authenticating pins. */
function postFromBlock(type: string, payload?: unknown) {
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: cw,
    })
  );
}

function listenOnBlock() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    of: (type: string) => received.filter((m) => m.type === type),
    all: () => [...received],
    stop: () => cw.removeEventListener('message', handler),
  };
}

async function mount(props: { onOutcome: (e: Recorded) => void; registered: boolean }) {
  const utils = renderWithProviders(<Harness {...props} />);
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  return utils;
}

function countOf(rec: Recorded[], outcome: BridgeMessageOutcome, type = 'GET_VIEWER') {
  return rec.filter((r) => r.outcome === outcome && r.type === type).length;
}

describe('usePostMessage bridge outcome counter', () => {
  test('NEGATIVE CONTROL: unregistering the handler flips the SAME message from handled to no_handler', async () => {
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: true });

    // ── ARM 1: handler REGISTERED ────────────────────────────────────────────
    postFromBlock('GET_VIEWER', { requestId: 'rq_a' });
    await vi.waitFor(() => {
      if (countOf(recorded, 'handled') !== 1) throw new Error('no handled yet');
    });
    const before = {
      handled: countOf(recorded, 'handled'),
      no_handler: countOf(recorded, 'no_handler'),
    };
    expect(before).toEqual({ handled: 1, no_handler: 0 });

    // ── THE DELIBERATE FAULT: unregister the handler, iframe untouched ───────
    await page.getByTestId('unregister').click();

    // ── ARM 2: same message, same harness, handler gone ──────────────────────
    postFromBlock('GET_VIEWER', { requestId: 'rq_b' });
    await vi.waitFor(() => {
      if (countOf(recorded, 'no_handler') !== 1) throw new Error('no no_handler yet');
    });
    const after = {
      handled: countOf(recorded, 'handled'),
      no_handler: countOf(recorded, 'no_handler'),
    };
    expect(after).toEqual({ handled: 1, no_handler: 1 });

    // The counter MOVED on the fault and did not move on the control arm — the
    // pair, not either number alone, is what rules out a probe wired to nothing.
    expect(after.no_handler - before.no_handler).toBe(1);
    expect(after.handled - before.handled).toBe(0);
  });

  test('every outcome carries the app and host labels the beacon needs', async () => {
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: true });
    postFromBlock('GET_VIEWER', { requestId: 'rq_labels' });
    await vi.waitFor(() => {
      if (recorded.length === 0) throw new Error('nothing recorded');
    });
    expect(recorded[0]).toMatchObject({
      appBlockId: 'apb_test',
      host: 'IframeHost',
      type: 'GET_VIEWER',
      outcome: 'handled',
    });
  });

  test('a repeat requestId inside the dedup window reports `deduped`', async () => {
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: true });
    postFromBlock('GET_VIEWER', { requestId: 'rq_same' });
    postFromBlock('GET_VIEWER', { requestId: 'rq_same' });
    await vi.waitFor(() => {
      if (countOf(recorded, 'deduped') !== 1) throw new Error('no deduped yet');
    });
    expect(countOf(recorded, 'handled')).toBe(1);
    expect(countOf(recorded, 'deduped')).toBe(1);
  });

  test('exceeding the 30/sec inbound budget reports `rate_limited`', async () => {
    const recorded: Recorded[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mount({ onOutcome: (e) => recorded.push(e), registered: true });
    // 31 messages with NO requestId, so the dedup path cannot absorb any of them:
    // the 31st must be the one the limiter drops.
    for (let i = 0; i < 31; i++) postFromBlock('GET_VIEWER', {});
    await vi.waitFor(() => {
      if (countOf(recorded, 'rate_limited') !== 1) throw new Error('no rate_limited yet');
    });
    expect(countOf(recorded, 'handled')).toBe(30);
    expect(countOf(recorded, 'rate_limited')).toBe(1);
    warn.mockRestore();
  });

  test('an unhandled REQUEST-style message gets an error reply, not silence', async () => {
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: false });
    const replies = listenOnBlock();
    postFromBlock('GET_VIEWER', { requestId: 'rq_nack' });
    await vi.waitFor(() => {
      if (replies.of('VIEWER_RESULT').length === 0) throw new Error('no NACK yet');
    });
    expect(replies.of('VIEWER_RESULT')[0].payload).toEqual({
      requestId: 'rq_nack',
      error: 'unsupported on this host',
    });
    replies.stop();
  });

  test('an unhandled FIRE-AND-FORGET message is counted but NOT answered', async () => {
    // Nothing awaits a reply to these, so a NACK would be an unsolicited push
    // with no listener — noise on the wire that fixes nothing. The counter is the
    // whole remedy for this class.
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: false });
    const replies = listenOnBlock();
    postFromBlock('TRACK_EVENT', { requestId: 'rq_ff' });
    await vi.waitFor(() => {
      if (countOf(recorded, 'no_handler', 'TRACK_EVENT') !== 1) throw new Error('not counted yet');
    });
    // Give any stray reply a chance to land before asserting its absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(replies.all()).toEqual([]);
    replies.stop();
  });

  test('a NACK flood is bounded — the counter keeps counting, the wire does not', async () => {
    // The unhandled branch sits BEFORE the inbound rate limiter on purpose, so
    // answering it needs its own budget or the branch is a postMessage amplifier.
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: false });
    const replies = listenOnBlock();
    for (let i = 0; i < 45; i++) postFromBlock('GET_VIEWER', { requestId: `rq_flood_${i}` });
    await vi.waitFor(() => {
      if (countOf(recorded, 'no_handler') !== 45) throw new Error('not all counted yet');
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(replies.of('VIEWER_RESULT')).toHaveLength(30);
    replies.stop();
  });

  // ── The FIFTH silence: the block refused OUR reply ─────────────────────────
  // Not a dispatcher outcome we can observe — the SDK's validator runs in the
  // iframe AFTER we replied, so we already counted that exchange `handled`. The
  // block reports it over `BLOCK_MESSAGE_REJECTED` and the dispatcher translates.

  test('BLOCK_MESSAGE_REJECTED reports validator_rejected against the HANGING REQUEST, exactly once', async () => {
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: true });

    postFromBlock('BLOCK_MESSAGE_REJECTED', { type: 'GET_IMAGES_BY_IDS' });
    await vi.waitFor(() => {
      if (countOf(recorded, 'validator_rejected', 'GET_IMAGES_BY_IDS') !== 1) {
        throw new Error('not counted yet');
      }
    });

    // 🔴 EXACTLY ONE ROW, AND NOT `handled`. The report is consumed by the
    // dispatcher above the subscriber lookup, so it must not also land in the
    // `handled` denominator — one rejection moving two series by one would make
    // every ratio read against `handled` quietly wrong.
    expect(recorded).toEqual([
      {
        appBlockId: 'apb_test',
        host: 'IframeHost',
        type: 'GET_IMAGES_BY_IDS',
        outcome: 'validator_rejected',
      },
    ]);
  });

  test('NEGATIVE CONTROL: a healthy exchange reports no validator_rejected at all', async () => {
    // The arm that makes the test above a measurement rather than a claim: the
    // same harness, a normal handled message, and the new series stays at zero.
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: true });
    postFromBlock('GET_VIEWER', { requestId: 'rq_healthy' });
    await vi.waitFor(() => {
      if (countOf(recorded, 'handled') !== 1) throw new Error('no handled yet');
    });
    expect(recorded.filter((r) => r.outcome === 'validator_rejected')).toEqual([]);
  });

  test.each([
    ['a type the protocol does not declare', { type: 'NOT_A_REAL_MESSAGE' }],
    ['a non-string type', { type: 42 }],
    ['no type at all', {}],
    ['no payload at all', undefined],
  ])('clamps %s to `other` rather than minting a series', async (_label, payload) => {
    // The payload is BLOCK-supplied and the value becomes a prom label on a host
    // that retains every distinct label set in heap forever, so the clamp is the
    // security property of this branch, not tidiness. `report` ->
    // `recordBridgeMessage` -> `boundBridgeMessageType` does the clamping; this
    // pins that the branch actually routes through it.
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: true });
    postFromBlock('BLOCK_MESSAGE_REJECTED', payload);
    await vi.waitFor(() => {
      if (recorded.length === 0) throw new Error('nothing recorded');
    });
    expect(recorded).toEqual([
      { appBlockId: 'apb_test', host: 'IframeHost', type: 'other', outcome: 'validator_rejected' },
    ]);
  });

  test('a rejection flood is counted in full and never answered', async () => {
    // The branch sits ABOVE the inbound limiter and the dedup map, for the same
    // reason `no_handler` does: a flood of junk must not burn the 30 msg/sec budget
    // legitimate BLOCK_ERROR reporting needs. So all 45 are counted (the SDK side
    // is where the emit budget lives), none are deduped — they carry no requestId,
    // and two rejections of one type are two facts — and nothing goes back on the
    // wire, because there is nothing to answer.
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: true });
    const replies = listenOnBlock();
    for (let i = 0; i < 45; i++) postFromBlock('BLOCK_MESSAGE_REJECTED', { type: 'GET_VIEWER' });
    await vi.waitFor(() => {
      if (countOf(recorded, 'validator_rejected') !== 45) throw new Error('not all counted yet');
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(countOf(recorded, 'rate_limited')).toBe(0);
    expect(countOf(recorded, 'deduped')).toBe(0);
    expect(replies.all()).toEqual([]);
    replies.stop();
  });

  test('a throwing outcome sink cannot break the bridge it observes', async () => {
    // Telemetry that can abort dispatch would re-create the exact silent drop it
    // was added to remove — and it would do it on the busiest path.
    let handled = 0;
    const iframeRef = { current: null } as { current: HTMLIFrameElement | null };
    void iframeRef;
    await mount({
      onOutcome: () => {
        throw new Error('sink exploded');
      },
      registered: true,
    });
    postFromBlock('GET_VIEWER', { requestId: 'rq_throw' });
    await vi.waitFor(() => {
      handled = Number(page.getByTestId('handled-count').element().textContent);
      if (handled !== 1) throw new Error('handler did not run');
    });
    expect(handled).toBe(1);
  });
});
