import { LoadingOverlay } from '@mantine/core';
import React, { createContext, useContext, useEffect, useState } from 'react';
import type {
  FieldValues,
  SubmitErrorHandler,
  UseFormReturn,
  SubmitHandler,
  Path,
} from 'react-hook-form';
import { FormProvider, useWatch, useFormContext } from 'react-hook-form';
import type * as z from 'zod/v4';
import clsx from 'clsx';

const CustomFormCtx = createContext<{
  onSubmit?: SubmitHandler<any>;
} | null>(null);
export function useCustomFormContext() {
  const ctx = useContext(CustomFormCtx);
  if (!ctx) throw new Error('missing CustomFormCtx in tree');
  return ctx;
}

export type FormProps<TInput extends FieldValues, TOutput extends FieldValues> = {
  id?: string;
  className?: string;
  style?: React.CSSProperties;
  form: UseFormReturn<TInput, any, TOutput>;
  children?: React.ReactNode;
  onSubmit?: SubmitHandler<TOutput>;
  onError?: SubmitErrorHandler<TInput>;
  loading?: boolean;
};

export function Form<
  TInput extends FieldValues = FieldValues,
  TOutput extends FieldValues = FieldValues
>({
  id,
  form,
  className,
  style,
  children,
  onSubmit,
  onError,
  loading = false,
}: FormProps<TInput, TOutput>) {
  const handleError: SubmitErrorHandler<TInput> = (errors, e) => {
    onError?.(errors, e);
    Object.entries(errors).forEach(([key, value]) =>
      console.warn(`${key}: Form validation: ${value?.message}`, { value })
    );
  };

  const handleSubmit = onSubmit
    ? form.handleSubmit(onSubmit, handleError)
    : (e: React.FormEvent<HTMLFormElement>) => e.preventDefault();

  return (
    <FormProvider {...form}>
      <CustomFormCtx.Provider value={{ onSubmit }}>
        <form id={id} onSubmit={handleSubmit} className={clsx('relative', className)} style={style}>
          <LoadingOverlay visible={loading} zIndex={1} />
          {children}
        </form>
      </CustomFormCtx.Provider>
    </FormProvider>
  );
}

// export function PersistentForm<TInput extends FieldValues, TSchema extends z.ZodObject>({
//   name,
//   storage,
//   exclude,
//   schema,
//   children,
//   ...formProps
// }: PersistProps<TInput, TSchema> & FormProps<TInput>) {
//   return (
//     <Form {...formProps}>
//       <PersistWrapper name={name} storage={storage} exclude={exclude} schema={schema}>
//         {children}
//       </PersistWrapper>
//     </Form>
//   );
// }

// type PersistProps<TInput extends FieldValues, TSchema extends z.ZodObject> = {
//   name: string;
//   storage?: Storage;
//   exclude?: Path<TInput>[];
//   schema?: TSchema;
//   children: React.ReactNode;
//   shouldValidate?: boolean;
//   shouldDirty?: boolean;
//   shouldTouch?: boolean;
// };

// function PersistWrapper<TInput extends FieldValues, TSchema extends z.ZodObject>({
//   children,
//   name,
//   storage,
//   exclude = [],
//   schema,
//   shouldValidate,
//   shouldDirty,
//   shouldTouch,
// }: PersistProps<TInput, TSchema>) {
//   const [restored, setRestored] = useState(false);
//   const watchedValues = useWatch();
//   const { setValue } = useFormContext();

//   const getStorage = () =>
//     typeof window !== 'undefined' ? storage || window.sessionStorage : undefined;

//   const parseStoredData = (values: any) => {
//     if (!schema) return values;
//     console.log({ values });
//     const result = schema.safeParse(values);
//     if (!result.success) console.log({ error: result.error });
//     return result.success ? result.data : {};
//   };

//   useEffect(() => {
//     const str = getStorage()?.getItem(name);

//     if (str) {
//       const values = JSON.parse(str);
//       const toUpdate = Object.keys(values)
//         .filter((key) => !exclude.includes(key as any))
//         .reduce((acc, key) => ({ ...acc, [key]: values[key] }), {} as any);

//       const parsed = parseStoredData(toUpdate);

//       Object.keys(parsed).forEach((key) => {
//         setValue(key as any, parsed[key], {
//           shouldValidate,
//           shouldDirty,
//           shouldTouch,
//         });
//       });
//     }
//     setRestored(true);
//   }, [name]); // eslint-disable-line

//   useEffect(() => {
//     if (!restored) return;
//     const values = exclude.length
//       ? Object.entries(watchedValues)
//           .filter(([key]) => !exclude.includes(key as any))
//           .reduce((obj, [key, val]) => Object.assign(obj, { [key]: val }), {})
//       : Object.assign({}, watchedValues);

//     if (Object.entries(values).length) {
//       getStorage()?.setItem(name, JSON.stringify(values));
//     }
//   }, [watchedValues, restored]); //eslint-disable-line

//   return <>{children}</>;
// }
