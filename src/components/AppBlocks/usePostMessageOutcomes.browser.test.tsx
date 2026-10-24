import { useEffect, useRef, useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { usePostMessage } from '~/components/AppBlocks/usePostMessage';
import type { BridgeHost, BridgeMessageOutcome } from '~/components/AppBlocks/bridgeTelemetry';

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
 * 🔴 WHICH HOST A `no_handler` TEST MOUNTS IS PART OF ITS PREMISE. An unhandled
 * type the parity INVENTORY declares N/A for the harness's host reports
 * `not_applicable`, not `no_handler` — `GET_VIEWER` is N/A on `IframeHost` and
 * `'required'` on `PageBlockHost`. So every `no_handler` arm below mounts the host
 * on which its type is required, and the split itself is pinned in its own block.
 *
 * SIX of the seven outcomes are dispatcher-side and are all exercised against the
 * real hook here — including `validator_rejected`, which the dispatcher produces
 * from the block's own `BLOCK_MESSAGE_REJECTED` report rather than observing.
 * `no_token` is the one HANDLER-side report and is pinned on the hosts themselves,
 * in `PageBlockHostNoTokenNack.browser.test.tsx` — which asserts BOTH the reply the
 * handler sends and the row that reaches the real beacon buffer, because those
 * are produced by different lines and a test of one says nothing about the other.
 */

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

type Recorded = { type: string; outcome: BridgeMessageOutcome; appBlockId: string; host: string };

function Harness({
  onOutcome,
  registered: initiallyRegistered,
  host,
  trackEvents = false,
}: {
  onOutcome: (e: Recorded) => void;
  registered: boolean;
  host: BridgeHost;
  trackEvents?: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [handledPayloads, setHandledPayloads] = useState(0);
  const [trackedPayloads, setTrackedPayloads] = useState(0);
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
    host,
    appBlockId: 'apb_test',
    onOutcome,
  });

  useEffect(() => {
    if (!registered) return;
    return onMessage('GET_VIEWER', () => setHandledPayloads((n) => n + 1));
  }, [onMessage, registered]);

  useEffect(() => {
    if (!trackEvents) return;
    return onMessage('TRACK_EVENT', () => setTrackedPayloads((n) => n + 1));
  }, [onMessage, trackEvents]);

  return (
    <div>
      <iframe ref={iframeRef} data-testid="harness-iframe" src={SAME_ORIGIN_SRC} title="harness" />
      <span data-testid="handled-count">{handledPayloads}</span>
      <span data-testid="tracked-count">{trackedPayloads}</span>
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

async function mount(props: {
  onOutcome: (e: Recorded) => void;
  registered: boolean;
  host: BridgeHost;
  trackEvents?: boolean;
}) {
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
    // PageBlockHost: GET_VIEWER is `'required'` there, so unhandled is a real gap.
    await mount({ onOutcome: (e) => recorded.push(e), registered: true, host: 'PageBlockHost' });

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
    await mount({ onOutcome: (e) => recorded.push(e), registered: true, host: 'IframeHost' });
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
    await mount({ onOutcome: (e) => recorded.push(e), registered: true, host: 'IframeHost' });
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
    await mount({ onOutcome: (e) => recorded.push(e), registered: true, host: 'IframeHost' });
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
    // PageBlockHost: GET_VIEWER is `'required'` there, so this is the no_handler
    // NACK; the declared-N/A NACK is pinned separately below.
    await mount({ onOutcome: (e) => recorded.push(e), registered: false, host: 'PageBlockHost' });
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
    // NAVIGATE on PageBlockHost: fire-and-forget AND `'required'` there, so this
    // is the no_handler arm of the class.
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: false, host: 'PageBlockHost' });
    const replies = listenOnBlock();
    postFromBlock('NAVIGATE', { requestId: 'rq_ff' });
    await vi.waitFor(() => {
      if (countOf(recorded, 'no_handler', 'NAVIGATE') !== 1) throw new Error('not counted yet');
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
    await mount({ onOutcome: (e) => recorded.push(e), registered: false, host: 'PageBlockHost' });
    const replies = listenOnBlock();
    for (let i = 0; i < 45; i++) postFromBlock('GET_VIEWER', { requestId: `rq_flood_${i}` });
    await vi.waitFor(() => {
      if (countOf(recorded, 'no_handler') !== 45) throw new Error('not all counted yet');
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(replies.of('VIEWER_RESULT')).toHaveLength(30);
    replies.stop();
  });

  // ── Declared N/A vs a missing handler ──────────────────────────────────────
  // An unhandled type the parity INVENTORY marks N/A for the CURRENT host reports
  // `not_applicable`; one marked `'required'` there, or not in the INVENTORY,
  // reports `no_handler`. Only the label differs — the wire reply does not.

  test('RESIZE_IFRAME unhandled on PageBlockHost (declared N/A) reports not_applicable, once, unanswered', async () => {
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: false, host: 'PageBlockHost' });
    const replies = listenOnBlock();
    postFromBlock('RESIZE_IFRAME', { height: 480 });
    await vi.waitFor(() => {
      if (recorded.length === 0) throw new Error('nothing recorded');
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(recorded).toEqual([
      {
        appBlockId: 'apb_test',
        host: 'PageBlockHost',
        type: 'RESIZE_IFRAME',
        outcome: 'not_applicable',
      },
    ]);
    expect(replies.all()).toEqual([]);
    replies.stop();
  });

  test('the SAME RESIZE_IFRAME unhandled on IframeHost (required there) is still no_handler', async () => {
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: false, host: 'IframeHost' });
    postFromBlock('RESIZE_IFRAME', { height: 480 });
    await vi.waitFor(() => {
      if (recorded.length === 0) throw new Error('nothing recorded');
    });
    expect(recorded).toEqual([
      { appBlockId: 'apb_test', host: 'IframeHost', type: 'RESIZE_IFRAME', outcome: 'no_handler' },
    ]);
  });

  test('a REQUIRED request type unhandled on PageBlockHost is no_handler', async () => {
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: false, host: 'PageBlockHost' });
    postFromBlock('GET_VIEWER', { requestId: 'rq_required' });
    await vi.waitFor(() => {
      if (recorded.length === 0) throw new Error('nothing recorded');
    });
    expect(recorded).toEqual([
      { appBlockId: 'apb_test', host: 'PageBlockHost', type: 'GET_VIEWER', outcome: 'no_handler' },
    ]);
  });

  test.each(['IframeHost', 'PageBlockHost'] as const)(
    'a type the INVENTORY does not declare is no_handler on %s',
    async (host) => {
      const recorded: Recorded[] = [];
      await mount({ onOutcome: (e) => recorded.push(e), registered: false, host });
      postFromBlock('NOT_A_REAL_MESSAGE', { requestId: 'rq_unknown' });
      await vi.waitFor(() => {
        if (recorded.length === 0) throw new Error('nothing recorded');
      });
      expect(recorded).toEqual([
        { appBlockId: 'apb_test', host, type: 'NOT_A_REAL_MESSAGE', outcome: 'no_handler' },
      ]);
    }
  );

  test('a declared-N/A REQUEST type is still NACKed — only the label changes', async () => {
    // GET_VIEWER is N/A on the model slot. The block is awaiting VIEWER_RESULT, so
    // the error reply must still go out: relabelling must not reintroduce a hang.
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: false, host: 'IframeHost' });
    const replies = listenOnBlock();
    postFromBlock('GET_VIEWER', { requestId: 'rq_na_nack' });
    await vi.waitFor(() => {
      if (replies.of('VIEWER_RESULT').length === 0) throw new Error('no NACK yet');
    });
    expect(replies.of('VIEWER_RESULT')[0].payload).toEqual({
      requestId: 'rq_na_nack',
      error: 'unsupported on this host',
    });
    expect(recorded).toEqual([
      { appBlockId: 'apb_test', host: 'IframeHost', type: 'GET_VIEWER', outcome: 'not_applicable' },
    ]);
    replies.stop();
  });

  // ── The FIFTH silence: the block refused OUR reply ─────────────────────────
  // Not a dispatcher outcome we can observe — the SDK's validator runs in the
  // iframe AFTER we replied, so we already counted that exchange `handled`. The
  // block reports it over `BLOCK_MESSAGE_REJECTED` and the dispatcher translates.

  test('BLOCK_MESSAGE_REJECTED reports validator_rejected against the HANGING REQUEST, exactly once', async () => {
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: true, host: 'IframeHost' });

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
    await mount({ onOutcome: (e) => recorded.push(e), registered: true, host: 'IframeHost' });
    postFromBlock('GET_VIEWER', { requestId: 'rq_healthy' });
    await vi.waitFor(() => {
      if (countOf(recorded, 'handled') !== 1) throw new Error('no handled yet');
    });
    expect(recorded.filter((r) => r.outcome === 'validator_rejected')).toEqual([]);
  });

  test.each([
    ['a type the protocol does not declare', { type: 'NOT_A_REAL_MESSAGE' }],
    // `{ type: 42 }` and `{}` reach the SAME branch (the `typeof !== 'string'` arm),
    // so only one of them is kept — each row costs a full renderWithProviders +
    // iframe mount in chromium. `undefined` is distinct: it exercises the `?.`, and
    // without it that dereference throws.
    ['a non-string type', { type: 42 }],
    ['no payload at all', undefined],
  ])('clamps %s to `other` rather than minting a series', async (_label, payload) => {
    // The payload is BLOCK-supplied and the value becomes a prom label on a host
    // that retains every distinct label set in heap forever, so the clamp is the
    // security property of this branch, not tidiness.
    //
    // 🔴 THE CLAMP UNDER TEST IS THE ONE IN THE BRANCH, NOT THE SINK'S. These tests
    // supply their own `onOutcome`, so `recordBridgeMessage` — and the
    // `boundBridgeMessageType` call inside it — never runs. An earlier revision of
    // this comment said the clamping happened downstream in the sink, which would
    // tell a reader the branch's own `boundBridgeMessageType(...)` is dead code and
    // safe to delete; deleting it reddens every row in the table above, and the failure would
    // then read as "the test is wrong". The branch clamps itself, on purpose,
    // because `onOutcome` is a seam and a value pulled from an untrusted payload
    // must not be bounded only by the default sink.
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: true, host: 'IframeHost' });
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
    // has no emit budget either, so this is the real magnitude), none are deduped
    // — they carry no requestId,
    // and two rejections of one type are two facts — and nothing goes back on the
    // wire, because there is nothing to answer.
    const recorded: Recorded[] = [];
    await mount({ onOutcome: (e) => recorded.push(e), registered: true, host: 'IframeHost' });
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
      host: 'IframeHost',
    });
    postFromBlock('GET_VIEWER', { requestId: 'rq_throw' });
    await vi.waitFor(() => {
      handled = Number(page.getByTestId('handled-count').element().textContent);
      if (handled !== 1) throw new Error('handler did not run');
    });
    expect(handled).toBe(1);
  });
});

describe('TRACK_EVENT does not draw from the shared inbound budget', () => {
  // The probe: 30 events, then a request. Without a TRACK_EVENT handler the events take the
  // unhandled branch (ahead of the limiter) and the request is handled; this arm pins that premise.
  test.each([
    ['without a TRACK_EVENT handler (control)', false],
    ['with a TRACK_EVENT handler', true],
  ] as const)('a request after 30 events is handled, %s', async (_label, trackEvents) => {
    const recorded: Recorded[] = [];
    await mount({
      onOutcome: (e) => recorded.push(e),
      registered: true,
      host: 'PageBlockHost',
      trackEvents,
    });
    for (let i = 0; i < 30; i++) postFromBlock('TRACK_EVENT', { eventName: `e${i}` });
    postFromBlock('GET_VIEWER', { requestId: 'rq_after_events' });
    await vi.waitFor(() => {
      if (recorded.filter((r) => r.type === 'GET_VIEWER').length !== 1) {
        throw new Error('request not counted yet');
      }
    });
    expect(countOf(recorded, 'handled')).toBe(1);
    expect(countOf(recorded, 'rate_limited')).toBe(0);
    expect(countOf(recorded, trackEvents ? 'handled' : 'no_handler', 'TRACK_EVENT')).toBe(30);
    if (trackEvents)
      await expect.element(page.getByTestId('tracked-count')).toHaveTextContent('30');
  });

  test('a TRACK_EVENT flood leaves the full request budget, and requests are still limited', async () => {
    const recorded: Recorded[] = [];
    await mount({
      onOutcome: (e) => recorded.push(e),
      registered: true,
      host: 'PageBlockHost',
      trackEvents: true,
    });
    for (let i = 0; i < 100; i++) postFromBlock('TRACK_EVENT', { eventName: 'flood' });
    for (let i = 0; i < 31; i++) postFromBlock('GET_VIEWER', { requestId: `rq_budget_${i}` });
    await vi.waitFor(() => {
      if (recorded.filter((r) => r.type === 'GET_VIEWER').length !== 31) {
        throw new Error('requests not all counted yet');
      }
    });
    expect(countOf(recorded, 'handled', 'TRACK_EVENT')).toBe(100);
    expect(countOf(recorded, 'handled')).toBe(30);
    expect(countOf(recorded, 'rate_limited')).toBe(1);
  });
});
