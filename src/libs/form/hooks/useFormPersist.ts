import { useEffect, useRef } from 'react';
import { DefaultValues, FieldValues, UseFormReturn, DeepPartial } from 'react-hook-form';

export interface FormPersistConfig<T extends FieldValues> {
  storage?: Storage;
  form: UseFormReturn<T>;
  exclude?: string[];
  onDataRestored?: (data: any) => void;
  validate?: boolean;
  dirty?: boolean;
  touch?: boolean;
}

const useFormPersist = <T extends FieldValues>(
  keyName: string,
  {
    storage,
    form,
    exclude = [],
    onDataRestored,
    validate = false,
    dirty = false,
    touch = false,
  }: FormPersistConfig<T>
) => {
  const restoredRef = useRef(false);

  const getStorage = () => storage || window.sessionStorage;
  const clearStorage = () => getStorage().removeItem(keyName);

  useEffect(() => {
    const str = getStorage().getItem(keyName);

    if (str) {
      const values = JSON.parse(str);
      const dataRestored: { [key: string]: any } = {};

      Object.keys(values).forEach((key) => {
        const shouldSet = !exclude.includes(key);
        if (shouldSet) {
          dataRestored[key] = values[key];
          form.setValue(key as any, values[key], {
            shouldValidate: validate,
            shouldDirty: dirty,
            shouldTouch: touch,
          });
        }
      });

      if (onDataRestored) {
        onDataRestored(dataRestored);
      }
    }
    setTimeout(() => {
      restoredRef.current = true;
    }, 0);
  }, [keyName]); // eslint-disable-line

  useEffect(() => {
    const subscription = form.watch((value, { name, type }) => {
      if (!restoredRef.current && !name) return;

      const toUpdate = !name ? form.getValues() : value;
      const values = exclude.length
        ? Object.entries(toUpdate)
            .filter(([key]) => !exclude.includes(key))
            .reduce((obj, [key, val]) => Object.assign(obj, { [key]: val }), {})
        : Object.assign({}, toUpdate);

      if (Object.entries(values).length) {
        getStorage().setItem(keyName, JSON.stringify(values));
      }
    });
    return () => subscription.unsubscribe();
  }, []); //eslint-disable-line

  return {
    clear: clearStorage,
  };
};

export default useFormPersist;
