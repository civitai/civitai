import { openConfirmModal } from '@mantine/modals';
import { useCallback, useEffect } from 'react';
import type { EventType, FieldPath, UseFormReturn } from 'react-hook-form';
import type * as z from 'zod/v4';
import { useDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';

export function useFormStorage<TSchema extends z.ZodObject, TContext>({
  schema,
  timeout,
  form,
  key,
  watch,
}: {
  schema: TSchema;
  timeout: number;
  form: UseFormReturn<z.input<TSchema>, TContext, z.output<TSchema>>;
  key: string;
  watch: (
    value: DeepPartial<z.input<TSchema>>,
    info: {
      name?: FieldPath<z.input<TSchema>>;
      type?: EventType;
    }
  ) => DeepPartial<z.input<TSchema>> | void;
}) {
  const debouncer = useDebouncer(timeout);

  useEffect(() => {
    const subscription = form.watch((value, info) => {
      const watchedValue = watch(value as any, info);
      if (!watchedValue) return;
      debouncer(() => {
        localStorage.setItem(key, JSON.stringify(watchedValue));
      });
    });

    /**
     * assign a value to subscription immediately if there is no localstorage value
     * or assign a value to subscription after the user has closed the `restore-confirm` modal
     */
    const storedValue = localStorage.getItem(key);
    if (storedValue) {
      const initialValue = JSON.parse(storedValue);
      openConfirmModal({
        modalId: 'restore-confirm',
        centered: true,
        title: 'Restore unsaved changes?',
        children: 'Would you like to restore the unsaved changes from your previous session',
        labels: { cancel: `No`, confirm: `Yes` },
        closeOnConfirm: true,
        onClose: () => localStorage.removeItem(key),
        onConfirm: () => {
          const result = schema.safeParse({ ...form.getValues(), ...initialValue });
          if (!result.success)
            showErrorNotification({ error: new Error('could not restore unsaved changes') });
          else form.reset(result.data as z.input<TSchema>);
        },
      });
    }

    return () => subscription.unsubscribe();
  }, [key]);

  return useCallback(() => localStorage.removeItem(key), [key]);
}
