import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { TagChipRow } from '~/components/Tags/TagChipRow';
import { renderWithProviders } from '../../../../test/component-setup';

const items = [
  { id: 1, label: 'Synthwave' },
  { id: 2, label: 'Lo-fi' },
];
const chip = (name: string) => page.getByRole('button', { name, exact: true });

describe('TagChipRow', () => {
  test('the default chips stay the uppercase Mantine buttons the image feeds use', async () => {
    await renderWithProviders(
      <TagChipRow items={items} activeId={2} onSelect={vi.fn()} onClear={vi.fn()} />
    );
    const lofi = chip('Lo-fi').element();
    expect(lofi.classList).toContain('mantine-Button-root');
    expect(getComputedStyle(lofi).textTransform).toBe('uppercase');
    expect(lofi.getAttribute('data-active')).toBe('true');
  });

  test('the outline chips are sentence case, with the picked one marked and All clearing', async () => {
    const onSelect = vi.fn();
    const onClear = vi.fn();
    await renderWithProviders(
      <TagChipRow
        items={items}
        activeId={2}
        onSelect={onSelect}
        onClear={onClear}
        variant="outline"
      />
    );
    const lofi = chip('Lo-fi').element();
    expect(lofi.classList).not.toContain('mantine-Button-root');
    expect(getComputedStyle(lofi).textTransform).toBe('none');
    expect(lofi.getAttribute('data-active')).toBe('true');
    expect(chip('All').element().getAttribute('data-active')).toBeNull();

    await chip('Synthwave').click();
    expect(onSelect).toHaveBeenCalledWith(items[0]);
    await chip('All').click();
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
