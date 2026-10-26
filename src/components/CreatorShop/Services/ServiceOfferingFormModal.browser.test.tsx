import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import '@mantine/core/styles.css';
import { renderWithProviders } from '../../../../test/component-setup';
import { ServiceOfferingFormModal } from './ServiceOfferingFormModal';

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));
vi.mock('~/components/CreatorShop/Services/creator-service.util', () => ({
  useMutateMyServices: () => ({ upsert: { mutateAsync: vi.fn(), isPending: false } }),
}));

const inputTop = (label: string) => {
  const input = [...document.querySelectorAll('label')]
    .find((l) => l.textContent?.startsWith(label))
    ?.closest('.mantine-InputWrapper-root')
    ?.querySelector('input');
  return Math.round(input!.getBoundingClientRect().top);
};

describe('ServiceOfferingFormModal', () => {
  test('the slots field and the preview select sit on one line at desktop width', async () => {
    await page.viewport(1280, 900);
    renderWithProviders(<ServiceOfferingFormModal />);
    await new Promise((r) => setTimeout(r, 300));
    expect(inputTop('Preview you deliver')).toBe(inputTop('Open slots at once'));
  });
});
