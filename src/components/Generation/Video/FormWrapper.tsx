import { UseFormReturn } from 'react-hook-form';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import {
  videoGenerationConfig2,
  OrchestratorEngine2,
} from '~/server/orchestrator/generation/generation.config';
import { useMemo, useState, useEffect } from 'react';
import { hashify } from '~/utils/string-helpers';
import { z } from 'zod';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import { useGenerate } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import {
  Form,
  InputNumberSlider,
  InputSegmentedControl,
  InputSwitch,
  InputText,
  InputTextArea,
} from '~/libs/form';

export function FormWrapper({
  engine,
  children,
}: {
  engine: OrchestratorEngine2;
  children: React.ReactNode | ((form: UseFormReturn) => React.ReactNode);
}) {
  const config = videoGenerationConfig2[engine];
  const status = useGenerationStatus();
  const messageHash = useMemo(
    () => (status.message ? hashify(status.message).toString() : undefined),
    [status.message]
  );
  // TODO - handle total cost
  const totalCost = 0;
  const [error, setError] = useState<string>();
  const [isLoadingDebounced, setIsLoadingDebounced] = useState(false);
  const { conditionalPerformTransaction } = useBuzzTransaction({
    type: 'Generation',
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  const form = usePersistForm(engine, {
    schema: z.record(z.string(), z.any()) as any,
    version: 1,
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    defaultValues: config.getDefaultValues(),
    storage: localStorage,
  });

  const { mutate, isLoading } = useGenerate({
    onError: (error) => {
      if (error.message && error.message.startsWith('Your prompt was flagged')) {
        form.setError('prompt', { type: 'custom', message: error.message }, { shouldFocus: true });
        const elem = document.getElementById(`input_prompt`);
        if (elem) elem.scrollIntoView();
      }
      // TODO - handle generate submit error setError(error.message)
    },
  });

  function handleReset() {
    form.reset();
  }

  function handleSubmit(data: Record<string, unknown>) {
    try {
      const validated = config.validate(data);
      setIsLoadingDebounced(true);
      conditionalPerformTransaction(totalCost, () => {
        mutate({
          $type: 'videoGen',
          data: validated,
          tags: [WORKFLOW_TAGS.VIDEO, engine],
        });
      });
    } catch (e: any) {
      console.error(e);
    }
    setTimeout(() => {
      setIsLoadingDebounced(false);
    }, 1000);
  }

  return (
    <Form
      form={form}
      onSubmit={handleSubmit}
      className="relative flex h-full flex-1 flex-col justify-between gap-2"
    >
      {typeof children === 'function' ? children(form) : children}
    </Form>
  );
}
