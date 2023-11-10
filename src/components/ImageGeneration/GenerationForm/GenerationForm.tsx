import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { IsClient } from '~/components/IsClient/IsClient';
import { GenerateFormModel, generateFormSchema } from '~/server/schema/generation.schema';
import {
  GenerationFormSchema,
  generationFormSchema,
  useGenerationFormStore,
  useGetInitialFormData,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useEffect } from 'react';
import { calculateGenerationBill } from '~/server/common/generation';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';
import { baseModelSets, constants } from '~/server/common/constants';

const GenerationFormInnner = ({ onSuccess }: { onSuccess?: () => void }) => {
  const defaultValues = useGetInitialFormData() ?? {};

  const form = useForm<GenerationFormSchema>({
    resolver: zodResolver(generationFormSchema),
    mode: 'onSubmit',
    shouldUnregister: true,
    defaultValues,
  });

  useEffect(() => {
    const subscription = form.watch((value) => {
      useGenerationFormStore.setState((data) => ({ ...data, ...(value as GenerationFormSchema) }));
    });
    return () => subscription.unsubscribe();
  }, []);

  const totalCost = useGenerationFormStore(({ baseModel, aspectRatio, steps, quantity }) =>
    calculateGenerationBill({ baseModel, aspectRatio, steps, quantity })
  );
  const baseModel = useGenerationFormStore(({ model, resources, vae }) => {
    const resource = model ?? resources?.[0] ?? vae;
    // const test = Object.entries(baseModelSets).find(([,baseModels]))
  });

  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  return <></>;
};

export const GenerationForm = (args: { onSuccess?: () => void }) => {
  return (
    <IsClient>
      <GenerationFormInnner {...args} />
    </IsClient>
  );
};
