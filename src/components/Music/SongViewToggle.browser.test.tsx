import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { SongViewToggle } from '~/components/Music/SongViewToggle';
import { renderWithProviders } from '../../../test/component-setup';

describe('SongViewToggle', () => {
  // Pencil `YzE3g`: outlined with `$border` (dark-4, gray-3 in light mode).
  for (const [scheme, color] of [
    ['dark', 'rgb(55, 58, 64)'],
    ['light', 'rgb(222, 226, 230)'],
  ] as const)
    test(`draws its outline in ${scheme} mode`, async () => {
      await renderWithProviders(<SongViewToggle value="card" onChange={vi.fn()} />);
      // After the render: the provider sets the scheme on mount.
      document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
      const toggle = () => page.getByRole('radiogroup', { name: 'View' }).element();
      expect(getComputedStyle(toggle()).borderTopStyle).toBe('solid');
      expect(getComputedStyle(toggle()).borderTopWidth).toBe('1px');
      await expect.poll(() => getComputedStyle(toggle()).borderTopColor).toBe(color);
    });
});
