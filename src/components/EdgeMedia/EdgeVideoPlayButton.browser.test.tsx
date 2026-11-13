import { describe, expect, test } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';

const SRC = '00000001-0000-4000-8000-000000000000';

async function playButtonSize(boxW: number, boxH = boxW) {
  renderWithProviders(
    <div style={{ width: boxW, height: boxH, position: 'relative' }}>
      <EdgeVideo src={SRC} wrapperProps={{ style: { width: '100%', height: '100%' } }} />
    </div>
  );
  await expect
    .poll(() => document.querySelector('svg.tabler-icon-player-play-filled'))
    .toBeTruthy();
  const icon = document.querySelector('svg.tabler-icon-player-play-filled')!;
  // Computed width, not the rect: the harness loads no preflight, so padding would add to a content-box.
  const { width, height } = getComputedStyle(icon);
  return { width: parseFloat(width), height: parseFloat(height) };
}

describe('EdgeVideo play button', () => {
  test('shrinks inside a 64px thumbnail so the frame stays visible', async () => {
    expect(await playButtonSize(64)).toEqual({ width: 32, height: 32 });
  });

  test('keeps the full 80px size on a large card', async () => {
    expect(await playButtonSize(400)).toEqual({ width: 80, height: 80 });
  });

  test('stays square in a wide, short wrapper', async () => {
    expect(await playButtonSize(300, 100)).toEqual({ width: 80, height: 80 });
  });
});
