import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { IconHeart } from '@tabler/icons-react';

// Next camel-cases a stylesheet's class names (`scroll-area` is `scrollArea`); this runner does not.
vi.mock('~/components/Profile/Sections/ShowcaseGrid.module.scss', async (importOriginal) => {
  const { default: classes } = await importOriginal<{ default: Record<string, string> }>();
  const camel = (name: string) => name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  const byCamel = Object.fromEntries(Object.entries(classes).map(([k, v]) => [camel(k), v]));
  return { default: { ...classes, ...byCamel } };
});

import '~/styles/globals.css';
import { renderWithProviders } from '../../../../test/component-setup';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { ProfileSection } from '~/components/Profile/ProfileSection';

// Below `screens.sm` the showcase row is a horizontal scroller. A scrollbar belongs to its element,
// so that element must take the pointer; the hat room it overlaps on the header must not steal it.
async function narrowRow() {
  await page.viewport(500, 700);
  renderWithProviders(
    <div style={{ width: 360, margin: '60px 40px', containerType: 'inline-size' }}>
      <ProfileSection
        title="Showcase"
        icon={<IconHeart />}
        action={
          <button data-testid="action" style={{ height: 44 }}>
            View all
          </button>
        }
      >
        <ShowcaseGrid itemCount={9} rows={2} minWidth={280}>
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} data-testid="card" style={{ height: 160 }} className="bg-slate-600" />
          ))}
        </ShowcaseGrid>
      </ProfileSection>
    </div>
  );
  await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="card"]').length).toBe(9));
  const card = document.querySelector('[data-testid="card"]')!;
  return card.parentElement!;
}

describe('showcase row below screens.sm', () => {
  test('the horizontal scroller takes the pointer, so its scrollbar can be dragged', async () => {
    const grid = await narrowRow();
    expect(getComputedStyle(grid).overflowX).toBe('auto');
    expect(grid.scrollWidth).toBeGreaterThan(grid.clientWidth);
    expect(getComputedStyle(grid).pointerEvents).not.toBe('none');
    // The strip at the bottom edge, where the scrollbar draws, resolves to the scroller.
    const r = grid.getBoundingClientRect();
    expect(document.elementFromPoint(r.left + r.width / 2, r.bottom - 2)).toBe(grid);
  });

  test('the header action stays clickable where the hat room overlaps it', async () => {
    const grid = await narrowRow();
    const action = document.querySelector('[data-testid="action"]')!;
    const a = action.getBoundingClientRect();
    // Premise: the grid's box reaches the action's lower edge, otherwise this proves nothing.
    expect(grid.getBoundingClientRect().top).toBeLessThan(a.bottom - 4);
    expect(document.elementFromPoint(a.left + a.width / 2, a.bottom - 2)).toBe(action);
  });
});
