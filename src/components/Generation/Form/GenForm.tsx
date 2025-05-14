import { FieldValues, SubmitErrorHandler, UseFormReturn, SubmitHandler } from 'react-hook-form';
import { useGenerationContextStore } from '~/components/ImageGeneration/GenerationProvider';
import { Form } from '~/libs/form';
import { showWarningNotification } from '~/utils/notifications';

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

export function GenForm<TFieldValues extends FieldValues = FieldValues>({
  children,
  onSubmit,
  ...props
}: FormProps<TFieldValues>) {
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
