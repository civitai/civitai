import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { Button } from '@mantine/core';
import { IconHeart } from '@tabler/icons-react';
import { renderAtViewport } from '../../../../test/geometry-setup';
import { ProfileSection } from '~/components/Profile/ProfileSection';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';

// The grid's hat-room padding reaches up over the section header. Below screens.sm the grid takes
// the pointer (so its scrollbar can be dragged), so the header's action must still win where the two
// overlap. Needs the real cascade: Mantine's Button paints above the grid only when its styles load.
afterEach(() => cleanup());

describe('showcase row below screens.sm', () => {
  it('leaves the header action clickable where the hat room overlaps it', async () => {
    await renderAtViewport(
      <div style={{ width: 360, containerType: 'inline-size' }}>
        <ProfileSection
          title="Showcase"
          icon={<IconHeart />}
          action={<Button data-testid="action">View all</Button>}
        >
          <ShowcaseGrid itemCount={9} rows={2}>
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} style={{ height: 160 }} />
            ))}
          </ShowcaseGrid>
        </ProfileSection>
      </div>,
      { width: 400, height: 700 }
    );
    const action = document.querySelector('[data-testid="action"]')!;
    const gridEl = [...document.querySelectorAll('div')].find(
      (d) => getComputedStyle(d).overflowX === 'auto'
    )!;
    const a = action.getBoundingClientRect();
    // Premise: the grid's box reaches into the action's lower edge, or this proves nothing.
    expect(gridEl.getBoundingClientRect().top).toBeLessThan(a.bottom - 4);
    const hit = document.elementFromPoint(a.left + a.width / 2, a.bottom - 2);
    expect(hit && action.contains(hit)).toBe(true);
  });
});
