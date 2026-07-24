import { createContext, useContext, useState } from 'react';
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

export type ResourceSelectModalProps = {
  title?: React.ReactNode;
  onSelect: (value: GenerationResource) => void;
  onClose?: () => void;
  options?: ResourceSelectOptions;
  selectSource?: ResourceSelectSource;
};

type ResourceSelectState = Omit<ResourceSelectModalProps, 'options' | 'selectSource'> & {
  selectSource: ResourceSelectSource;
  canGenerate?: boolean;
  excludedIds: number[];
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

  // For modelVersion linking, always start on the 'all' tab (and don't persist)
  // since 'recent' depends on recommended models that are often empty for new
  // uploads.
  const persistTab = selectSource !== 'modelVersion';
  const [storedTab, setStoredTab] = useStorage<Tabs>({
    type: 'localStorage',
    key: 'resource-select-tab',
    defaultValue: defaultTab,
    getInitialValueInEffect: false,
  });
  const [localTab, setLocalTab] = useState<Tabs>(defaultTab);
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
  const resources = (props.options?.resources ?? []).map(
    ({ type, baseModels = [], partialSupport = [] }) => ({
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
    })
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

  function handleSelect(value: GenerationResource) {
    props.onSelect(value);
    dialog.onClose();
  }

  return (
    <ResourceSelectContext.Provider
      value={{
        ...props,
        selectSource,
        canGenerate: props.options?.canGenerate,
        excludedIds: props.options?.excludeIds ?? [],
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
      }}
    >
      {children}
    </ResourceSelectContext.Provider>
  );
}
