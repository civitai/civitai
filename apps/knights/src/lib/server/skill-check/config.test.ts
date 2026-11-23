import { describe, expect, it } from 'vitest';
import { skillCheckSettings } from './config';

describe('skillCheckSettings', () => {
  it('is off with nothing set, and a value saved on the Config page beats the environment', () => {
    expect(skillCheckSettings({})).toMatchObject({ enabled: false, serveJudged: false });
    expect(
      skillCheckSettings(
        {
          KNIGHTS_INQUISITOR_QUEUE: 'on',
          KNIGHTS_SKILL_CHECK_POOL_CAP: '120',
          KNIGHTS_SKILL_CHECK_SERVE_JUDGED: 'on',
        },
        { inquisitorQueue: false, skillCheckPoolCap: 40, skillCheckServeJudged: false }
      )
    ).toEqual({ enabled: false, poolCap: 40, serveJudged: false });
  });
});
