import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// =============================================================================
// SELECTOR-FORM ZUSTAND STORE MOCK + MODAL-TRIGGER MOCK PATTERN
// =============================================================================
//
// BaseModelInput is the highest-churn generation input (~889 lines). This rung
// pins the PUBLIC `BaseModelInput` component's OWN behaviour and banks two
// reusable mock templates: the SELECTOR-form zustand store mock (the new wrinkle
// vs MetadataExtractionPanel's bare-call store) and the dialogStore modal-trigger
// mock.
//
// SCOPE (be honest): these tests cover the PUBLIC component only —
//   - the trigger button's `readableName` (Select / ecosystem displayName /
//     GROUP displayName / raw-value fallback), derived from `value` + the
//     basemodel constants,
//   - the `disabled` state (button disabled attr; mobile click is a no-op path),
//   - the mobile modal-open wiring (`dialogStore.trigger` called with the
//     BaseModelSelectModal + the expected props) on click,
//   - that selecting a GROUPED value drives `setLastUsedEcosystem(group.id,
//     value)` via the value-change effect. (The selector-form store mock's
//     correctness — that it APPLIES the selector rather than returning a fixed
//     object — is enforced behaviorally: a `mockReturnValue` instead of
//     `mockImplementation((s) => s(STATE))` would hand both selector calls the
//     same object and break the GROUP-displayName + tracking tests — the two
//     that fire the value-change effect.)
// They DO NOT cover the internal sub-components (`BaseModelListContent`,
// `BaseModelSelectModal` which needs `useDialogContext` from a real dialog
// stack, the `TriggerButton` styling), the full ecosystem-list / family-grouping
// / tab / search / recents flow, or the DESKTOP Popover-dropdown content (the
// dropdown is portal-rendered list content out of scope here). Those need the
// dialog stack + the full list machinery — a separate rung.
//
// -----------------------------------------------------------------------------
// (1) SELECTOR-FORM ZUSTAND STORE MOCK  (the new reusable pattern)
// -----------------------------------------------------------------------------
// MetadataExtractionPanel called its store BARE (`useStore()` returns the whole
// state). BaseModelInput instead calls it WITH A SELECTOR:
//   useEcosystemGroupPreferencesStore((s) => s.getLastUsedEcosystem)
//   useEcosystemGroupPreferencesStore((s) => s.setLastUsedEcosystem)
// so the mock must APPLY the selector against a controlled STATE, not return a
// fixed object:
//   vi.mock('~/store/ecosystem-group-preferences.store', () => ({
//     useEcosystemGroupPreferencesStore: vi.fn(),
//   }));
//   // per test:
//   vi.mocked(useEcosystemGroupPreferencesStore).mockImplementation((sel) => sel(STATE));
// where STATE carries the fields the component selects (getLastUsedEcosystem,
// setLastUsedEcosystem). A bare mockReturnValue would return the SAME object for
// both calls and break the selector contract (each call asks for a different
// field), so the selector-applying mockImplementation is required.
//
// -----------------------------------------------------------------------------
// (2) MODAL-TRIGGER MOCK  (dialogStore)
// -----------------------------------------------------------------------------
//   vi.mock('~/components/Dialog/dialogStore', () => ({
//     dialogStore: { trigger: vi.fn(), closeById: vi.fn() },
//   }));
// The MOBILE branch opens the base-model select modal via dialogStore.trigger().
// We assert it's called with { id, component, props } on click. (Desktop opens a
// Mantine Popover via useDisclosure, NOT dialogStore — out of scope here.)
//
// -----------------------------------------------------------------------------
// (3) MOBILE/DESKTOP CONTROL  (@mantine/hooks useMediaQuery)
// -----------------------------------------------------------------------------
// Which branch renders is decided by `useMediaQuery('(max-width: 768px)')`,
// which reads the REAL browser viewport — non-deterministic for a test. We mock
// `@mantine/hooks` via importActual and override ONLY useMediaQuery, keeping the
// real useLocalStorage (real browser localStorage — fine here) and useDisclosure.
// Each test sets isMobile explicitly so the dialogStore-trigger path is reachable
// deterministically.
//
// CAVEATS (so a copier isn't misled):
//   - SELECTOR-ARG TRUST: the store mock APPLIES the real selector against STATE,
//     so reading the WRONG field would surface (selector returns undefined). But
//     getLastUsedEcosystem/setLastUsedEcosystem in STATE are vi.fn()s that ignore
//     their args; the "track the grouped value" contract is pinned by asserting
//     setLastUsedEcosystem's call ARGS (group.id, value), not just that it fired.
//   - `label` PROP IS DEAD: BaseModelInputProps declares `label`, but the public
//     component body never reads it (the trigger shows `readableName` derived from
//     `value`). No test asserts `label` rendering because the component ignores it.
//   - DESKTOP CLICK opens a Popover (useDisclosure state), not dialogStore — only
//     the MOBILE branch is asserted for the modal-trigger contract.
//
// We do NOT mock Mantine core (resolve.dedupe handles dual-React at the scaffold).

vi.mock('~/store/ecosystem-group-preferences.store', () => ({
  useEcosystemGroupPreferencesStore: vi.fn(),
}));

// vi.mock replaces the WHOLE module. The component imports `useDialogContext`
// from DialogProvider, which itself imports `useDialogStore`/`useIsLevelFocused`
// from THIS module — so the mock must re-export those (as no-op stubs) or
// DialogProvider's import fails (same lesson as MetadataExtractionPanel's
// `trpcVanilla` co-export note).
vi.mock('~/components/Dialog/dialogStore', () => ({
  dialogStore: { trigger: vi.fn(), closeById: vi.fn() },
  useDialogStore: vi.fn(() => []),
  useIsLevelFocused: vi.fn(() => true),
}));

vi.mock('@mantine/hooks', async () => {
  const actual = await vi.importActual<typeof import('@mantine/hooks')>('@mantine/hooks');
  return {
    ...actual,
    useMediaQuery: vi.fn(() => false), // default: desktop; overridden per test
  };
});

import { BaseModelInput } from '~/components/generation_v2/inputs/BaseModelInput';
import { useEcosystemGroupPreferencesStore } from '~/store/ecosystem-group-preferences.store';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useMediaQuery } from '@mantine/hooks';

const storeMock = vi.mocked(useEcosystemGroupPreferencesStore);
const triggerMock = vi.mocked(dialogStore.trigger);
const useMediaQueryMock = vi.mocked(useMediaQuery);

// Controlled store STATE. The component selects getLastUsedEcosystem /
// setLastUsedEcosystem off this object via its selector.
const makeState = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    lastUsedEcosystems: {},
    getLastUsedEcosystem: vi.fn(() => undefined),
    setLastUsedEcosystem: vi.fn(),
    ...over,
  } as any);

let state: ReturnType<typeof makeState>;

const setMobile = (isMobile: boolean) => useMediaQueryMock.mockReturnValue(isMobile);

describe('BaseModelInput (public component — selector-store + modal-trigger)', () => {
  beforeEach(() => {
    storeMock.mockReset();
    triggerMock.mockReset();
    useMediaQueryMock.mockReset();
    state = makeState();
    // Selector-FORM mock: apply the component's selector against STATE.
    storeMock.mockImplementation((sel: any) => sel(state));
    setMobile(false); // desktop by default
  });

  test('value=undefined renders the trigger with the "Select" placeholder', async () => {
    renderWithProviders(<BaseModelInput value={undefined} onChange={vi.fn()} />);

    // readableName = 'Select' when there is no value. Trigger is an
    // UnstyledButton whose accessible name is its text content + the "Eco" prefix.
    const btn = page.getByRole('button', { name: /Select/ });
    await expect.element(btn).toBeInTheDocument();
    await expect.element(page.getByText('Select', { exact: true })).toBeInTheDocument();
  });

  test('a known ecosystem value renders its displayName (not the raw key)', async () => {
    // 'SD1' is a standalone ecosystem (no group) -> readableName = eco.displayName.
    renderWithProviders(<BaseModelInput value="SD1" onChange={vi.fn()} />);

    await expect
      .element(page.getByText('Stable Diffusion 1.x', { exact: true }))
      .toBeInTheDocument();
    // The raw key must NOT be what's shown.
    await expect.element(page.getByText('SD1', { exact: true })).not.toBeInTheDocument();
  });

  test('a grouped ecosystem value renders the GROUP displayName (group beats eco)', async () => {
    // 'WanVideo-25-T2V' is part of the WanVideo group. readableName resolves to
    // the GROUP displayName ('Wan Video'), NOT the ecosystem's own displayName
    // ('Wan Video 2.5 T2V') — teeth: distinguishes the group path from the eco path.
    renderWithProviders(<BaseModelInput value="WanVideo-25-T2V" onChange={vi.fn()} />);

    await expect.element(page.getByText('Wan Video', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText('Wan Video 2.5 T2V', { exact: true }))
      .not.toBeInTheDocument();
  });

  test('an unknown value falls back to rendering the raw value string', async () => {
    // ecosystemByKey.get('not-a-real-eco') is undefined -> readableName = value.
    renderWithProviders(<BaseModelInput value="not-a-real-eco" onChange={vi.fn()} />);

    await expect.element(page.getByText('not-a-real-eco', { exact: true })).toBeInTheDocument();
  });

  test('disabled disables the trigger button', async () => {
    renderWithProviders(<BaseModelInput value="SD1" onChange={vi.fn()} disabled />);

    const btn = page.getByRole('button', { name: /Stable Diffusion 1\.x/ });
    await expect.element(btn).toBeDisabled();
  });

  test('mobile: clicking the trigger opens the base-model modal via dialogStore.trigger', async () => {
    setMobile(true); // force the mobile branch (dialogStore path)
    renderWithProviders(<BaseModelInput value="SD1" onChange={vi.fn()} />);

    await page.getByRole('button', { name: /Stable Diffusion 1\.x/ }).click();

    expect(triggerMock).toHaveBeenCalledTimes(1);
    const [arg] = triggerMock.mock.calls.at(-1)!;
    expect((arg as any).id).toBe('basemodel-select');
    // Opens the BaseModelSelectModal component with the current value + handlers.
    expect((arg as any).component).toBeDefined();
    expect((arg as any).props.value).toBe('SD1');
    expect(typeof (arg as any).props.onSelect).toBe('function');
  });

  test('selecting a grouped value tracks it via setLastUsedEcosystem(group.id, value)', async () => {
    // The value-change effect: for a value whose ecosystem belongs to a group,
    // the component calls setLastUsedEcosystem(group.id, value). 'WanVideo-25-T2V'
    // is in the 'WanVideo' group -> setLastUsedEcosystem('WanVideo','WanVideo-25-T2V').
    renderWithProviders(<BaseModelInput value="WanVideo-25-T2V" onChange={vi.fn()} />);

    await vi.waitFor(() =>
      expect(state.setLastUsedEcosystem).toHaveBeenCalledWith('WanVideo', 'WanVideo-25-T2V')
    );
  });
});
