import { describe, expect, it } from 'vitest';
import { abuseReportInput } from '../schema';

const report = (startedAt: string, finishedAt: string) => ({
  detector: 'test-detector',
  startedAt,
  finishedAt,
  findings: [],
});

describe('abuseReportInput timestamps', () => {
  it('takes minute precision, read as :00', () => {
    const parsed = abuseReportInput.parse(report('2026-11-10T11:20Z', '2026-11-10T11:47+00:00'));
    expect(parsed.startedAt).toBe('2026-11-10T11:20:00Z');
    expect(parsed.finishedAt).toBe('2026-11-10T11:47:00+00:00');
  });

  it('still orders minute-precision runs: a finish before the start is refused', () => {
    const result = abuseReportInput.safeParse(report('2026-11-10T11:47Z', '2026-11-10T11:20Z'));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(['finishedAt']);
  });
});
