import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUseForm } = vi.hoisted(() => ({ mockUseForm: vi.fn(() => ({})) }));

vi.mock('~/libs/form', async (importOriginal) => ({
  ...(await importOriginal<typeof LibsForm>()),
  useForm: mockUseForm,
  Form: () => null,
}));
vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogProvider>()),
  useDialogContext: () => ({ opened: true, onClose: vi.fn() }),
}));
vi.mock('@mantine/core', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineCore>()),
  Modal: () => null,
}));

import type * as LibsForm from '~/libs/form';
import type * as DialogProvider from '~/components/Dialog/DialogProvider';
import type * as MantineCore from '@mantine/core';
import { SchedulePostModal } from '~/components/Post/EditV2/SchedulePostModal';

const NOW = new Date('2026-10-01T12:03:30.000Z');

const renderedDefault = (publishedAt?: Date | null) => {
  renderToStaticMarkup(createElement(SchedulePostModal, { onSubmit: vi.fn(), publishedAt }));
  const [options] = mockUseForm.mock.calls[0] as unknown as [{ defaultValues: { date: Date } }];
  return options.defaultValues.date;
};

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('SchedulePostModal default date', () => {
  it('defaults a new schedule to the next valid five-minute slot, not to now', () => {
    expect(renderedDefault().toISOString()).toBe('2026-10-01T12:20:00.000Z');
  });

  it('keeps the date of an existing schedule', () => {
    const scheduled = new Date('2026-10-03T09:00:00.000Z');
    expect(renderedDefault(scheduled)).toBe(scheduled);
  });
});
