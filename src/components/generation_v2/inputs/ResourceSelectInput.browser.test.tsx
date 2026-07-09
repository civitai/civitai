import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// =============================================================================
// CONTEXT-HOOK MOCK PATTERN  (the 4th reusable mock pattern)
// =============================================================================
//
// ResourceSelectInput is the first generation input that consumes a REQUIRED
// React context: `useResourceDataContext()` THROWS ("must be used within a
// ResourceDataProvider") when the context is null. A bare render therefore
// crashes — that crash is the whole point of this rung.
//
// Two ways to satisfy the requirement:
//   (a) wrap the unit in the REAL <ResourceDataProvider> — but that drags in the
//       provider's zustand resource-data store + batched requestResourceIds()
//       fetch machinery, and gives us no handle to drive getResourceData(id) or
//       to assert register/unregister were called.
//   (b) MOCK the provider module's hooks (chosen) — mirrors the zustand-store
//       mock from MetadataExtractionPanel: replace the hooks with vi.fn()s,
//       return a FULL controlled context value, and drive per test via
//       vi.mocked(useResourceDataContext).mockReturnValue({...}). This isolates
//       the component's OWN logic (value->card render, register lifecycle,
//       remove/clear handler, modal trigger) from the provider's data layer.
//
// REUSABLE TEMPLATE for the next context-backed component:
//   vi.mock('./ResourceDataProvider', () => ({
//     useResourceDataContext: vi.fn(() => makeContext()),  // throws-if-null hook
//     useResourceData: vi.fn(() => ({ data: undefined, isLoading: false })),
//   }));
//   // per test:
//   vi.mocked(useResourceDataContext).mockReturnValue(makeContext({ ... }));
//   vi.mocked(useResourceData).mockReturnValue({ data: RESOURCE, isLoading: false });
//
// IMPORTANT: the component imports BOTH `useResourceDataContext` (for register/
// unregister/getResourceData) AND `useResourceData` (for the display fetch).
// `useResourceData` is itself a thin wrapper around the context in production,
// but the component calls it directly, so we mock it as its own hook (otherwise
// the real `useResourceData` would call the mocked `useResourceDataContext` and
// return getResourceData(value.id) — workable, but mocking it directly gives
// each test explicit control over the displayed resource). The mock SHAPE must
// match what the component reads: context = { registerResourceId,
// unregisterResourceId, getResourceData } and useResourceData = { data, isLoading }.
//
// CAVEATS (so a copier of this template isn't misled):
//   - ARG-IGNORING MOCKS: `useResourceData(id)` and `getResourceData(id)` are
//     vi.fn()s that return their stubbed value REGARDLESS of the id passed (like
//     MetadataExtractionPanel's tRPC `enabled` caveat). So the fetch-WITH-THE-
//     RIGHT-ID contract is pinned ONLY where a test asserts the call args
//     (`useResourceData` toHaveBeenCalledWith(value.id) in the card test;
//     getResourceData toHaveBeenCalledWith(versionId) in the version-switch
//     test). A component reading the WRONG id would otherwise still "work" here.
//   - SCOPE: mocking the hooks BYPASSES the real ResourceDataProvider entirely —
//     its reference-counted register/unregister Map, the batched
//     requestResourceIds() fetch, the zustand store sync, and needsHydration()
//     hydration of partial values are NOT covered. And the fixtures are hand-
//     built `as any`, so nothing ENFORCES that their shape matches the real
//     GenerationResource / ResourceDataContextValue (a drift wouldn't fail here).
//     A real-provider integration test is a separate rung.
//   - importActual HELPERS: only `getResourceStatus` is meaningfully exercised
//     (it runs in the card render path — making it throw breaks the card tests);
//     `isResourceDisabled`/`getStatusClasses` are kept real to avoid divergence
//     but their output renders inside the stubbed ResourceItemContent, so no test
//     asserts it (mutating isResourceDisabled leaves the suite green).
//
// We also mock the modal trigger: `openResourceSelectModal` would otherwise push
// a real (dynamically-imported) dialog onto dialogStore when the select/swap
// button is clicked. A vi.fn() lets us assert the click wires through without
// standing up the dialog system.
//
// And we stub `./ResourceItemContent` thin (same justification as
// MetadataExtractionPanel): the real one pulls in useAppContext (AppProvider) +
// EdgeMedia2 + CurrencyBadge + NumberSlider. Stubbing it keeps the test about
// ResourceSelectInput's OWN render branches (which card shows, which actions are
// passed) without standing up the app-context provider stack. The stub surfaces
// the resource id + the model name + the `actions` node so the card branch, the
// per-resource mapping, and the remove/swap buttons stay observable.
//
// We do NOT mock Mantine (resolve.dedupe handles dual-React at the scaffold).

vi.mock('./ResourceDataProvider', () => ({
  useResourceDataContext: vi.fn(),
  useResourceData: vi.fn(),
}));

vi.mock('~/components/Dialog/triggers/resource-select', () => ({
  openResourceSelectModal: vi.fn(),
}));

vi.mock('./ResourceItemContent', async () => {
  const actual = await vi.importActual<typeof import('./ResourceItemContent')>(
    './ResourceItemContent'
  );
  return {
    // Keep the real pure helpers (getResourceStatus/getStatusClasses/
    // isResourceDisabled) — ResourceSelectInput imports them and they're pure
    // logic, not heavy deps. Only the heavy *component* is stubbed.
    ...actual,
    ResourceItemContent: ({
      resource,
      actions,
    }: {
      resource: { id: number; model: { name: string } };
      actions: React.ReactNode;
    }) => (
      <div data-testid="resource-item" data-resource-id={resource.id}>
        <span data-testid="resource-name">{resource.model.name}</span>
        {actions}
      </div>
    ),
  };
});

import { ResourceSelectInput } from '~/components/generation_v2/inputs/ResourceSelectInput';
import { useResourceDataContext, useResourceData } from './ResourceDataProvider';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';

const contextMock = vi.mocked(useResourceDataContext);
const useResourceDataMock = vi.mocked(useResourceData);
const openModalMock = vi.mocked(openResourceSelectModal);

// Full controlled context value (every field the component reads). Override
// getResourceData per test to return controlled resource data by id.
const makeContext = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    registerResourceId: vi.fn(),
    unregisterResourceId: vi.fn(),
    getResourceData: vi.fn(() => undefined),
    resources: [],
    isLoading: false,
    isResourceLoading: vi.fn(() => false),
    ...over,
  } as any);

// `useResourceData` returns { data, isLoading }; default = nothing fetched.
const useResourceDataResult = (
  over: Partial<{ data: unknown; isLoading: boolean }> = {}
) => ({ data: undefined, isLoading: false, ...over } as any);

// A faithful, fully-hydrated GenerationResource (has model + name, so
// needsHydration() is false and the component can render it directly).
const makeResource = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 555,
    name: 'v1.0',
    trainedWords: [],
    baseModel: 'SD1',
    canGenerate: true,
    hasAccess: true,
    minStrength: -1,
    maxStrength: 2,
    strength: 1,
    air: 'urn:air:sd1:checkpoint:civitai:1@555',
    model: { id: 42, name: 'My Cool Model', type: 'Checkpoint' as const },
    ...over,
  } as any);

describe('ResourceSelectInput (required-context-backed)', () => {
  beforeEach(() => {
    contextMock.mockReset();
    useResourceDataMock.mockReset();
    openModalMock.mockReset();
    // Sane defaults: a valid context (so the hook doesn't throw) and no
    // fetched resource data. Individual tests override.
    contextMock.mockReturnValue(makeContext());
    useResourceDataMock.mockReturnValue(useResourceDataResult());
  });

  test('empty value renders the add-resource button (empty/add state)', async () => {
    renderWithProviders(<ResourceSelectInput value={undefined} onChange={vi.fn()} />);

    // !value branch -> the Button labeled by buttonLabel (default 'Add Resource').
    await expect
      .element(page.getByRole('button', { name: 'Add Resource', exact: true }))
      .toBeInTheDocument();
    // No resource card in the empty state.
    await expect.element(page.getByTestId('resource-item')).not.toBeInTheDocument();
  });

  test('clicking the add button opens the resource-select modal', async () => {
    renderWithProviders(
      <ResourceSelectInput value={undefined} onChange={vi.fn()} buttonLabel="Pick a model" />
    );

    await page.getByRole('button', { name: 'Pick a model', exact: true }).click();

    expect(openModalMock).toHaveBeenCalledTimes(1);
    // handleOpenResourceSearch passes title/onSelect/options/selectSource.
    const [arg] = openModalMock.mock.calls.at(-1)!;
    expect((arg as any).title).toBe('Pick a model'); // modalTitle ?? buttonLabel
    expect(typeof (arg as any).onSelect).toBe('function');
    expect((arg as any).selectSource).toBe('generation');
  });

  test('a selected resource (from useResourceData) renders its card + model name', async () => {
    const resource = makeResource({ model: { id: 42, name: 'My Cool Model', type: 'Checkpoint' } });
    useResourceDataMock.mockReturnValue(useResourceDataResult({ data: resource }));

    renderWithProviders(
      <ResourceSelectInput value={{ id: 555 }} onChange={vi.fn()} />
    );

    // resourceData = fetchedData -> ResourceCard -> (stubbed) ResourceItemContent.
    await expect.element(page.getByTestId('resource-item')).toBeInTheDocument();
    await expect.element(page.getByText('My Cool Model', { exact: true })).toBeInTheDocument();
    // useResourceData was driven with the value's id (the display-fetch contract).
    expect(useResourceDataMock).toHaveBeenCalledWith(555);
  });

  test('value with no fetched data + needs hydration renders the loading skeleton', async () => {
    // value is a minimal {id} (needsHydration true) and useResourceData returns
    // no data -> resourceData is undefined -> the skeleton branch, NOT the card.
    useResourceDataMock.mockReturnValue(useResourceDataResult({ data: undefined }));

    renderWithProviders(<ResourceSelectInput value={{ id: 999 }} onChange={vi.fn()} />);

    // No card rendered...
    await expect.element(page.getByTestId('resource-item')).not.toBeInTheDocument();
    // ...the ResourceCardSkeleton uses Mantine <Skeleton> elements (no role/text,
    // so query the live DOM for the Mantine Skeleton class).
    await vi.waitFor(() =>
      expect(document.querySelector('.mantine-Skeleton-root')).not.toBeNull()
    );
  });

  test('remove (X) handler calls onChange(undefined)', async () => {
    const resource = makeResource();
    useResourceDataMock.mockReturnValue(useResourceDataResult({ data: resource }));
    const onChange = vi.fn();

    renderWithProviders(
      <ResourceSelectInput value={{ id: 555 }} onChange={onChange} allowRemove />
    );

    // The remove control is the LegacyActionIcon (an icon button) inside the
    // card actions, now named via aria-label="Remove resource" (a real a11y fix
    // — it was a nameless icon button) so we select it by accessible name
    // instead of a brittle "the button that isn't Swap" heuristic.
    await expect.element(page.getByTestId('resource-item')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Remove resource', exact: true }).click();

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  test('clicking Swap opens the resource-select modal (swap = re-search)', async () => {
    const resource = makeResource();
    useResourceDataMock.mockReturnValue(useResourceDataResult({ data: resource }));

    renderWithProviders(
      <ResourceSelectInput value={{ id: 555 }} onChange={vi.fn()} allowSwap />
    );

    await page.getByRole('button', { name: 'Swap', exact: true }).click();

    // onSwap === handleOpenResourceSearch -> opens the modal.
    expect(openModalMock).toHaveBeenCalledTimes(1);
  });

  test('versions prop registers each version id for pre-fetch (effect lifecycle)', async () => {
    const ctx = makeContext();
    contextMock.mockReturnValue(ctx);
    // value matches a version id so the component renders (card path) AND the
    // register effect runs for all version ids.
    const resource = makeResource({ id: 100 });
    useResourceDataMock.mockReturnValue(useResourceDataResult({ data: resource }));

    renderWithProviders(
      <ResourceSelectInput
        value={{ id: 100 }}
        onChange={vi.fn()}
        versions={[
          { label: 'A', value: 100 },
          { label: 'B', value: 200 },
        ]}
      />
    );

    // The register effect fires after mount (async-committed), so poll.
    // NOTE: the component calls `versionIds.forEach(registerResourceId)`, so the
    // callback receives forEach's (value, index, array) — assert the FIRST arg of
    // each call rather than toHaveBeenCalledWith(id) (which would require an exact
    // single-arg match and fail on the index/array extras).
    await vi.waitFor(() => {
      const firstArgs = ctx.registerResourceId.mock.calls.map((c: unknown[]) => c[0]);
      expect(firstArgs).toContain(100);
      expect(firstArgs).toContain(200);
    });
  });

  test('clicking a version segment resolves it via getResourceData and emits via onChange', async () => {
    // The version-switch CONTRACT — the whole reason the component reads
    // getResourceData from context: clicking a version segment looks up that
    // version's resource via getResourceData(numericId) and emits it through
    // onChange. This drives the context mock's getResourceData and asserts the result.
    const v200 = makeResource({
      id: 200,
      model: { id: 7, name: 'Version Two', type: 'Checkpoint' as const },
    });
    const getResourceData = vi.fn((id: number) => (id === 200 ? v200 : undefined));
    contextMock.mockReturnValue(makeContext({ getResourceData }));
    useResourceDataMock.mockReturnValue(useResourceDataResult({ data: makeResource({ id: 100 }) }));
    const onChange = vi.fn();

    renderWithProviders(
      <ResourceSelectInput
        value={{ id: 100 }}
        onChange={onChange}
        versions={[
          { label: 'Ver A', value: 100 },
          { label: 'Ver B', value: 200 },
        ]}
      />
    );

    // value.id 100 is one of the versions -> the segmented selector renders.
    await page.getByRole('button', { name: 'Ver B', exact: true }).click();

    expect(getResourceData).toHaveBeenCalledWith(200);
    expect(onChange).toHaveBeenCalledWith(v200);
  });
});
