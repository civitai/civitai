import { legacyCountersForget } from '../progression/legacy-exp';
import { getSysRedis } from '../redis';

export const forgetLegacyCounters = legacyCountersForget(getSysRedis);
