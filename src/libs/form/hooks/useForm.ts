import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useState } from 'react';
import type { FieldValues, UseFormProps, UseFormReset } from 'react-hook-form';
import { useForm as useReactHookForm } from 'react-hook-form';
import * as z from 'zod';

export const useForm = <TSchema extends z.ZodType<FieldValues, FieldValues>, TContext>(
  args: Omit<UseFormProps<z.input<TSchema>, TContext, z.output<TSchema>>, 'resolver'> & {
    schema: TSchema;
  }
) => {
  const { schema, ...props } = args ?? {};
  const [resetCount, setResetCount] = useState(0);
  const form = useReactHookForm({
    resolver: zodResolver(
      z.looseObject({ ...(schema as unknown as z.ZodObject).shape }) as unknown as TSchema
    ),
    shouldUnregister: true, // TODO - do we need this?
    ...props,
  });

  const reset: UseFormReset<z.input<TSchema>> = useCallback(
    (options) => {
      form.reset(options);
      setResetCount((c) => c + 1);
    },
    [form]
  );

  const refresh = useCallback(() => setResetCount((c) => c + 1), []);

  return {
    ...form,
    resetCount,
    reset,
    refresh,
  };
};
