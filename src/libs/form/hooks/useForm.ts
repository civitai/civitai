import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useMemo, useState } from 'react';
import { useForm as useReactHookForm, UseFormProps, UseFormReset } from 'react-hook-form';
import { z } from 'zod';

export const useForm = <TSchema extends z.AnyZodObject | z.Schema, TContext>(
  args?: Omit<UseFormProps<z.infer<TSchema>, TContext>, 'resolver'> & {
    schema?: TSchema;
  }
) => {
  const { schema, ...props } = args ?? {};
  const [resetCount, setResetCount] = useState(0);
  const form = useReactHookForm<z.infer<TSchema>, TContext>({
    resolver: schema
      ? zodResolver(schema instanceof z.ZodObject ? schema.passthrough() : schema)
      : undefined,
    shouldUnregister: true, // TODO - do we need this?
    ...props,
  });

  const reset: UseFormReset<z.infer<TSchema>> = useCallback(
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
