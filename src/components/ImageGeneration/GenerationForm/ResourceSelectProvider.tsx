import { createContext, useContext, useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { isSortAvailable } from '~/components/Filters/sort-availability';
import { useSortAvailability } from '~/components/Filters/useSortAvailability';
import type {
  ResourceFilter,
  ResourceSelectOptions,
  ResourceSelectSource,
  ResourceSort,
  Tabs,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { resourceSort } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import { useStorage } from '~/hooks/useStorage';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import type { GenerationResource } from '~/shared/types/generation.types';
import { ModelType } from '~/shared/utils/prisma/enums';

const defaultTab: Tabs = 'all';
const defaultSort: ResourceSort = 'relevance';
const modelTypes = Object.values(ModelType);

/**
 * Which of the picker's jobs this instance is doing. Left undefined the modal
 * behaves exactly as it always has — every consumer outside the form-graph
 * generation form passes nothing.
 *
 * `resource` judges each card against the checkpoint's ecosystem and, when the
 * caller supplies `onSelectMultiple`, collects several picks before committing.
 */
export type ResourceSelectRole = 'resource';

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
};

type ResourceSelectState = Omit<
  ResourceSelectModalProps,
  'options' | 'selectSource' | 'onSelectMultiple'
> & {
  selectSource: ResourceSelectSource;
  canGenerate?: boolean;
  excludedIds: number[];
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
  // Sort and the type filter follow the same rule.
  const persist = selectSource !== 'modelVersion';
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
  const tab = (persist ? storedTab : localTab) ?? defaultTab;
  const setTab = persist ? setStoredTab : setLocalTab;

  const [storedSort, setStoredSort] = useStorage<ResourceSort>({
    type: 'localStorage',
    key: 'resource-select-sort',
    defaultValue: defaultSort,
    getInitialValueInEffect: false,
  });
  const [localSort, setLocalSort] = useState<ResourceSort>(defaultSort);
  // A stored sort may be one this viewer can no longer use (Newest without
  // canViewNsfw), or not a sort at all — storage is unvalidated.
  const sortAvailability = useSortAvailability();
  const requestedSort = (persist ? storedSort : localSort) ?? defaultSort;
  const sort =
    requestedSort in resourceSort &&
    isSortAvailable({ type: 'models', value: resourceSort[requestedSort] }, sortAvailability)
      ? requestedSort
      : defaultSort;
  const setSort = persist ? setStoredSort : setLocalSort;

  // Base models are not persisted: their options follow the checkpoint's
  // ecosystem, so a remembered one would reappear on an unrelated picker.
  const [storedTypes, setStoredTypes] = useStorage<ModelType[]>({
    type: 'localStorage',
    key: 'resource-select-types',
    defaultValue: [],
    getInitialValueInEffect: false,
  });
  const [localTypes, setLocalTypes] = useState<ModelType[]>([]);
  const filterTypes = ((persist ? storedTypes : localTypes) ?? []).filter((type) =>
    modelTypes.includes(type)
  );
  const setFilterTypes = persist ? setStoredTypes : setLocalTypes;
  const [filterBaseModels, setFilterBaseModels] = useState<BaseModel[]>([]);
  const [loadedOnly, setLoadedOnly] = useState(false);
  const setFilters: React.Dispatch<React.SetStateAction<ResourceFilter>> = (action) => {
    const next =
      typeof action === 'function'
        ? action({ types: filterTypes, baseModels: filterBaseModels, loadedOnly })
        : action;
    setFilterTypes(next.types);
    setFilterBaseModels(next.baseModels);
    setLoadedOnly(next.loadedOnly);
  };
  const [categoryTag, setCategoryTag] = useState<string | undefined>();
  const activeOptions = props.options;
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
    resources.length > 0 ? filterTypes.filter((type) => resourceTypes.includes(type)) : filterTypes;

  const resourceBaseModels = [...new Set(resources.flatMap((x) => x.baseModels))];
  const baseModels =
    resourceBaseModels.length > 0
      ? filterBaseModels.filter((baseModel) => resourceBaseModels.includes(baseModel))
      : filterBaseModels;

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
          loadedOnly,
        },
        setFilters,
        sort,
        setSort,
        categoryTag,
        setCategoryTag,
        onSelect: handleSelect,
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
