import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addViewSchema,
  TRACK_FREEFORM_MAX_CHARS,
  trackActionInputSchema,
  trackSearchSchema,
} from '~/server/schema/track.schema';

const MESSAGE = `exceeds ${TRACK_FREEFORM_MAX_CHARS} serialized characters`;
const VIEW = { type: 'ModelView', entityType: 'Model', entityId: 1 } as const;
const SEARCH = { query: 'cat', index: 'models' };
const CANCEL = { type: 'Membership_Cancel', details: { reason: 'r', from: 'f' } } as const;

/** `{ note }` whose JSON is exactly `length` characters. */
const ofLength = (length: number) => ({ note: 'x'.repeat(length - '{"note":""}'.length) });

const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : r.error?.issues.map((i) => i.message);

describe('free-form tracking payload cap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts addView details and search filters at the cap and refuses one character over', () => {
    expect(JSON.stringify(ofLength(TRACK_FREEFORM_MAX_CHARS)).length).toBe(
      TRACK_FREEFORM_MAX_CHARS
    );
    const at = ofLength(TRACK_FREEFORM_MAX_CHARS);
    const over = ofLength(TRACK_FREEFORM_MAX_CHARS + 1);
    expect(addViewSchema.safeParse({ ...VIEW, details: at }).success).toBe(true);
    expect(messages(addViewSchema.safeParse({ ...VIEW, details: over }))).toEqual([MESSAGE]);
    expect(trackSearchSchema.safeParse({ ...SEARCH, filters: at }).success).toBe(true);
    expect(messages(trackSearchSchema.safeParse({ ...SEARCH, filters: over }))).toEqual([MESSAGE]);
  });

  it('caps an action as a whole', () => {
    expect(trackActionInputSchema.safeParse(CANCEL).success).toBe(true);
    const over = {
      ...CANCEL,
      details: { ...CANCEL.details, pad: 'x'.repeat(TRACK_FREEFORM_MAX_CHARS) },
    };
    expect(messages(trackActionInputSchema.safeParse(over))).toEqual([MESSAGE]);
  });

  it('accepts an event with no free-form payload', () => {
    expect(addViewSchema.safeParse(VIEW).success).toBe(true);
    expect(trackSearchSchema.safeParse(SEARCH).success).toBe(true);
  });

  it('refuses a payload that repeats one object past the cap without serializing it', () => {
    const filters = { tags: new Array(10_000).fill({ name: 'x'.repeat(1_000) }) };
    const stringify = JSON.stringify;
    let stringified = 0;
    vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof stringify>) => {
      const out = stringify(...args);
      stringified += out?.length ?? 0;
      return out;
    });
    const result = trackSearchSchema.safeParse({ ...SEARCH, filters });
    const action = trackActionInputSchema.safeParse({
      ...CANCEL,
      details: { ...CANCEL.details, filters },
    });
    vi.restoreAllMocks();
    expect(messages(result)).toEqual([MESSAGE]);
    expect(messages(action)).toEqual([MESSAGE]);
    // zod writes a few small strings of its own.
    expect(stringified).toBeLessThan(10_000);
  });
});
