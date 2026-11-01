import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as DialogProvider from '~/components/Dialog/DialogProvider';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../../test/component-setup';

vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogProvider>()),
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));

import { SchedulePostModal } from '~/components/Post/EditV2/SchedulePostModal';

// Local noon, so the default (next valid slot) is 12:20 on Oct 6 and the calendar opens on October.
const NOW = new Date(2026, 9, 6, 12, 3);

const timeInput = () => page.getByRole('textbox', { name: 'Time' });

async function pickDay(day: number) {
  await userEvent.click(page.getByRole('button', { name: /Publish Date/ }));
  await expect.element(page.getByText('October 2026')).toBeInTheDocument();
  const button = [...document.querySelectorAll<HTMLButtonElement>('table button')].find(
    (el) => el.textContent === String(day) && !el.hasAttribute('data-outside')
  );
  if (!button) throw new Error(`no day button for ${day}`);
  await userEvent.click(button);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SchedulePostModal date and time fields', () => {
  test('submits the picked day combined with the typed time', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<SchedulePostModal onSubmit={onSubmit} />);
    await expect.element(timeInput()).toHaveValue('12:20');

    await pickDay(9);
    await userEvent.fill(timeInput(), '18:45');
    await userEvent.click(page.getByRole('button', { name: 'Schedule' }));

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0]).toEqual(new Date(2026, 9, 9, 18, 45));
  });

  test('keeps the typed time when the day changes afterwards', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<SchedulePostModal onSubmit={onSubmit} />);

    await userEvent.fill(timeInput(), '07:30');
    await pickDay(20);
    await expect.element(timeInput()).toHaveValue('07:30');
    await userEvent.click(page.getByRole('button', { name: 'Schedule' }));

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0]).toEqual(new Date(2026, 9, 20, 7, 30));
  });

  test('a cleared time stays cleared while editing instead of snapping back', async () => {
    renderWithProviders(<SchedulePostModal onSubmit={vi.fn()} />);

    await userEvent.clear(timeInput());
    await expect.element(timeInput()).toHaveValue('');
  });

  test('shows the schema error for a time too soon and does not submit', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<SchedulePostModal onSubmit={onSubmit} />);

    await userEvent.fill(timeInput(), '12:05');
    await userEvent.click(page.getByRole('button', { name: 'Schedule' }));

    await expect
      .element(page.getByText('Schedule date must be at least 10 minutes in the future'))
      .toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
