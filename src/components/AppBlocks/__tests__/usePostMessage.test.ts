import { describe, expect, it } from 'vitest';
import {
  extractRequestId,
  isInboundOriginAccepted,
  resolveOutboundTargetOrigin,
} from '../usePostMessage';

/**
 * L-DEDUP coverage. The replay-dedup key (`requestId`) is carried inside the
 * message `payload` by the SDK transport — every host handler reads it off
 * `data.payload`. The dedup logic previously read the top-level
 * `data.requestId`, which is always undefined, so the dedup never fired.
 * extractRequestId now reads it from the correct location.
 */
describe('extractRequestId', () => {
  it('reads requestId from payload (where the SDK actually puts it)', () => {
    expect(extractRequestId({ payload: { requestId: 'req-1' } })).toBe('req-1');
  });

  it('returns undefined when no requestId is present anywhere (regression: was always the case before the fix)', () => {
    expect(extractRequestId({ payload: { foo: 'bar' } })).toBeUndefined();
    expect(extractRequestId({})).toBeUndefined();
    expect(extractRequestId({ payload: undefined })).toBeUndefined();
  });

  it('falls back to a top-level requestId for forward compatibility', () => {
    expect(extractRequestId({ requestId: 'top-1' })).toBe('top-1');
  });

  it('prefers the payload requestId over a top-level one', () => {
    expect(extractRequestId({ requestId: 'top', payload: { requestId: 'inner' } })).toBe('inner');
  });

  it('ignores non-string requestId values', () => {
    expect(extractRequestId({ payload: { requestId: 42 } })).toBeUndefined();
    expect(extractRequestId({ requestId: 42 })).toBeUndefined();
    expect(extractRequestId({ payload: { requestId: null } })).toBeUndefined();
  });
});

const REAL_ORIGIN = 'https://notepad.civit.ai';

/**
 * L-OPAQUE inbound coverage. A sandboxed block WITHOUT `allow-same-origin`
 * (unverified/external tier) runs at an opaque origin → `event.origin` is the
 * literal string `'null'`. The original guard required
 * `event.origin === expectedOrigin`, so every message from such a frame
 * (including BLOCK_READY) was dropped and the block could never boot.
 *
 * `isInboundOriginAccepted` is the extracted, pure origin-acceptance branch of
 * the hook's inbound guard. The hook ALSO pins `event.source === contentWindow`
 * (the authenticating guard, origin-independent) — that pin is what
 * authenticates the sender in opaque mode and is asserted to still hold by the
 * source-pin composition test below.
 */
describe('isInboundOriginAccepted', () => {
  describe('opaqueOrigin=false (default, behavior-preserving)', () => {
    it('accepts ONLY a matching expectedOrigin', () => {
      expect(isInboundOriginAccepted(REAL_ORIGIN, REAL_ORIGIN, false)).toBe(true);
    });

    it("rejects the opaque 'null' origin (the original behavior — unverified blocks were dropped)", () => {
      expect(isInboundOriginAccepted('null', REAL_ORIGIN, false)).toBe(false);
    });

    it('rejects a non-matching origin', () => {
      expect(isInboundOriginAccepted('https://evil.example', REAL_ORIGIN, false)).toBe(false);
    });

    it('rejects everything when expectedOrigin is empty (misconfigured iframe.src)', () => {
      expect(isInboundOriginAccepted('null', '', false)).toBe(false);
      expect(isInboundOriginAccepted(REAL_ORIGIN, '', false)).toBe(false);
      expect(isInboundOriginAccepted('', '', false)).toBe(false);
    });
  });

  describe('opaqueOrigin=true (sandboxed/unverified frame)', () => {
    it("accepts the opaque 'null' origin", () => {
      expect(isInboundOriginAccepted('null', REAL_ORIGIN, true)).toBe(true);
    });

    it('still accepts a matching expectedOrigin (belt)', () => {
      expect(isInboundOriginAccepted(REAL_ORIGIN, REAL_ORIGIN, true)).toBe(true);
    });

    it('does NOT accept arbitrary non-null origins', () => {
      expect(isInboundOriginAccepted('https://evil.example', REAL_ORIGIN, true)).toBe(false);
      // 'null' is special; the string 'nullish' or anything else is rejected.
      expect(isInboundOriginAccepted('nullish', REAL_ORIGIN, true)).toBe(false);
    });

    it("accepts 'null' even when expectedOrigin is empty (opaque frames have no pinnable origin)", () => {
      expect(isInboundOriginAccepted('null', '', true)).toBe(true);
      // but a non-null, non-matching origin is still rejected.
      expect(isInboundOriginAccepted('https://evil.example', '', true)).toBe(false);
    });
  });
});

/**
 * L-OPAQUE source-pin composition. The hook's inbound guard is
 *   isInboundOriginAccepted(origin) && event.source === contentWindow.
 * In opaque mode the origin can't authenticate the sender (it's 'null' for
 * every sandboxed frame), so the source-window pin is the security guard. This
 * mirrors that exact composition to prove a 'null'-origin message from the
 * WRONG source window is still rejected even in opaque mode.
 */
describe('inbound guard composition (origin AND source-window pin)', () => {
  const ourWindow = { id: 'our-iframe-contentWindow' };
  const otherWindow = { id: 'some-other-window' };

  const accepted = (origin: string, source: unknown, opaque: boolean) =>
    isInboundOriginAccepted(origin, REAL_ORIGIN, opaque) && source === ourWindow;

  it("opaque mode: 'null' origin + correct source → ACCEPTED", () => {
    expect(accepted('null', ourWindow, true)).toBe(true);
  });

  it("opaque mode: 'null' origin + WRONG source → REJECTED (source pin holds)", () => {
    expect(accepted('null', otherWindow, true)).toBe(false);
  });

  it('pinned mode: matching origin + correct source → ACCEPTED', () => {
    expect(accepted(REAL_ORIGIN, ourWindow, false)).toBe(true);
  });

  it('pinned mode: matching origin + WRONG source → REJECTED', () => {
    expect(accepted(REAL_ORIGIN, otherWindow, false)).toBe(false);
  });
});

/**
 * L-OPAQUE outbound coverage. `resolveOutboundTargetOrigin` is the extracted
 * pure target-origin selection used by `send`. A null-origin recipient only
 * accepts a `'*'` targetOrigin (a real origin throws). Pinned mode is unchanged.
 */
describe('resolveOutboundTargetOrigin', () => {
  it("opaqueOrigin=true → posts with '*' (the only value that reaches a null-origin frame)", () => {
    expect(resolveOutboundTargetOrigin(REAL_ORIGIN, true)).toBe('*');
    // even with no expectedOrigin, opaque mode must still post to '*'.
    expect(resolveOutboundTargetOrigin('', true)).toBe('*');
  });

  it('opaqueOrigin=false → posts with expectedOrigin (never *)', () => {
    expect(resolveOutboundTargetOrigin(REAL_ORIGIN, false)).toBe(REAL_ORIGIN);
  });

  it('opaqueOrigin=false with no expectedOrigin → refuses to post (null), never *', () => {
    expect(resolveOutboundTargetOrigin('', false)).toBeNull();
  });
});
