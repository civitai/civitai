// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import {
  ResourceSelectProvider,
  useResourceSelectContext,
} from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';

// ClickUp 868m7fk93: the picker reopened at Relevance + no type filter every time.

const { availabilityMock } = vi.hoisted(() => ({ availabilityMock: vi.fn() }));

vi.mock('~/components/Filters/useSortAvailability', () => ({
  useSortAvailability: availabilityMock,
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ onClose: vi.fn() }),
}));
vi.mock('~/components/UserSettings/hooks', () => ({
  useCurrentUserSettings: () => ({ generation: { advancedMode: false } }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ctx = ReturnType<typeof useResourceSelectContext>;

function mount(props: Partial<ResourceSelectModalProps> = {}) {
  const ref: { current: Ctx | null } = { current: null };
  function Probe() {
    ref.current = useResourceSelectContext();
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        ResourceSelectProvider,
        { onSelect: vi.fn(), selectSource: 'generation', ...props },
        createElement(Probe)
      )
    );
  });
  return {
    ctx: () => ref.current as Ctx,
    unmount: () => act(() => root.unmount()),
  };
}

describe('ResourceSelectProvider persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    availabilityMock.mockReturnValue({ isModerator: false, canViewNsfw: true, showNsfw: true });
  });
  afterEach(() => localStorage.clear());

  it('reopens with the last sort and type filter', () => {
    const first = mount();
    expect(first.ctx().sort).toBe('relevance');
    act(() => {
      first.ctx().setSort('newest');
      first.ctx().setFilters((f) => ({ ...f, types: ['LORA'], baseModels: ['SDXL 1.0'] }));
    });
    expect(first.ctx().filters).toEqual({
      types: ['LORA'],
      baseModels: ['SDXL 1.0'],
      loadedOnly: false,
    });
    first.unmount();

    const second = mount();
    expect(second.ctx().sort).toBe('newest');
    // Base models and the loaded filter are deliberately not persisted: both follow the ecosystem
    // or the moment, not the user's standing preference.
    expect(second.ctx().filters).toEqual({ types: ['LORA'], baseModels: [], loadedOnly: false });
    second.unmount();
  });

  it('falls back to relevance when the stored sort is unavailable or not a sort', () => {
    localStorage.setItem('resource-select-sort', JSON.stringify('newest'));
    availabilityMock.mockReturnValue({ isModerator: false, canViewNsfw: false, showNsfw: false });
    const unavailable = mount();
    expect(unavailable.ctx().sort).toBe('relevance');
    unavailable.unmount();

    localStorage.setItem('resource-select-sort', JSON.stringify('bogus'));
    availabilityMock.mockReturnValue({ isModerator: false, canViewNsfw: true, showNsfw: true });
    const garbage = mount();
    expect(garbage.ctx().sort).toBe('relevance');
    garbage.unmount();
  });

  it('drops stored type values that are not model types', () => {
    localStorage.setItem('resource-select-types', JSON.stringify(['LORA', 'NotAType']));
    const view = mount();
    expect(view.ctx().filters.types).toEqual(['LORA']);
    view.unmount();
  });

  it('does not read or write storage when linking a model version', () => {
    localStorage.setItem('resource-select-sort', JSON.stringify('newest'));
    localStorage.setItem('resource-select-types', JSON.stringify(['LORA']));
    const view = mount({ selectSource: 'modelVersion' });
    expect(view.ctx().sort).toBe('relevance');
    expect(view.ctx().filters.types).toEqual([]);
    act(() => view.ctx().setSort('popularity'));
    expect(view.ctx().sort).toBe('popularity');
    expect(localStorage.getItem('resource-select-sort')).toBe(JSON.stringify('newest'));
    view.unmount();
  });
});
