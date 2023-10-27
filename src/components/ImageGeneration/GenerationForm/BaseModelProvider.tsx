import { isEqual } from 'lodash';
import { createContext, useContext, useEffect, useState } from 'react';
import { FieldValues, DeepPartial, useFormContext } from 'react-hook-form';
import { InputText } from '~/libs/form';
import { BaseModelSetType } from '~/server/common/constants';

type GetBaseModelReturn = {
  baseModels: string[];
  baseModel: BaseModelSetType | undefined;
};
type State = GetBaseModelReturn;

const BaseModelsContext = createContext<State | null>(null);
export const useBaseModelsContext = () => {
  const context = useContext(BaseModelsContext);
  if (!context) throw new Error('BaseModelsContext not in tree');
  return context;
};

export function BaseModelProvider<T extends FieldValues>({
  children,
  getBaseModels,
}: {
  children: ({ baseModel }: { baseModel?: BaseModelSetType }) => React.ReactNode;
  getBaseModels: (data: DeepPartial<T>) => GetBaseModelReturn;
}) {
  const [baseModels, setBaseModels] = useState<string[]>([]);
  const [baseModel, setBaseModel] = useState<BaseModelSetType | undefined>();
  const { getValues, setValue, watch } = useFormContext();

  useEffect(() => {
    const subscription = watch((value, { name, type }) => {
      const values = getValues();
      const { baseModels, baseModel } = getBaseModels(values as any);
      setBaseModels((state) => (isEqual(state, baseModels) ? state : baseModels));
      setBaseModel(baseModel);
      if (name !== 'baseModel') setValue('baseModel', baseModel);
    });
    return () => subscription.unsubscribe();
  }, []); //eslint-disable-line

  return (
    <BaseModelsContext.Provider value={{ baseModels, baseModel }}>
      <InputText type="hidden" name="baseModel" />
      {children({ baseModel })}
    </BaseModelsContext.Provider>
  );
}
