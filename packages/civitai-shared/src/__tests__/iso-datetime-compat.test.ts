import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { isoDatetimeCompat } from '../iso-datetime-compat';

const zodMinor = Number(createRequire(import.meta.url)('zod/package.json').version.split('.')[1]);

describe('isoDatetimeCompat', () => {
  it.each([
    ['2024-05-14T20:23Z', '2024-05-14T20:23:00Z'],
    ['2024-05-14T20:23:45Z', '2024-05-14T20:23:45Z'],
    ['2024-05-14T20:23:45.123Z', '2024-05-14T20:23:45.123Z'],
  ])('accepts %s as %s', (input, output) => {
    expect(isoDatetimeCompat().parse(input)).toBe(output);
  });

  it.each([
    ['2024-05-14T20:23+02:00', '2024-05-14T20:23:00+02:00'],
    ['2024-05-14T20:23-05:30', '2024-05-14T20:23:00-05:30'],
    ['2024-05-14T20:23:45+00:00', '2024-05-14T20:23:45+00:00'],
  ])('with offsets allowed, accepts %s as %s', (input, output) => {
    expect(isoDatetimeCompat({ offset: true }).parse(input)).toBe(output);
  });

  it.each([
    'soon',
    '',
    '2024-05-14',
    '2024-13-01T00:00Z',
    '2024-02-30T00:00Z',
    '2024-05-14T24:00Z',
    '2024-05-14T20:23',
    '2024-05-14 20:23Z',
  ])('still rejects %j', (input) => {
    expect(isoDatetimeCompat({ offset: true }).safeParse(input).success).toBe(false);
  });

  it('without offsets, still rejects an offset', () => {
    expect(isoDatetimeCompat().safeParse('2024-05-14T20:23+02:00').success).toBe(false);
    expect(isoDatetimeCompat().safeParse('2024-05-14T20:23:00+02:00').success).toBe(false);
  });

  it('documents itself as a date-time string', () => {
    expect(z.toJSONSchema(isoDatetimeCompat(), { io: 'input' })).toMatchObject({
      type: 'string',
      format: 'date-time',
    });
  });

  // The failure this helper exists for. Only true from zod 4.6, so it is skipped on older copies.
  it.skipIf(zodMinor < 6)('bare z.iso.datetime() rejects minute precision on this zod', () => {
    expect(z.iso.datetime().safeParse('2024-05-14T20:23Z').success).toBe(false);
  });
});
