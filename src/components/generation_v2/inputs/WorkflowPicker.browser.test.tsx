import type * as MantineHooks from '@mantine/hooks';
import type * as MobileGeneratorModule from '~/hooks/useMobileGenerator';
import type { ReactNode } from 'react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// Mock notes:
// - `useFeatureFlags` throws outside FeatureFlagsCtx, so it is mocked to {}: every workflow with a
//   `featureFlag` is filtered out.
// - `useGenerationConfig` is mocked to `{ gateRules: [] }` so no tRPC client is needed.
// - Which surface opens depends on media queries over the real viewport, so `@mantine/hooks` is
//   mocked via importActual with only useMediaQuery overridden. `setMobile(true)` makes every query
//   match. Which surface opens where is PopoverOrSheet's own test.

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

// The mobile generator's layout needs its flag and a phone, which the test browser isn't; a test
// that wants it sets it here.
let phoneLayout = false;
vi.mock('~/hooks/useMobileGenerator', async (importOriginal) => {
  const actual = await importOriginal<typeof MobileGeneratorModule>();
  return {
    ...actual,
    useGeneratorLayout: () => (phoneLayout ? 'mobile' : actual.useGeneratorLayout()),
  };
});

vi.mock('@mantine/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineHooks>()),
  useMediaQuery: vi.fn(() => false), // default: desktop; overridden per test
}));

import { WorkflowPicker } from '~/components/generation_v2/inputs/WorkflowPicker';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useMediaQuery } from '@mantine/hooks';
import { workflowConfigByKey } from '~/shared/generation/config/workflows';

const featureFlagsMock = vi.mocked(useFeatureFlags);
const useMediaQueryMock = vi.mocked(useMediaQuery);

const setMobile = (isMobile: boolean) => useMediaQueryMock.mockReturnValue(isMobile);

describe('WorkflowPicker (the workflow card)', () => {
  beforeEach(() => {
    featureFlagsMock.mockReset();
    featureFlagsMock.mockReturnValue({} as any);
    useMediaQueryMock.mockReset();
    setMobile(false);
    phoneLayout = false;
  });

  test('the card names the workflow, and a pick from another category reports it and closes', async () => {
    const onChange = vi.fn();
    renderWithProviders(<WorkflowPicker value="txt2img" onChange={onChange} />);

    await page.getByRole('button', { name: /Workflow: Create Image/ }).click();
    await expect.element(page.getByText('Draft', { exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'Video' }).click();
    await page.getByText('Image to Video', { exact: true }).click();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('img2vid', expect.any(Array), 'img2vid');
    await expect.element(page.getByText('Image to Video', { exact: true })).not.toBeInTheDocument();
  });

  const description = () => workflowConfigByKey.get('txt2img')!.description!;

  test('off a phone the card says what the workflow does, and tags its category', async () => {
    renderWithProviders(<WorkflowPicker value="txt2img" />);
    await expect.element(page.getByText(description(), { exact: true })).toBeVisible();
    await expect.element(page.getByText('Image', { exact: true })).toBeVisible();
  });

  test('on a phone the card names the category instead', async () => {
    phoneLayout = true;
    renderWithProviders(<WorkflowPicker value="txt2img" />);
    await expect.element(page.getByText('Image workflow', { exact: true })).toBeVisible();
    await expect.element(page.getByText(description(), { exact: true })).not.toBeInTheDocument();
  });

  test("opens on the current workflow's category, every time", async () => {
    renderWithProviders(<WorkflowPicker value="txt2vid" onChange={vi.fn()} />);
    const card = page.getByRole('button', { name: /Change workflow/ });

    await card.click();
    await expect.element(page.getByText('Image to Video', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Draft', { exact: true })).not.toBeInTheDocument();

    // A tab left on another category doesn't carry over to the next opening.
    await page.getByRole('radio', { name: 'Image' }).click();
    await expect.element(page.getByText('Draft', { exact: true })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByText('Draft', { exact: true })).not.toBeInTheDocument();
    await card.click();
    await expect.element(page.getByText('Image to Video', { exact: true })).toBeVisible();
  });

  test('Change toggles the picker: a second click closes it', async () => {
    renderWithProviders(<WorkflowPicker value="txt2img" onChange={vi.fn()} />);
    const change = page.getByRole('button', { name: /Change workflow/ });

    await change.click();
    await expect.element(page.getByText('Draft', { exact: true })).toBeVisible();
    await change.click();
    await expect.element(page.getByText('Draft', { exact: true })).not.toBeInTheDocument();
  });

  test('narrow screen: it opens the full-screen picker, and a pick reports it and closes', async () => {
    setMobile(true); // the legacy generator under 768px
    const onChange = vi.fn();
    renderWithProviders(<WorkflowPicker value="txt2vid" onChange={onChange} />);

    await page.getByRole('button', { name: /Change workflow/ }).click();
    const picker = page.getByRole('dialog', { name: 'Choose a workflow' });
    await picker.getByText('Image to Video', { exact: true }).first().click();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][2]).toMatch(/^img2vid/);
    await expect.element(picker).not.toBeInTheDocument();
  });

  test('the back arrow shows only with onBack, and calls it', async () => {
    const onBack = vi.fn();
    renderWithProviders(
      <>
        <div data-testid="without">
          <WorkflowPicker value="txt2img" />
        </div>
        <WorkflowPicker value="txt2img" onBack={onBack} />
      </>
    );
    const without = page.getByTestId('without');
    await expect.element(without.getByRole('button', { name: /Change workflow/ })).toBeVisible();
    await expect
      .element(without.getByRole('button', { name: 'Back to previous workflow' }))
      .not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Back to previous workflow' }).click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
