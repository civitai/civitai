import { describe, expect, it } from 'vitest';
import { isEnvSwitchOff, isEnvSwitchOn } from '../env-switch';

describe('isEnvSwitchOff', () => {
  it.each(['off', 'OFF', 'Off', '0', 'false', 'FALSE', 'False', ' off ', '\tfalse\n'])(
    'reads %j as off',
    (value) => {
      expect(isEnvSwitchOff(value)).toBe(true);
      expect(isEnvSwitchOn(value)).toBe(false);
    }
  );

  it.each([undefined, null, '', ' ', 'on', 'true', '1', 'no', 'offf', 'disabled', '00', 'false!'])(
    'reads %j as on (unset and unknown values keep the default)',
    (value) => {
      expect(isEnvSwitchOff(value)).toBe(false);
      expect(isEnvSwitchOn(value)).toBe(true);
    }
  );
});
