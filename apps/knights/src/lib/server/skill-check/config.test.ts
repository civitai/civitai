import { describe, expect, it } from 'vitest';
import { DEFAULT_SKILL_CHECKS, skillCheckSettings } from './config';

describe('skillCheckSettings', () => {
  it('keeps 500 checks and serves no judged image when nothing is set', () => {
    expect(skillCheckSettings({})).toEqual({ enabled: false, poolCap: 500, serveJudged: false });
    expect(DEFAULT_SKILL_CHECKS).toEqual({ enabled: false, poolCap: 500, serveJudged: false });
  });

  it('takes the values the environment sets', () => {
    expect(
      skillCheckSettings({
        KNIGHTS_SKILL_CHECK_POOL_CAP: '120',
        KNIGHTS_SKILL_CHECK_SERVE_JUDGED: 'on',
        KNIGHTS_INQUISITOR_QUEUE: 'on',
      })
    ).toEqual({ enabled: true, poolCap: 120, serveJudged: true });
  });

  it.each([
    ['not a number', 'abc'],
    ['zero', '0'],
    ['a fraction', '12.5'],
    ['empty', ''],
  ])('ignores a pool cap that is %s', (_label, raw) => {
    expect(skillCheckSettings({ KNIGHTS_SKILL_CHECK_POOL_CAP: raw }).poolCap).toBe(500);
  });

  it('keeps the inquisitor queue and the pool off unless switched on', () => {
    expect(skillCheckSettings({ KNIGHTS_INQUISITOR_QUEUE: 'maybe' }).enabled).toBe(false);
    expect(
      skillCheckSettings({ KNIGHTS_INQUISITOR_QUEUE: 'on' }, { inquisitorQueue: false }).enabled
    ).toBe(false);
  });

  it('reads anything but an on value as off', () => {
    expect(skillCheckSettings({ KNIGHTS_SKILL_CHECK_SERVE_JUDGED: 'maybe' }).serveJudged).toBe(
      false
    );
    expect(skillCheckSettings({ KNIGHTS_SKILL_CHECK_SERVE_JUDGED: 'TRUE' }).serveJudged).toBe(true);
  });

  it('lets a value saved on the Config page win over the environment', () => {
    expect(
      skillCheckSettings(
        { KNIGHTS_SKILL_CHECK_POOL_CAP: '120', KNIGHTS_SKILL_CHECK_SERVE_JUDGED: 'on' },
        { skillCheckPoolCap: 40, skillCheckServeJudged: false, inquisitorQueue: true }
      )
    ).toEqual({ enabled: true, poolCap: 40, serveJudged: false });
  });
});
