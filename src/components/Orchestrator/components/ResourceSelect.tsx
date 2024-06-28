import { ModelType } from '@prisma/client';
import React, { createContext, useContext } from 'react';
import { BaseModelSetType } from '~/server/common/constants';
import {
  BaseModelResourceTypes,
  GenerationResource,
  SupportedBaseModel,
  baseModelResourceTypes,
} from '~/shared/constants/generation.constants';

type ResourceSelectState = {
  value?: GenerationResource[];
  onChange?: (value: GenerationResource[]) => void;
};

const ResourceSelectContext = createContext<ResourceSelectState | null>(null);
function useResourceSelectContext() {
  const ctx = useContext(ResourceSelectContext);
  if (!ctx) throw new Error('missing ResourceSelectProvider in tree');
  return ctx;
}

export function ResourceSelect({
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

ResourceSelect.Input = function ResourceSelectInput<T extends SupportedBaseModel>(args: {
  baseModel: T;
  modelTypes: BaseModelResourceTypes[T][number]['type'][];
  multiple?: boolean;
  limit?: number;
}) {
  const { value, onChange } = useResourceSelectContext();

  return <></>;
};

function Test() {
  return <ResourceSelect.Input baseModel="SDXL" modelTypes={['Checkpoint']}></ResourceSelect.Input>;
}
