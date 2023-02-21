import { LoadingOverlay } from '@mantine/core';
import React from 'react';
import {
  FieldValues,
  FormProvider,
  SubmitErrorHandler,
  UseFormReturn,
  SubmitHandler,
} from 'react-hook-form';

type FormProps<TFieldValues extends FieldValues> = {
  className?: string;
  style?: React.CSSProperties;
  form: UseFormReturn<TFieldValues>;
  children?: React.ReactNode;
  onSubmit?: SubmitHandler<TFieldValues>;
  onError?: SubmitErrorHandler<TFieldValues>;
  loading?: boolean;
};

export function Form<TFieldValues extends FieldValues = FieldValues>({
  form,
  className,
  style,
  children,
  onSubmit,
  onError,
  loading = false,
}: FormProps<TFieldValues>) {
  const handleError: SubmitErrorHandler<TFieldValues> = (errors, e) => {
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
      <form
        onSubmit={handleSubmit}
        className={className}
        style={{ position: 'relative', ...style }}
      >
        <LoadingOverlay visible={loading} zIndex={1} />
        {children}
      </form>
    </FormProvider>
  );
}
