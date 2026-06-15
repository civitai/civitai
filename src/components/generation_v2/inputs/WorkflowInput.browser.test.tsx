import type React from 'react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// =============================================================================
// FEATURE-FLAGS HOOK MOCK + dialogStore MODAL-TRIGGER + useMediaQuery PATTERN
// =============================================================================
//
// WorkflowInput is the #2 highest-churn generation input (~754 lines). This rung
// pins the PUBLIC `WorkflowInput` + the standalone `SelectedWorkflowDisplay`
// OWN behaviour and banks a NEW reusable mock template — the feature-flags hook
// (`useFeatureFlags`) — alongside the already-banked dialogStore modal-trigger
// and `@mantine/hooks` useMediaQuery overrides (from BaseModelInput).
//
// SCOPE (be honest): these tests cover ONLY the public surface —
//   - `WorkflowInput` renders the Image/Video/Audio SEGMENT buttons (derived
//     from the real grouped-workflow config, not from props),
//   - the active-segment reflects the `value` prop (Video active for a video
//     `value`, Image not),
//   - the `disabled` state (segment buttons get the disabled attr),
//   - the MOBILE modal-open wiring: clicking a segment calls
//     `dialogStore.trigger` with the per-segment `{ id, component, props }`
//     (id distinguishes image vs video — teeth),
//   - `SelectedWorkflowDisplay` renders the workflow label from props, resolves
//     a variant key to its parent label, and returns null for an unknown id,
//   - the feature-flags mock is wired and a passthrough (no-flag-gated) flag set
//     keeps the default workflows visible.
// They DO NOT cover the internal sub-components: `WorkflowListContent`,
// `WorkflowSelectModal` (needs `useDialogContext` from a real dialog stack), the
// DESKTOP Popover-dropdown content (portal-rendered list — out of scope), the
// `WorkflowMenuItem` gate/membership branches, or the category/group machinery.
// Those need the dialog stack + the full list renderer — a separate rung.
//
// -----------------------------------------------------------------------------
// (1) FEATURE-FLAGS HOOK MOCK  (the NEW reusable pattern)
// -----------------------------------------------------------------------------
//   vi.mock('~/providers/FeatureFlagsProvider', () => ({
//     useFeatureFlags: vi.fn(() => ({ /* only the flags the component reads */ })),
//   }));
//   // per test override:  vi.mocked(useFeatureFlags).mockReturnValue({ ...flags })
// The component calls `useFeatureFlags()` UNCONDITIONALLY and passes the result
// into `filterWorkflowsByFeatureFlags(grouped, features)` — which drops a
// workflow whose `featureFlag` config key is not `true` for this user. The hook
// itself throws unless rendered inside FeatureFlagsCtx, so the mock is REQUIRED
// just to render the component network-free.
// CAVEAT — PARTIAL FLAG SET: the hook's real return type is the full
// `FeatureAccess` record; the mock returns only an empty/partial object. That is
// SHAPE-FAITHFUL for what THIS component reads, because no workflow in the live
// config currently sets a `featureFlag` (verified: 0 `featureFlag:` keys in
// config/workflows.ts), so `filterWorkflowsByFeatureFlags` is a passthrough and
// the empty flag set drops nothing. We therefore pin the WIRING + PASSTHROUGH
// (default workflows survive an empty flag set) rather than a flag-hides-a-
// workflow branch — there is no live config to exercise that branch with teeth.
//
// -----------------------------------------------------------------------------
// (2) GENERATION-CONFIG HOOK MOCK  (gateRules source)
// -----------------------------------------------------------------------------
// `WorkflowListContent` + the public component read `useGenerationConfig().
// gateRules` (a tRPC-backed hook). We mock `generation.utils` so the hook
// returns `{ gateRules: [] }` deterministically — no gate filtering, no tRPC
// client needed. (The scaffold is network-free; mocking the hook is cheaper than
// standing up a trpc provider.)
//
// -----------------------------------------------------------------------------
// (3) MODAL-TRIGGER MOCK  (dialogStore)
// -----------------------------------------------------------------------------
//   vi.mock('~/components/Dialog/dialogStore', () => ({
//     dialogStore: { trigger: vi.fn(), closeById: vi.fn() },
//     useDialogStore: vi.fn(() => []),
//     useIsLevelFocused: vi.fn(() => true),
//   }));
// The MOBILE branch opens the workflow-select modal via dialogStore.trigger().
// vi.mock replaces the WHOLE module; the component imports `useDialogContext`
// from DialogProvider, which imports `useDialogStore`/`useIsLevelFocused` from
// THIS module — so the mock must re-export those stubs or DialogProvider's module
// load fails (same lesson as BaseModelInput).
//
// -----------------------------------------------------------------------------
// (4) MOBILE/DESKTOP CONTROL  (@mantine/hooks useMediaQuery)
// -----------------------------------------------------------------------------
// `useMediaQuery('(max-width: 768px)')` reads the REAL viewport — non-
// deterministic. We importActual @mantine/hooks and override ONLY useMediaQuery
// (keeping real useDisclosure). DEFAULT is desktop (false); the mobile
// dialogStore-trigger path is only reachable after forcing mobile — the
// BaseModelInput lesson.
//
// CAVEATS (so a copier isn't misled):
//   - ARG-IGNORING MOCKS: useFeatureFlags / useGenerationConfig return fixed
//     objects ignoring their (no) args; we trust them only for the flag/gate
//     SHAPE the component reads.
//   - `WorkflowInput` shows NO label text — it renders only icon segment buttons
//     (accessible name via aria-label "Image"/"Video"/"Audio"). The workflow
//     LABEL text is `SelectedWorkflowDisplay`'s job (a separate exported comp).
//   - DESKTOP click opens a Mantine Popover (useDisclosure), NOT dialogStore —
//     only the MOBILE branch is asserted for the trigger contract.
//
// We do NOT mock Mantine core (resolve.dedupe handles dual-React at the scaffold).

vi.mock('~/components/Dialog/dialogStore', () => ({
  dialogStore: { trigger: vi.fn(), closeById: vi.fn() },
  useDialogStore: vi.fn(() => []),
  useIsLevelFocused: vi.fn(() => true),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: vi.fn(() => ({})),
}));

vi.mock('~/components/ImageGeneration/GenerationForm/generation.utils', () => ({
  useGenerationConfig: vi.fn(() => ({ gateRules: [] })),
}));

// `RequireMembership` + `SupportButton` are only used inside `WorkflowMenuItem`
// (the member-only upsell branch — OUT OF SCOPE here, never rendered by these
// tests). Their real module graphs reach `~/server/...` → `@prisma/client`,
// whose generated `.prisma/client/index-browser` shim is not built in this
// worktree, so the dep-optimizer fails at BUNDLE time (regardless of whether the
// code runs). We stub both at the boundary to sever that chain. This is the
// "mock the offending import at the boundary" path — no `prisma generate` needed
// (which would leak the tracked `src/shared/utils/prisma/models.ts`).
vi.mock('~/components/RequireMembership/RequireMembership', () => ({
  RequireMembership: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('~/components/SupportButton/SupportButton', () => ({
  SupportButtonPolymorphic: ({ children }: { children: React.ReactNode }) => children,
}));

// Belt-and-suspenders: nothing in the public-component path calls `trpc.*`
// directly (generation.utils is mocked above), but a transitively-imported real
// module can still pull `~/utils/trpc` at runtime; mocking the trpc proxy keeps
// that runtime path inert.
//
// NOTE — Prisma & the optimizeDeps pre-scan: `vi.mock` only affects RUNTIME
// resolution. Vite's dependency PRE-SCAN still walks the static import graph and
// bundles `@prisma/client` (reached via the gate/membership sub-components +
// server-router types), which `require`s `.prisma/client/index-browser`. So
// `vi.mock`/boundary stubs do NOT remove that scan — `.prisma/client/index-
// browser` must merely RESOLVE. In CI it does (the typecheck install runs
// `prisma generate`, same as the unit task). On a Prisma-less local box (NixOS,
// where `prisma generate` 404s) you need either a generated client or a tiny
// git-ignored `node_modules/.prisma/client/index-browser.js` shim. The empty
// shim is a local aid only — the real CI client satisfies the identical scan
// (audit-verified: passes with a realistic generated client too).
vi.mock('~/utils/trpc', () => ({
  trpc: {},
}));

vi.mock('@mantine/hooks', async () => {
  const actual = await vi.importActual<typeof import('@mantine/hooks')>('@mantine/hooks');
  return {
    ...actual,
    useMediaQuery: vi.fn(() => false), // default: desktop; overridden per test
  };
});

import {
  WorkflowInput,
  SelectedWorkflowDisplay,
} from '~/components/generation_v2/inputs/WorkflowInput';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useMediaQuery } from '@mantine/hooks';

const featureFlagsMock = vi.mocked(useFeatureFlags);
const triggerMock = vi.mocked(dialogStore.trigger);
const useMediaQueryMock = vi.mocked(useMediaQuery);

const setMobile = (isMobile: boolean) => useMediaQueryMock.mockReturnValue(isMobile);

describe('WorkflowInput (public component — feature-flags + dialogStore + media-query)', () => {
  beforeEach(() => {
    featureFlagsMock.mockReset();
    triggerMock.mockReset();
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

  test('mobile: clicking Image opens the image-workflow modal via dialogStore.trigger', async () => {
    setMobile(true); // force the mobile branch (dialogStore path)
    renderWithProviders(<WorkflowInput value="txt2img" onChange={vi.fn()} />);

    await page.getByRole('button', { name: 'Image' }).click();

    expect(triggerMock).toHaveBeenCalledTimes(1);
    const [arg] = triggerMock.mock.calls.at(-1)!;
    expect((arg as any).id).toBe('workflow-select-image');
    expect((arg as any).component).toBeDefined();
    expect((arg as any).props.title).toBe('Select Image Workflow');
    expect(typeof (arg as any).props.onSelect).toBe('function');
  });

  test('mobile: clicking Video opens the video-workflow modal (distinct trigger id/title)', async () => {
    setMobile(true);
    renderWithProviders(<WorkflowInput value="txt2img" onChange={vi.fn()} />);

    await page.getByRole('button', { name: 'Video' }).click();

    expect(triggerMock).toHaveBeenCalledTimes(1);
    const [arg] = triggerMock.mock.calls.at(-1)!;
    expect((arg as any).id).toBe('workflow-select-video');
    expect((arg as any).props.title).toBe('Select Video Workflow');
  });

  test('feature-flags mock is wired: an empty (no-gate) flag set keeps default workflows visible', async () => {
    // Passthrough proof: useFeatureFlags returns {} → filterWorkflowsByFeatureFlags
    // drops nothing (no workflow sets a featureFlag), so all segments still render.
    // Asserting the mock is invoked pins the dependency wiring.
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
