import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef } from 'react';
import type { DeepPartial, FieldValues, Path, UseFormProps, UseFormReturn } from 'react-hook-form';
import { useForm } from 'react-hook-form';
import * as z from 'zod/v4';

export type UsePersistFormReturn<TFieldValues extends FieldValues = FieldValues> =
  UseFormReturn<TFieldValues> & {
    // clear: () => void;
  };

export function usePersistForm<
  TSchema extends z.ZodObject,
  TExclude extends Array<Path<z.infer<TSchema>>>
>(
  storageKey: string,
  args?: Omit<UseFormProps<z.infer<TSchema>>, 'resolver' | 'defaultValues' | 'values'> & {
    schema?: TSchema;
    partialSchema?: z.ZodObject;
    storage?: Storage;
    version?: number;
    exclude?: TExclude;
    defaultValues?:
      | DeepPartial<z.input<TSchema>>
      | ((storageValues: DeepPartial<z.input<TSchema>>) => DeepPartial<z.input<TSchema>>);
    values?:
      | DeepPartial<z.input<TSchema>>
      | ((storageValues: DeepPartial<z.input<TSchema>>) => DeepPartial<z.input<TSchema>>);
  }
) {
  const {
    schema,
    partialSchema = z.object({}),
    storage,
    version = 0,
    exclude = [],
    defaultValues = {},
    values = {},
    ...rest
  } = args ?? {};

  const _storageSchema = useRef<z.ZodObject | undefined>();
  if (!_storageSchema.current)
    _storageSchema.current = z.object({
      state: partialSchema.passthrough(),
      // state: schema ? getDeepPartialWithoutChecks(schema) : z.object({}).passthrough(),
      version: z.number().default(version),
    });

  // const _formControl = useRef<UsePersistFormReturn<TypeOf<TSchema>> | undefined>();
  const _defaultValues = useRef<DeepPartial<z.infer<TSchema>> | undefined>();
  if (!_defaultValues.current) {
    if (defaultValues)
      _defaultValues.current =
        typeof defaultValues === 'function'
          ? defaultValues(getParsedStorage())
          : Object.keys(defaultValues).length
          ? { ...getParsedStorage(), ...defaultValues }
          : undefined;
    if (values && !_defaultValues.current) {
      _defaultValues.current =
        typeof values === 'function'
          ? values(getParsedStorage())
          : Object.keys(values).length
          ? { ...getParsedStorage(), ...values }
          : undefined;
    }
  }

  const form = useForm<z.infer<TSchema>>({
    resolver: schema ? zodResolver(schema) : undefined,
    defaultValues: { ..._defaultValues.current, ...getParsedStorage() } as any,
    // values: Object.keys(values).length
    //   ? typeof values === 'function'
    //     ? values(getParsedStorage())
    //     : values
    //   : undefined,
    ...rest,
  });

  function getStorage() {
    return storage || window.sessionStorage;
  }

  function parseStorage(value: string) {
    const defaults = { state: {}, version };
    if (!_storageSchema.current) return defaults;

    const prompt = localStorage.getItem('generation:prompt') ?? '';
    let negativePrompt = localStorage.getItem('generation:negativePrompt') ?? '';
    if (negativePrompt === 'undefined') negativePrompt = '';
    // const sourceImage = localStorage.getItem('generation:sourceImage') ?? undefined;

    const obj = JSON.parse(value);
    const result = _storageSchema.current.safeParse(obj);
    const response = result.success ? result.data : defaults;

    if (!result.success || response.version !== version) {
      getStorage().setItem(storageKey, JSON.stringify(defaults));
      return defaults;
    }

    return {
      state: {
        ...response.state,
        prompt,
        negativePrompt,
        // sourceImage: sourceImage ? JSON.parse(sourceImage) : undefined,
      },
      version: response.version,
    };
  }

  function getParsedStorage() {
    if (typeof window === 'undefined') return {};
    const str = getStorage().getItem(storageKey);
    return parseStorage(str ?? '{}').state;
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

  // useEffect(() => {
  //   const storage = getParsedStorage();
  //   form.reset(storage, { keepDefaultValues: true });
  //   // for (const [key, value] of Object.entries(storage)) {
  //   //   form.setValue(key as any, value as any);
  //   // }
  // }, []);

  // update storage values on form input update
  useEffect(() => {
    const subscription = form.watch((watchedValues, { name }) => {
      if (name === 'prompt') localStorage.setItem('generation:prompt', watchedValues[name]);
      if (
        name === 'negativePrompt' &&
        (watchedValues.negativePrompt || watchedValues.negativePrompt === '')
      )
        localStorage.setItem('generation:negativePrompt', watchedValues.negativePrompt);

      if (!name) {
        if (watchedValues.prompt || watchedValues.prompt === '')
          localStorage.setItem('generation:prompt', watchedValues.prompt);
        if (watchedValues.negativePrompt || watchedValues.negativePrompt === '')
          localStorage.setItem('generation:negativePrompt', watchedValues.negativePrompt);
      }
      updateStorage(watchedValues);
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [form, storageKey, version]); // eslint-disable-line

  // if (!_formControl.current) {
  //   _formControl.current = {
  //     ...form,
  //     clear: () => getStorage().removeItem(storageKey),
  //   };
  // }

  return form;

  // return {
  //   ...form,
  //   clear: () => getStorage().removeItem(storageKey),
  // };
}
