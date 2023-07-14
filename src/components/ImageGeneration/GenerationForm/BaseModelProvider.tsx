import { isEqual } from 'lodash';
import { createContext, useContext, useEffect, useState } from 'react';
import { FieldValues, DeepPartial, useFormContext } from 'react-hook-form';

type State = {
  baseModels: string[];
};

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
  children: React.ReactNode;
  getBaseModels: (data: DeepPartial<T>) => string[];
}) {
  const [baseModels, setBaseModels] = useState<string[]>([]);
  const { getValues, watch } = useFormContext();

  useEffect(() => {
    const subscription = watch((value, { name, type }) => {
      const values = getValues();
      const baseModels = getBaseModels(values as any);
      setBaseModels((state) => {
        return isEqual(state, baseModels) ? state : baseModels;
      });
      //TODO - alert user if there are incompatible basemodels
    });
    return () => subscription.unsubscribe();
  }, []); //eslint-disable-line

  return <BaseModelsContext.Provider value={{ baseModels }}>{children}</BaseModelsContext.Provider>;
}
