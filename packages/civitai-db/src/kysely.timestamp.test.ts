import { describe, expect, it } from 'vitest';
import { parseTimestampAsUtc } from './kysely';

describe('parseTimestampAsUtc', () => {
  it('reads a timestamp without time zone as a UTC instant, whatever the host timezone', () => {
    expect(parseTimestampAsUtc('2026-03-08 02:30:00.123').toISOString()).toBe(
      '2026-03-08T02:30:00.123Z'
    );
  });
});
