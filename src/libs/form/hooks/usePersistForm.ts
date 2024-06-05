import { TypeOf, z, AnyZodObject } from 'zod';
import {
  Path,
  useForm,
  UseFormProps,
  UseFormReturn,
  DeepPartial,
  FieldValues,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef } from 'react';
import { getDeepPartialWithoutChecks } from '~/utils/zod-helpers';

export type UsePersistFormReturn<TFieldValues extends FieldValues = FieldValues> =
  UseFormReturn<TFieldValues> & {
    clear: () => void;
  };

export function usePersistForm<
  TSchema extends AnyZodObject,
  TExclude extends Array<Path<TypeOf<TSchema>>>
>(
  storageKey: string,
  args?: Omit<UseFormProps<TypeOf<TSchema>>, 'resolver' | 'defaultValues' | 'values'> & {
    schema?: TSchema;
    storage?: Storage;
    version?: number;
    exclude?: TExclude;
    defaultValues?:
      | DeepPartial<TypeOf<TSchema>>
      | ((storageValues: DeepPartial<TypeOf<TSchema>>) => DeepPartial<TypeOf<TSchema>>);
    values?:
      | DeepPartial<TypeOf<TSchema>>
      | ((storageValues: DeepPartial<TypeOf<TSchema>>) => DeepPartial<TypeOf<TSchema>>);
  }
) {
  const {
    schema,
    storage,
    version = 0,
    exclude = [],
    defaultValues = {},
    values = {},
    ...rest
  } = args ?? {};

  const _storageSchema = useRef<AnyZodObject | undefined>();
  if (!_storageSchema.current)
    _storageSchema.current = z.object({
      state: schema ? getDeepPartialWithoutChecks(schema) : z.object({}).passthrough(),
      version: z.number(),
    });

  const _formControl = useRef<UsePersistFormReturn<TypeOf<TSchema>> | undefined>();
  const _defaultValues = useRef<DeepPartial<TypeOf<TSchema>> | undefined>();
  if (!_defaultValues.current) {
    if (defaultValues)
      _defaultValues.current =
        typeof defaultValues === 'function'
          ? defaultValues(getParsedStorage())
          : Object.keys(defaultValues).length
          ? { ...getParsedStorage(), ...defaultValues }
          : undefined;

    if (values) {
      _defaultValues.current =
        typeof values === 'function'
          ? values(getParsedStorage())
          : Object.keys(values).length
          ? { ...getParsedStorage(), ...values }
          : undefined;
    }
  }

  const form = useForm<TypeOf<TSchema>>({
    resolver: schema ? zodResolver(schema) : undefined,
    defaultValues: _defaultValues.current,
    values: Object.keys(values).length
      ? typeof values === 'function'
        ? values(getParsedStorage())
        : values
      : undefined,
    ...rest,
  });

  function getStorage() {
    return storage || window.sessionStorage;
  }

  function parseStorage(value: string) {
    const defaults = { state: {}, version };
    if (!_storageSchema.current) return defaults;

    const obj = JSON.parse(value);
    const result = _storageSchema.current.safeParse(obj);
    const response = result.success ? result.data : defaults;
    if (response.version !== version) {
      getStorage().setItem(storageKey, JSON.stringify(defaults));
      return defaults;
    }
    return {
      state: response.state ?? {},
      version: response.version,
    };
  }

  function getParsedStorage() {
    const str = getStorage().getItem(storageKey);
    return str ? parseStorage(str).state : {};
  }

  function updateStorage(watchedValues: DeepPartial<TypeOf<TSchema>>) {
    const values = exclude.length
      ? Object.entries(watchedValues)
          .filter(([key]) => !exclude.includes(key as never))
          .reduce((obj, [key, val]) => Object.assign(obj, { [key]: val }), {})
      : Object.assign({}, watchedValues);

    if (Object.entries(values).length) {
      getStorage().setItem(storageKey, JSON.stringify({ state: values, version }));
    }
  }

  // set storage values for initial defaultValues
  // useEffect(() => {
  //   if (_defaultValues.current) updateStorage(_defaultValues.current);
  // }, []);

  useEffect(() => {
    for (const [key, value] of Object.entries(getParsedStorage())) {
      form.setValue(key as any, value as any);
    }
  }, []);

  // update storage values on form input update
  useEffect(() => {
    const subscription = form.watch((watchedValues) => {
      updateStorage(watchedValues);
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [form, storageKey, version]); // eslint-disable-line

  if (!_formControl.current) {
    _formControl.current = {
      ...form,
      clear: () => getStorage().removeItem(storageKey),
    };
  }

  return {
    ...form,
    clear: () => getStorage().removeItem(storageKey),
  };
}
