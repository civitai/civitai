import { LoadingOverlay } from '@mantine/core';
import React, { useEffect, useState } from 'react';
import {
  FieldValues,
  FormProvider,
  SubmitErrorHandler,
  UseFormReturn,
  SubmitHandler,
  useWatch,
  Path,
  useFormContext,
} from 'react-hook-form';

type FormProps<TFieldValues extends FieldValues> = {
  id?: string;
  className?: string;
  style?: React.CSSProperties;
  form: UseFormReturn<TFieldValues>;
  children?: React.ReactNode;
  onSubmit?: SubmitHandler<TFieldValues>;
  onError?: SubmitErrorHandler<TFieldValues>;
  loading?: boolean;
};

export function Form<TFieldValues extends FieldValues = FieldValues>({
  id,
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
        id={id}
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

export function PersistentForm<TFieldValues extends FieldValues>({
  name,
  storage,
  exclude,
  children,
  ...formProps
}: PersistProps<TFieldValues> & FormProps<TFieldValues>) {
  return (
    <Form {...formProps}>
      <PersistWrapper name={name} storage={storage} exclude={exclude}>
        {children}
      </PersistWrapper>
    </Form>
  );
}

type PersistProps<TFieldValues extends FieldValues> = {
  name: string;
  storage?: Storage;
  exclude?: Path<TFieldValues>[];
  children: React.ReactNode;
};

function PersistWrapper<TFieldValues extends FieldValues>({
  children,
  name,
  storage,
  exclude = [],
}: PersistProps<TFieldValues>) {
  const [restored, setRestored] = useState(false);
  const watchedValues = useWatch();
  const { setValue } = useFormContext();

  const getStorage = () => storage || window.sessionStorage;

  useEffect(() => {
    const str = getStorage().getItem(name);

    if (str) {
      const values = JSON.parse(str);
      const dataRestored: { [key: string]: any } = {};

      Object.keys(values).forEach((key) => {
        const shouldSet = !exclude.includes(key as any);
        if (shouldSet) {
          dataRestored[key] = values[key];
          setValue(key as any, values[key], {
            shouldValidate: false,
            shouldDirty: false,
            shouldTouch: false,
          });
        }
      });
    }
    setRestored(true);
  }, [name]); // eslint-disable-line

  useEffect(() => {
    if (!restored) return;
    const values = exclude.length
      ? Object.entries(watchedValues)
          .filter(([key]) => !exclude.includes(key as any))
          .reduce((obj, [key, val]) => Object.assign(obj, { [key]: val }), {})
      : Object.assign({}, watchedValues);

    console.log({ values });

    if (Object.entries(values).length) {
      getStorage().setItem(name, JSON.stringify(values));
    }
  }, [watchedValues, restored]); //eslint-disable-line

  return <>{children}</>;
}
