import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const { CrucibleIntro } = await import('~/components/Crucible/CrucibleIntro');

describe('CrucibleIntro', () => {
  test('says every vote counts the same, since influence does not weight votes', async () => {
    renderWithProviders(<CrucibleIntro canCreate={false} onDismiss={() => undefined} />);

    await expect.element(page.getByText('Judge', { exact: true })).toBeVisible();
    expect(document.body.textContent).toMatch(/every judge's vote counts the same/i);
    expect(document.body.textContent).not.toMatch(/influence/i);
  });
});
