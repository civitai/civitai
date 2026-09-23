import type { ReactNode } from 'react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';

// =============================================================================
// WorkflowPicker — the form-graph lane's chip + one-list workflow modal
// =============================================================================
//
// The teeth are the two claims Phase 01 rests on:
//   1. the input axis is an ATTRIBUTE and a FILTER, not a second control — so
//      filtering to "From image" must hide `txt2img` (Create Image) and keep
//      `img2img` (Image Variations), the two ends of the old mode strip;
//   2. selecting a row emits the workflow GRAPH KEY the strip also set.
//
// A revert to the four-segment picker fails (1) on a missing filter button and
// (2) on the emitted key, both as assertion failures rather than as a timeout.
//
// The mock set is inherited from `generation_v2/inputs/WorkflowInput.browser.
// test.tsx` — see its header for why each is required (the feature-flag and
// generation-config hooks throw outside their providers; RequireMembership and
// SupportButton sever a static import chain into `@prisma/client` that Vite's
// pre-scan would otherwise bundle). The addition here is DialogProvider: the
// modal is rendered directly rather than through the dialog stack, so
// `useDialogContext` is stubbed.
//
// No `~/utils/trpc` mock: nothing this component reaches imports it once
// `generation.utils` is stubbed, and a wholesale factory for it is what
// `no-wholesale-module-mock` forbids.

vi.mock('~/components/Dialog/dialogStore', () => ({
  dialogStore: { trigger: vi.fn(), closeById: vi.fn() },
  useDialogStore: vi.fn(() => []),
  useIsLevelFocused: vi.fn(() => true),
}));

const onCloseMock = vi.fn();
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: vi.fn(() => ({ opened: true, onClose: onCloseMock, zIndex: 300 })),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: vi.fn(() => ({})),
}));

vi.mock('~/components/ImageGeneration/GenerationForm/generation.utils', () => ({
  useGenerationConfig: vi.fn(() => ({ gateRules: [] })),
}));

vi.mock('~/components/RequireMembership/RequireMembership', () => ({
  RequireMembership: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('~/components/SupportButton/SupportButton', () => ({
  SupportButtonPolymorphic: ({ children }: { children: ReactNode }) => children,
}));

import { WorkflowPicker, WorkflowPickerModal } from './WorkflowPicker';
import { dialogStore } from '~/components/Dialog/dialogStore';

const triggerMock = vi.mocked(dialogStore.trigger);

describe('WorkflowPicker chip', () => {
  beforeEach(() => {
    triggerMock.mockReset();
    onCloseMock.mockReset();
  });

  test('shows the selected workflow label and its input type', async () => {
    renderWithProviders(<WorkflowPicker value="txt2img" onChange={vi.fn()} />);

    const chip = page.getByRole('button', { name: /Create Image/i });
    await expect.element(chip).toBeInTheDocument();
    expect(chip.element().textContent).toContain('From text');
  });

  test('an image-input workflow reports "From image", not "From text"', async () => {
    renderWithProviders(<WorkflowPicker value="img2img" onChange={vi.fn()} />);

    const chip = page.getByRole('button', { name: /Image Variations/i });
    await expect.element(chip).toBeInTheDocument();
    expect(chip.element().textContent).toContain('From image');
    expect(chip.element().textContent).not.toContain('From text');
  });

  test('clicking the chip opens the picker through dialogStore', async () => {
    renderWithProviders(<WorkflowPicker value="txt2img" ecosystemId={1} onChange={vi.fn()} />);

    const chip = page.getByRole('button', { name: /Create Image/i });
    await expect.element(chip).toBeInTheDocument();
    await chip.click();

    expect(triggerMock).toHaveBeenCalledTimes(1);
    const call = triggerMock.mock.calls[0][0] as {
      id: string;
      component: unknown;
      props: { value?: string; ecosystemId?: number };
    };
    expect(call.id).toBe('workflow-picker');
    // Pin the component too — the id alone passes if the chip opens v2's modal.
    expect(call.component).toBe(WorkflowPickerModal);
    expect(call.props.value).toBe('txt2img');
    expect(call.props.ecosystemId).toBe(1);
  });

  test('no back arrow without onBack', async () => {
    renderWithProviders(<WorkflowPicker value="img2img:upscale" onChange={vi.fn()} />);

    await expect.element(page.getByRole('button', { name: /Upscale/i })).toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Back to previous workflow' }).elements()).toHaveLength(
      0
    );
  });

  test('the back arrow calls onBack when given', async () => {
    const onBack = vi.fn();
    renderWithProviders(
      <WorkflowPicker value="img2img:upscale" onChange={vi.fn()} onBack={onBack} />
    );

    const back = page.getByRole('button', { name: 'Back to previous workflow' });
    await expect.element(back).toBeInTheDocument();
    await back.click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('WorkflowPickerModal', () => {
  beforeEach(() => {
    triggerMock.mockReset();
    onCloseMock.mockReset();
  });

  test('lists both halves of a mode-strip pair as rows in one list', async () => {
    renderWithProviders(
      <WorkflowPickerModal value="txt2img" isMember={false} onChange={vi.fn()} />
    );

    await expect.element(page.getByText('Create Image', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('Image Variations', { exact: true })).toBeInTheDocument();
  });

  test('the input filter hides text-input workflows and keeps image-input ones', async () => {
    renderWithProviders(
      <WorkflowPickerModal value="txt2img" isMember={false} onChange={vi.fn()} />
    );

    // `exact: true` is load-bearing: locators default to a case-insensitive
    // SUBSTRING match on the accessible name, and every img2* row button also
    // contains "From image" — without it this resolves to 11 elements and the
    // strict-mode violation retries until the 15s budget expires.
    const fromImage = page.getByRole('button', { name: 'From image', exact: true });
    await expect.element(fromImage).toBeInTheDocument();
    await fromImage.click();

    // "Image Variations" survives the filter; "Create Image" — the current
    // selection, and a text-input workflow — does not.
    await expect.element(page.getByText('Image Variations', { exact: true })).toBeInTheDocument();
    expect(page.getByText('Create Image', { exact: true }).elements()).toHaveLength(0);
  });

  test('selecting a row emits that workflow graph key and closes', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <WorkflowPickerModal value="txt2img" isMember={false} onChange={onChange} />
    );

    const row = page.getByText('Image Variations', { exact: true });
    await expect.element(row).toBeInTheDocument();
    await row.click();

    // The whole tuple, not just the key: `graphKey` and `id` are identical for
    // every workflow in the live config (no aliases exist today), so asserting
    // the first argument alone cannot tell them apart. Pinning arity and order
    // is the most this can honestly claim until an alias exists.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('img2img', expect.any(Array), 'img2img');
    expect(onCloseMock).toHaveBeenCalledTimes(1);
  });
});
