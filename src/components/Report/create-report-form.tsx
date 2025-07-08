import { Stack } from '@mantine/core';
import type { Dispatch, SetStateAction } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type * as z from 'zod/v4';
import { Form, useForm } from '~/libs/form';

type ReportFormContext<TSchema extends z.ZodObject> = {
  schema: TSchema;
  form: UseFormReturn<z.input<TSchema>, any, z.output<TSchema>>;
};

type ReportFormProps<TSchema extends z.ZodObject> = {
  context: ReportFormContext<TSchema>;
  props: {
    setUploading: Dispatch<SetStateAction<boolean>>;
  };
};

export const createReportForm = <TSchema extends z.ZodObject>({
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
