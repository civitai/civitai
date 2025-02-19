import { uniqBy } from 'lodash-es';
import React, { createContext, useContext } from 'react';
import {
  BaseModelResourceTypes,
  SupportedBaseModel,
} from '~/shared/constants/generation.constants';
import { GenerationResource } from '~/server/services/generation/generation.service';

type ResourceSelectState = {
  value?: GenerationResource[];
  onChange?: (value: GenerationResource[]) => void;
};

const ResourceSelectContext = createContext<ResourceSelectState | null>(null);
function useResourceSelectContext() {
  const ctx = useContext(ResourceSelectContext);
  // if (!ctx) throw new Error('missing ResourceSelectProvider in tree');
  return ctx;
}

export function ResourceSelectProvider({
  children,
  value,
  onChange,
}: ResourceSelectState & { children: React.ReactNode }) {
  return (
    <ResourceSelectContext.Provider value={{ value, onChange }}>
      {children}
    </ResourceSelectContext.Provider>
  );
}

type ResourceSelectProps = { canGenerate?: boolean; title?: React.ReactNode };
export function ResourceSelect<T extends SupportedBaseModel>({
  baseModel,
  modelTypes,
  multiple,
  limit,
  value,
  onChange,
  children,
}: {
  baseModel: T;
  modelTypes: BaseModelResourceTypes[T][number]['type'][];
  multiple?: boolean;
  limit?: number;
  value?: GenerationResource[];
  onChange?: (value: GenerationResource[]) => void;
  children: (args: {
    resources: GenerationResource[];
    addResource: (resource: GenerationResource) => void;
    removeResource: (id: number) => void;
    openResourceSelect: (options?: ResourceSelectProps) => void;
  }) => React.ReactNode;
}) {
  const ctx = useResourceSelectContext();
  onChange ??= ctx?.onChange;
  value ??= ctx?.value;

  // const baseModelSet = getBaseModelSet(baseModel)
  const resources = uniqBy(
    value?.filter((x) => (modelTypes as string[]).includes(x.model.type)) ?? [],
    'id'
  );

  function handleChange(resources: GenerationResource[]) {
    onChange?.(resources);
  }

  function removeResource(id: number) {
    handleChange(resources.filter((x) => x.id !== id));
  }

  function addResource(resource: GenerationResource) {
    handleChange([...resources, resource]);
  }

  function openResourceSelect({ canGenerate, title }: ResourceSelectProps = {}) {
    // const test = baseModelResourceTypes[baseModel].filter((x) => modelTypes.includes(x.type));
    // openResourceSelectModal({
    //   title,
    //   onSelect: addResource,
    //   options: {
    //     canGenerate,
    //     // resources: modelTypes.map((type) => ({type, baseModels: getBaseModelSet(type)}))
    //     resources: baseModelResourceTypes[baseModel].filter((x) => modelTypes.includes(x.type)),
    //   },
    // });
  }

  return (
    <> {children({ resources: value ?? [], addResource, removeResource, openResourceSelect })}</>
  );
}

function Test() {
  return (
    <ResourceSelect baseModel="SDXL" modelTypes={['Checkpoint']}>
      {({ resources }) => resources.map((resource) => <div key={resource.id}></div>)}
    </ResourceSelect>
  );
}
