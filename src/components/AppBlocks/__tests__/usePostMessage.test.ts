import { describe, expect, it } from 'vitest';
import { extractRequestId } from '../usePostMessage';

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
