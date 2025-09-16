import { LoadingOverlay } from '@mantine/core';
import React, { createContext, useContext } from 'react';
import type {
  FieldValues,
  SubmitErrorHandler,
  UseFormReturn,
  SubmitHandler,
} from 'react-hook-form';
import { FormProvider } from 'react-hook-form';
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
