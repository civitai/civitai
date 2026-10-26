import type * as MantineHooks from '@mantine/hooks';
import type { ReactNode } from 'react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// Mock notes:
// - `useFeatureFlags` throws outside FeatureFlagsCtx, so it is mocked to {}. Every workflow with a
//   `featureFlag` (the 3D ones) is filtered out.
// - `useGenerationConfig` is mocked to `{ gateRules: [] }` so no tRPC client is needed.
// - Which surface opens depends on media queries over the real viewport, so `@mantine/hooks` is
//   mocked via importActual with only useMediaQuery overridden. `setMobile(true)` makes every query
//   match; with the mobile generator's flag off, that is the legacy generator on a narrow screen.
//   Which surface opens where is PopoverOrSheet's own test.
// - `WorkflowInput` renders only icon segments (aria-label "Image" / "Video" / ...). The workflow
//   label text is `SelectedWorkflowDisplay`'s job.

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: vi.fn(() => ({})),
  // no mobileGenerator flag, so a narrow window is the legacy generator
  useOptionalFeatureFlags: vi.fn(() => ({})),
}));

vi.mock('~/components/ImageGeneration/GenerationForm/generation.utils', () => ({
  useGenerationConfig: vi.fn(() => ({ gateRules: [] })),
}));

// `RequireMembership` and `SupportButton` render only in the member-only upsell, which these tests
// never reach. Their module graphs reach @prisma/client, so they are stubbed at the boundary. The
// optimizer's pre-scan still needs `.prisma/client/index-browser` to resolve: CI generates it; locally
// run `pnpm db:generate`.
vi.mock('~/components/RequireMembership/RequireMembership', () => ({
  RequireMembership: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('~/components/SupportButton/SupportButton', () => ({
  SupportButtonPolymorphic: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@mantine/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineHooks>()),
  useMediaQuery: vi.fn(() => false), // default: desktop; overridden per test
}));

import {
  WorkflowInput,
  SelectedWorkflowDisplay,
} from '~/components/generation_v2/inputs/WorkflowInput';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useMediaQuery } from '@mantine/hooks';

const featureFlagsMock = vi.mocked(useFeatureFlags);
const useMediaQueryMock = vi.mocked(useMediaQuery);

const setMobile = (isMobile: boolean) => useMediaQueryMock.mockReturnValue(isMobile);

describe('WorkflowInput (public component — feature-flags + media-query)', () => {
  beforeEach(() => {
    featureFlagsMock.mockReset();
    useMediaQueryMock.mockReset();
    featureFlagsMock.mockReturnValue({} as any); // no flags gate anything by default
    setMobile(false); // desktop by default
  });

  test('renders the Image / Video / Audio segment buttons from the grouped config', async () => {
    renderWithProviders(<WorkflowInput value="txt2img" onChange={vi.fn()} />);

    // Segment buttons are UnstyledButtons with an aria-label = the category name.
    await expect.element(page.getByRole('button', { name: 'Image' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Video' })).toBeInTheDocument();
    // Audio exists (txt2music on the AceAudio ecosystem, no gate active here).
    await expect.element(page.getByRole('button', { name: 'Audio' })).toBeInTheDocument();
  });

  test('the active segment reflects the value prop (video value → Video active, Image not)', async () => {
    renderWithProviders(<WorkflowInput value="txt2vid" onChange={vi.fn()} />);

    // Wait for the segments to mount, then read the active-state class.
    // isActive drives the `bg-blue-0` active class on the matching segment.
    const videoBtn = page.getByRole('button', { name: 'Video' });
    await expect.element(videoBtn).toBeInTheDocument();
    const video = videoBtn.element();
    const image = page.getByRole('button', { name: 'Image' }).element();
    expect(video.className).toContain('bg-blue-0');
    expect(image.className).not.toContain('bg-blue-0');
  });

  test('disabled disables the segment buttons', async () => {
    renderWithProviders(<WorkflowInput value="txt2img" onChange={vi.fn()} disabled />);

    await expect.element(page.getByRole('button', { name: 'Image' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Video' })).toBeDisabled();
  });

  test('narrow screen: a segment opens the full-screen picker for its own category', async () => {
    setMobile(true); // the legacy generator under 768px
    renderWithProviders(<WorkflowInput value="txt2img" onChange={vi.fn()} />);

    await page.getByRole('button', { name: 'Video' }).click();

    await expect
      .element(page.getByRole('dialog', { name: 'Select Video Workflow' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('dialog', { name: 'Select Image Workflow' }))
      .not.toBeInTheDocument();
  });

  test('narrow screen: choosing a workflow reports it and closes the picker', async () => {
    setMobile(true);
    const onChange = vi.fn();
    renderWithProviders(<WorkflowInput value="txt2img" onChange={onChange} />);

    await page.getByRole('button', { name: 'Video' }).click();
    const picker = page.getByRole('dialog', { name: 'Select Video Workflow' });
    await picker.getByText('Image to Video', { exact: true }).first().click();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][2]).toMatch(/^img2vid/);
    await expect.element(picker).not.toBeInTheDocument();
  });

  test('feature-flags mock is wired: an empty (no-gate) flag set keeps default workflows visible', async () => {
    // An empty flag set still leaves the default workflows visible.
    renderWithProviders(<WorkflowInput value="txt2img" onChange={vi.fn()} />);

    await expect.element(page.getByRole('button', { name: 'Image' })).toBeInTheDocument();
    expect(featureFlagsMock).toHaveBeenCalled();
  });
});

describe('SelectedWorkflowDisplay (standalone — label render from props)', () => {
  beforeEach(() => {
    featureFlagsMock.mockReset();
    featureFlagsMock.mockReturnValue({} as any);
  });

  test('renders the workflow label inside the display container for a primary key', async () => {
    renderWithProviders(<SelectedWorkflowDisplay workflowId="txt2img" />);

    // workflowConfigByKey.get('txt2img').label === 'Create Image'
    await expect.element(page.getByText('Create Image', { exact: true })).toBeInTheDocument();
    // The display renders a bordered card container (distinctive `rounded-lg
    // border` root) — used as the presence marker contrasted by the null test.
    expect(document.querySelector('div.rounded-lg.border')).not.toBeNull();
  });

  test('resolves a variant key to its parent workflow label', async () => {
    // 'img2vid:first-last' has variantOf: 'img2vid' → label resolves to the
    // parent 'Image to Video', NOT the variant's own 'First/Last Frame'. Teeth:
    // distinguishes the variant-resolution path from a raw-key lookup.
    renderWithProviders(<SelectedWorkflowDisplay workflowId="img2vid:first-last" />);

    await expect.element(page.getByText('Image to Video', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText('First/Last Frame', { exact: true }))
      .not.toBeInTheDocument();
  });

  test('renders nothing for an unknown workflow id', async () => {
    // Render the unknown-id display next to a sentinel we CAN await — so the
    // assertion runs only after React has flushed (a bare sync querySelector
    // could race the async render and false-pass).
    renderWithProviders(
      <div>
        <span data-testid="sentinel">ready</span>
        <SelectedWorkflowDisplay workflowId="not-a-real-workflow" />
      </div>
    );
    await expect.element(page.getByTestId('sentinel')).toBeInTheDocument();

    // workflowOptionById.get(undefined-resolved) → undefined → component returns
    // null: NO display container is rendered at all (the presence marker the
    // primary-key test asserts is absent here — that's the teeth).
    expect(document.querySelector('div.rounded-lg.border')).toBeNull();
  });
});
