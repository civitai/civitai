import { Stack } from '@mantine/core';
import { Dispatch, SetStateAction } from 'react';
import { UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import { Form, useForm } from '~/libs/form';

type ReportFormContext<TSchema extends z.AnyZodObject> = {
  schema: TSchema;
  form: UseFormReturn<z.infer<TSchema>>;
};

type ReportFormProps<TSchema extends z.AnyZodObject> = {
  context: ReportFormContext<TSchema>;
  props: {
    setUploading: Dispatch<SetStateAction<boolean>>;
  };
};

export const createReportForm = <TSchema extends z.AnyZodObject>({
  schema,
  Element,
}: {
  schema: TSchema;
  Element:
    | React.ForwardRefExoticComponent<ReportFormProps<TSchema>>
    | ((props: ReportFormProps<TSchema>) => JSX.Element);
}) => {
  function ReportForm({
    onSubmit,
    setUploading,
    children,
  }: {
    onSubmit: (values: z.infer<TSchema>) => void;
    setUploading: Dispatch<SetStateAction<boolean>>;
    children: React.ReactNode;
  }) {
    const form = useForm({
      schema,
      shouldUnregister: false,
    });

    return (
      <Form form={form} onSubmit={onSubmit}>
        <Stack>
          <Element context={{ form, schema }} props={{ setUploading }} />
          {children}
        </Stack>
      </Form>
    );
  }
  return ReportForm;
};
