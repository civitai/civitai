import { describe, expect, it } from 'vitest';
import { setUserSettingsInput } from '~/server/schema/user.schema';
import { splitSettingsPatch } from '~/server/services/user.service';
import { REMIX_PINS_MAX } from '~/shared/remix-apps/menu';

const pins = (pinned: string[]) => setUserSettingsInput.safeParse({ remixApps: { pinned } });
const slugs = (n: number) => Array.from({ length: n }, (_, i) => `app-${i}`);

describe('settings.remixApps', () => {
  it('takes a bounded, unique list of app slugs', () => {
    expect(pins(slugs(REMIX_PINS_MAX)).success).toBe(true);
    expect(pins(slugs(REMIX_PINS_MAX + 1)).success).toBe(false);
    expect(pins(['restyle', 'restyle']).success).toBe(false);
    expect(pins(['<script>']).success).toBe(false);
  });

  it('writes an empty pin list, so unpinning the last app sticks', () => {
    const parsed = setUserSettingsInput.parse({ remixApps: { pinned: [] } });
    expect(splitSettingsPatch(parsed).set).toEqual({ remixApps: { pinned: [] } });
  });
});
