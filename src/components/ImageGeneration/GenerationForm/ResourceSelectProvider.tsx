import { createContext, useContext, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type {
  ResourceFilter,
  ResourceSelectOptions,
  ResourceSelectSource,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import type { GenerationResource } from '~/shared/types/generation.types';

type GenerationResourceWithImage = GenerationResource & {
  image: SearchIndexDataMap['models'][number]['images'][number];
};
export type ResourceSelectModalProps = {
  title?: React.ReactNode;
  onSelect: (value: GenerationResourceWithImage) => void;
  onClose?: () => void;
  options?: ResourceSelectOptions;
  selectSource?: ResourceSelectSource;
};

type ResourceSelectState = Omit<ResourceSelectModalProps, 'options'> & {
  canGenerate?: boolean;
  excludedIds: number[];
  resources: DeepRequired<ResourceSelectOptions>['resources'];
  filters: ResourceFilter;
  setFilters: React.Dispatch<React.SetStateAction<ResourceFilter>>;
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
  const [filters, setFilters] = useState<ResourceFilter>({
    types: [],
    baseModels: [],
  });
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

  function handleSelect(value: GenerationResourceWithImage) {
    props.onSelect(value);
    dialog.onClose();
  }

  return (
    <ResourceSelectContext.Provider
      value={{
        ...props,
        selectSource: props.selectSource ?? 'generation',
        canGenerate: props.options?.canGenerate,
        excludedIds: props.options?.excludeIds ?? [],
        resources,
        filters: {
          types,
          baseModels,
        },
        setFilters,
        onSelect: handleSelect,
      }}
    >
      {children}
    </ResourceSelectContext.Provider>
  );
}
