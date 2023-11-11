import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { IsClient } from '~/components/IsClient/IsClient';
import { GenerateFormModel, generateFormSchema } from '~/server/schema/generation.schema';
import {
  GenerationFormSchema,
  generationFormSchema,
  useDerivedGenerationState,
  useGenerationFormStore,
  useGetInitialFormData,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useEffect } from 'react';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';

const GenerationFormInnner = ({ onSuccess }: { onSuccess?: () => void }) => {
  const defaultValues = useGetInitialFormData();

  const form = useForm<GenerationFormSchema>({
    resolver: zodResolver(generationFormSchema),
    mode: 'onSubmit',
    shouldUnregister: true,
    defaultValues,
  });

  useEffect(() => {
    setTimeout(() => {
      useGenerationFormStore.setState((data) => ({ ...data, ...form.getValues() }));
    }, 0);
    const subscription = form.watch((value) => {
      useGenerationFormStore.setState((data) => ({ ...data, ...(value as GenerationFormSchema) }));
    });
    return () => subscription.unsubscribe();
  }, []);

  const { totalCost, baseModel, hasResources, trainedWords, additionalResourcesCount, isSDXL } =
    useDerivedGenerationState();

  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  const handleReset = (data?: GenerationFormSchema) => form.reset(data ?? defaultValues);

  // TODO - handle parse prompt from clipboard
  // TODO - display survey logic
  // TODO - get generation requests
  // TODO - poll any pending generation requests
  // TODO - disable generate button logic

  return <></>;
};

export const GenerationForm = (args: { onSuccess?: () => void }) => {
  return (
    <IsClient>
      <GenerationFormInnner {...args} />
    </IsClient>
  );
};
