import { createContext, useContext, useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type {
  ResourceFilter,
  ResourceSelectOptions,
  ResourceSelectSource,
  ResourceSort,
  Tabs,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import { useStorage } from '~/hooks/useStorage';
import type { GenerationResource } from '~/shared/types/generation.types';

const defaultTab: Tabs = 'all';

/**
 * Which of the picker's jobs this instance is doing. Left undefined the modal
 * behaves exactly as it always has — every consumer outside the form-graph
 * generation form passes nothing.
 *
 * `checkpoint` drops the per-card version dropdown: the version is a field under
 * the model row in the form, not part of the pick.
 * `resource` judges each card against the checkpoint's ecosystem and, when the
 * caller supplies `onSelectMultiple`, collects several picks before committing.
 */
export type ResourceSelectRole = 'checkpoint' | 'resource';

export type ResourceSelectModalProps = {
  title?: React.ReactNode;
  onSelect: (value: GenerationResource) => void;
  onClose?: () => void;
  options?: ResourceSelectOptions;
  selectSource?: ResourceSelectSource;
  role?: ResourceSelectRole;
  /** Enables multi-select. Called once with everything picked. */
  onSelectMultiple?: (values: GenerationResource[]) => void;
  /** Cap on a multi-select batch — the form's remaining slots. */
  limit?: number;
  /**
   * Slots. The modal knows nothing about what goes in them — the form-graph
   * generation form fills them with an ecosystem rail and a consequence footer,
   * which is why neither concept appears in this file.
   *
   * Components, not nodes: they render INSIDE the provider, so a rail can aim
   * the catalog at a pending ecosystem via `setOptionsOverride`.
   */
  rail?: React.ComponentType;
  footer?: React.ComponentType;
};

type ResourceSelectState = Omit<
  ResourceSelectModalProps,
  'options' | 'selectSource' | 'onSelectMultiple'
> & {
  selectSource: ResourceSelectSource;
  canGenerate?: boolean;
  excludedIds: number[];
  /**
   * Lets a rail re-aim the catalog at an ecosystem the user is considering but
   * has not committed to. Null restores the options the modal was opened with.
   */
  optionsOverride: ResourceSelectOptions | null;
  setOptionsOverride: (options: ResourceSelectOptions | null) => void;
  multiSelect: boolean;
  staged: GenerationResource[];
  addStaged: (value: GenerationResource) => void;
  removeStaged: (id: number) => void;
  isStaged: (id: number) => boolean;
  commitStaged: () => void;
  resources: DeepRequired<ResourceSelectOptions>['resources'];
  tab: Tabs;
  setTab: React.Dispatch<React.SetStateAction<Tabs>>;
  filters: ResourceFilter;
  setFilters: React.Dispatch<React.SetStateAction<ResourceFilter>>;
  sort: ResourceSort;
  setSort: React.Dispatch<React.SetStateAction<ResourceSort>>;
  categoryTag?: string;
  setCategoryTag: React.Dispatch<React.SetStateAction<string | undefined>>;
};

const ResourceSelectContext = createContext<ResourceSelectState | null>(null);
export const useResourceSelectContext = () => {
  const context = useContext(ResourceSelectContext);
  if (!context) throw new Error('missing ResourceSelectContext');
  return context;
};

export function ResourceSelectProvider({
  children,
  ...props
}: { children: React.ReactNode } & ResourceSelectModalProps) {
  const dialog = useDialogContext();
  const { generation } = useCurrentUserSettings();
  const selectSource = props.selectSource ?? 'generation';

  // For modelVersion linking, start on the 'official' tab (and don't persist):
  // linking a canonical component is the intended path, and the persisted tab
  // ('recent'/'liked') depends on data that's often empty for new uploads.
  const persistTab = selectSource !== 'modelVersion';
  const [storedTab, setStoredTab] = useStorage<Tabs>({
    type: 'localStorage',
    key: 'resource-select-tab',
    defaultValue: defaultTab,
    getInitialValueInEffect: false,
  });
  const [localTab, setLocalTab] = useState<Tabs>(
    selectSource === 'modelVersion' ? 'official' : defaultTab
  );
  // useStorage's value widens to `Tabs | undefined`; fall back to the default so
  // the context always exposes a concrete tab.
  const tab = (persistTab ? storedTab : localTab) ?? defaultTab;
  const setTab = persistTab ? setStoredTab : setLocalTab;

  const [filters, setFilters] = useState<ResourceFilter>({
    types: [],
    baseModels: [],
  });
  const [sort, setSort] = useState<ResourceSort>('relevance');
  const [categoryTag, setCategoryTag] = useState<string | undefined>();
  const [optionsOverride, setOptionsOverride] = useState<ResourceSelectOptions | null>(null);
  const activeOptions = optionsOverride ?? props.options;
  // Memoised because staging a resource now re-renders this provider, and a new
  // `resources` identity invalidates the hit list's `filterVersions` callback —
  // which re-filters every loaded model and re-lays out the whole grid.
  const resources = useMemo(
    () =>
      (activeOptions?.resources ?? []).map(({ type, baseModels = [], partialSupport = [] }) => ({
        type,
        // if generation, check toggle
        // if modelVersion or addResource, always include all
        // otherwise (training, auction, etc.), only include baseModels
        baseModels:
          props.selectSource === 'generation'
            ? generation?.advancedMode
              ? [...baseModels, ...partialSupport]
              : baseModels
            : props.selectSource === 'modelVersion' || props.selectSource === 'addResource'
            ? [...baseModels, ...partialSupport]
            : baseModels,
        partialSupport,
      })),
    [activeOptions, props.selectSource, generation?.advancedMode]
  );
  const resourceTypes = resources.map((x) => x.type);
  const types =
    resources.length > 0
      ? filters.types.filter((type) => resourceTypes.includes(type))
      : filters.types;

  const resourceBaseModels = [...new Set(resources.flatMap((x) => x.baseModels))];
  const baseModels =
    resourceBaseModels.length > 0
      ? filters.baseModels.filter((baseModel) => resourceBaseModels.includes(baseModel))
      : filters.baseModels;

  // Same reason as `resources`: a fresh array each render re-runs the hit
  // list's version filter over every loaded model.
  const excludedIds = useMemo(() => activeOptions?.excludeIds ?? [], [activeOptions]);

  function handleSelect(value: GenerationResource) {
    props.onSelect(value);
    dialog.onClose();
  }

  const multiSelect = !!props.onSelectMultiple;
  const [staged, setStaged] = useState<GenerationResource[]>([]);

  function addStaged(value: GenerationResource) {
    setStaged((current) => {
      if (current.some((x) => x.id === value.id)) return current;
      if (props.limit !== undefined && current.length >= props.limit) return current;
      return [...current, value];
    });
  }

  function removeStaged(id: number) {
    setStaged((current) => current.filter((x) => x.id !== id));
  }

  function commitStaged() {
    if (!staged.length) return;
    props.onSelectMultiple?.(staged);
    dialog.onClose();
  }

  return (
    <ResourceSelectContext.Provider
      value={{
        ...props,
        selectSource,
        canGenerate: activeOptions?.canGenerate,
        excludedIds,
        resources,
        tab,
        setTab,
        filters: {
          types,
          baseModels,
        },
        setFilters,
        sort,
        setSort,
        categoryTag,
        setCategoryTag,
        onSelect: handleSelect,
        optionsOverride,
        setOptionsOverride,
        multiSelect,
        staged,
        addStaged,
        removeStaged,
        isStaged: (id: number) => staged.some((x) => x.id === id),
        commitStaged,
      }}
    >
      {children}
    </ResourceSelectContext.Provider>
  );
}
