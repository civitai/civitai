import { describe, expect, it } from 'vitest';
import {
  INVALID_BUNDLE_MESSAGE,
  submitVersionParseErrorMessage,
  submitVersionSchema,
} from '~/server/schema/blocks/publish-request.schema';

/**
 * #4059 — `submitVersionSchema` build provenance (`sourceCommit` / `sourceDirty`).
 *
 * 🔴 THE ANTI-STRIP TEST IS THE POINT OF THIS FILE. A plain `z.object` STRIPS
 * unknown keys silently, so before these fields existed a client sending
 * provenance got no error and no storage — it looked like it worked and stored
 * nothing. So it is not enough to assert that a payload carrying provenance
 * PARSES: it has to assert the values are PRESENT ON `parsed.data`. Deleting the
 * fields from the schema must turn this file red.
 *
 * The other half is that a malformed `sourceCommit` REJECTS rather than being
 * dropped — silently dropping is the same inert-feature failure wearing a
 * different hat.
 */

// 40 lowercase hex, containing digits AND a–f, and not a repeated character —
// so a mutant that widens the class or drops the length anchor has something to
// be caught by. Every off-shape fixture below is an independent literal rather
// than a transform of this one.
const VALID_SHA = '4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3';
const BUNDLE = Buffer.from('fake-zip-bytes').toString('base64');

function parse(over: Record<string, unknown> = {}) {
  return submitVersionSchema.safeParse({ bundleBase64: BUNDLE, ...over });
}

describe('submitVersionSchema — #4059 provenance (accept)', () => {
  it('ACCEPTS a well-formed pair AND KEEPS BOTH VALUES on parsed.data (anti-strip)', () => {
    const parsed = parse({ sourceCommit: VALID_SHA, sourceDirty: true });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // Not "it parsed" — the values SURVIVED the parse. This is the assertion a
    // stripping schema fails.
    expect(parsed.data.sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
    expect(parsed.data.sourceDirty).toBe(true);
  });

  it('KEEPS sourceDirty:false — false is a CLAIM (clean), not an absence', () => {
    const parsed = parse({ sourceCommit: VALID_SHA, sourceDirty: false });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // `toBe(false)` and not a falsy check: `undefined` would pass a falsy check
    // and mean the opposite thing (unknown).
    expect(parsed.data.sourceDirty).toBe(false);
    expect('sourceDirty' in parsed.data).toBe(true);
  });

  it('ACCEPTS a payload with NEITHER field (no-regression: this must never gate a submit)', () => {
    const parsed = parse();
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.bundleBase64).toBe(BUNDLE);
    expect(parsed.data.sourceCommit).toBeUndefined();
    expect(parsed.data.sourceDirty).toBeUndefined();
  });

  it('ACCEPTS sourceCommit alone (sourceDirty stays UNKNOWN, not false)', () => {
    const parsed = parse({ sourceCommit: VALID_SHA });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
    // 🔴 Absent, NOT coerced to false — the two are different answers.
    expect(parsed.data.sourceDirty).toBeUndefined();
  });
});

describe('submitVersionSchema — #4059 provenance (reject)', () => {
  it('REJECTS a 39-hex sourceCommit (too short)', () => {
    const parsed = parse({ sourceCommit: '4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f' });
    expect(parsed.success).toBe(false);
  });

  it('REJECTS a 41-hex sourceCommit (too long)', () => {
    const parsed = parse({ sourceCommit: '4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3a' });
    expect(parsed.success).toBe(false);
  });

  it('REJECTS an UPPERCASE 40-hex sourceCommit (lowercase is the canonical rendering)', () => {
    const parsed = parse({ sourceCommit: '4F3A9C2E17B06D85FA1C39E470B28D6AC519E0F3' });
    expect(parsed.success).toBe(false);
  });

  it('REJECTS a non-hex 40-character sourceCommit', () => {
    const parsed = parse({ sourceCommit: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' });
    expect(parsed.success).toBe(false);
  });

  it('REJECTS a non-string sourceCommit', () => {
    const parsed = parse({ sourceCommit: 1234567890 });
    expect(parsed.success).toBe(false);
  });

  it('REJECTS sourceDirty as the STRING "true" (no coercion)', () => {
    const parsed = parse({ sourceDirty: 'true' });
    expect(parsed.success).toBe(false);
  });

  it('a rejection is NOT a silent drop — the bundle does not sneak through', () => {
    // The failure mode this replaces: a stripping schema would have returned
    // success with the bad field gone, and the submit would have proceeded.
    const parsed = parse({ sourceCommit: 'nope' });
    expect(parsed.success).toBe(false);
    expect(parsed.data).toBeUndefined();
  });
});

describe('submitVersionParseErrorMessage', () => {
  it('NAMES sourceCommit when the failure is confined to it', () => {
    const parsed = parse({ sourceCommit: 'nope' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const msg = submitVersionParseErrorMessage(parsed.error);
    expect(msg).toContain('sourceCommit');
    // And it is NOT the flat bundle message — that is the whole point.
    expect(msg).not.toBe(INVALID_BUNDLE_MESSAGE);
  });

  it('NAMES sourceDirty when the failure is confined to it', () => {
    const parsed = parse({ sourceDirty: 'true' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const msg = submitVersionParseErrorMessage(parsed.error);
    expect(msg).toContain('sourceDirty');
    expect(msg).not.toBe(INVALID_BUNDLE_MESSAGE);
  });

  it('leaves a genuine BUNDLE failure reading exactly the legacy message', () => {
    const parsed = submitVersionSchema.safeParse({ bundleBase64: '' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(submitVersionParseErrorMessage(parsed.error)).toBe('Invalid bundle payload');
  });

  it('a MIXED failure (bundle + provenance) still reads as the bundle message', () => {
    const parsed = submitVersionSchema.safeParse({ bundleBase64: '', sourceCommit: 'nope' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(submitVersionParseErrorMessage(parsed.error)).toBe('Invalid bundle payload');
  });

  it('a non-object body reads as the bundle message (unrecognised path)', () => {
    const parsed = submitVersionSchema.safeParse('not-an-object');
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(submitVersionParseErrorMessage(parsed.error)).toBe('Invalid bundle payload');
  });
});
