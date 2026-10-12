import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { pollWaitSecondsForWire } from '~/components/AppBlocks/pollWaitSeconds';

// The bound `blocks.pollWorkflow` and the REST twin put on the wire, restated as a literal so a
// change to the shared constant has to be made here on purpose.
const wireSchema = z.number().int().min(0).max(60);

describe('pollWaitSecondsForWire', () => {
  it.each([
    [1, 1],
    [7, 7],
    [59, 59],
    [60, 60],
  ])('forwards the whole number of seconds %s unchanged', (input, expected) => {
    expect(pollWaitSecondsForWire(input)).toBe(expected);
  });

  it.each([
    [7.9, 7],
    [1.5, 1],
    [61, 60],
    [99_999, 60],
    [Number.MAX_VALUE, 60],
  ])('makes %s wire-valid as %s instead of letting the schema reject it', (input, expected) => {
    expect(pollWaitSecondsForWire(input)).toBe(expected);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a numeric string', '7'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a negative', -3],
    ['zero', 0],
    ['a fraction below one', 0.9],
    ['a boolean', true],
    ['an object', { valueOf: () => 7 }],
    ['an array', [7]],
  ])('asks for no hold when the value is %s', (_label, input) => {
    expect(pollWaitSecondsForWire(input)).toBeUndefined();
  });

  it('never returns a value outside the restated wire bound', () => {
    const inputs = [-1e9, -3, -0.1, 0, 0.9, 1, 1.5, 7, 59.99, 60, 60.5, 61, 1e9, Number.MAX_VALUE];
    const forwarded = inputs
      .map((input) => pollWaitSecondsForWire(input))
      .filter((value): value is number => value !== undefined);
    expect(forwarded.length).toBeGreaterThan(5);
    for (const value of forwarded) expect(wireSchema.safeParse(value).success).toBe(true);
  });
});
