import type { FieldValues, UseFormReturn } from 'react-hook-form';
import { useGenerationContextStore } from '~/components/ImageGeneration/GenerationProvider';
import type { FormProps } from '~/libs/form';
import { Form } from '~/libs/form';
import { showWarningNotification } from '~/utils/notifications';

export function GenForm<
  TInput extends FieldValues = FieldValues,
  TOutput extends FieldValues = FieldValues
>({ children, onSubmit, ...props }: FormProps<TInput, TOutput>) {
  const generationContextStore = useGenerationContextStore();

  return (
    <Form
      {...props}
      onSubmit={(payload) => {
        const snapshot = generationContextStore.getState();
        if (!snapshot.canGenerate) {
          showWarningNotification({
            message:
              snapshot.requestsRemaining === 0
                ? `You are already generating at your limit: ${snapshot.queued.length}`
                : 'Generator is currently unavailable',
          });
          return;
        }

        onSubmit?.(payload);
      }}
    >
      {children}
    </Form>
  );
}
