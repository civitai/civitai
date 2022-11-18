import { zodResolver } from '@hookform/resolvers/zod';
import { useForm as useReactHookFrom, UseFormProps } from 'react-hook-form';
import { z } from 'zod';

export const useForm = <TSchema extends z.AnyZodObject, TContext>(
  args?: Omit<UseFormProps<z.infer<TSchema>, TContext>, 'resolver'> & {
    schema?: TSchema;
  }
) => {
  const { schema, ...props } = args ?? {};
  return useReactHookFrom<z.infer<TSchema>, TContext>({
    resolver: schema ? zodResolver(schema.passthrough()) : undefined,
    shouldUnregister: true, // TODO - do we need this?
    ...props,
  });
};
