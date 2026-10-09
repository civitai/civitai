import { describe, expect, it } from 'vitest';
import { PERFORMANCE_CHANNELS, shownChannels } from '../earning-channels';

const row = (tip: number) => ({ channels: { tip: { received: [{ total: tip }] } } });
const withoutTip = PERFORMANCE_CHANNELS.filter((c) => c !== 'tip');

describe('shownChannels', () => {
  it('hides the Generation Tips column when no row earned tips', () => {
    expect(shownChannels([row(0), row(0)], 'generations')).toEqual(withoutTip);
  });

  it('shows it once any row earned tips', () => {
    const shown = shownChannels([row(0), row(3)], 'generations');
    expect(shown).toContain('tip');
    expect(shown).toEqual([...PERFORMANCE_CHANNELS]);
  });

  // Both tables build their sort keys as `channel:<channel>`; a stored tip sort must keep its column.
  it('keeps it while the table is sorted by it', () => {
    expect(shownChannels([], 'channel:tip')).toContain('tip');
  });
});
