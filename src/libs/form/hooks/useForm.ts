import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useState } from 'react';
import type { UseFormProps, UseFormReset } from 'react-hook-form';
import { useForm as useReactHookForm } from 'react-hook-form';
import * as z from 'zod/v4';

export const useForm = <TSchema extends z.ZodObject, TContext>(
  args: Omit<UseFormProps<z.infer<TSchema>, TContext>, 'resolver'> & {
    schema: TSchema;
  }
) => {
  const { schema, ...props } = args ?? {};
  const [resetCount, setResetCount] = useState(0);
  const form = useReactHookForm<z.infer<TSchema>, TContext>({
    resolver: zodResolver(z.looseObject({ ...schema.shape }) as any),
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
