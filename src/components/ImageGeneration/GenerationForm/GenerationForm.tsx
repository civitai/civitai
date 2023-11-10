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
import { baseModelSets } from '~/server/common/constants';
import { isDefined } from '~/utils/type-guards';

const GenerationFormInnner = ({ onSuccess }: { onSuccess?: () => void }) => {
  const defaultValues = useGetInitialFormData() ?? {};

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

  // #region [derived state]
  const totalCost = useGenerationFormStore(({ baseModel, aspectRatio, steps, quantity }) =>
    calculateGenerationBill({ baseModel, aspectRatio, steps, quantity })
  );

  const { baseModel, hasResources } = useGenerationFormStore(({ model, resources, vae }) => {
    const allResources = [...(resources ?? []), ...[vae].filter(isDefined)];
    const baseModel = model?.baseModel
      ? Object.entries(baseModelSets).find(([, baseModels]) =>
          baseModels.includes(model.baseModel as any)
        )?.[0]
      : undefined;

    return {
      baseModel,
      hasResources: !!allResources.length,
    };
  });

  const additionalResourcesCount = useGenerationFormStore((state) =>
    state.resources ? state.resources.length : 0
  );
  const trainedWords = useGenerationFormStore(({ resources }) =>
    resources?.flatMap((x) => x.trainedWords)
  );
  // #endregion

  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  const isSDXL = baseModel === 'SDXL';

  return <></>;
};

export const GenerationForm = (args: { onSuccess?: () => void }) => {
  return (
    <IsClient>
      <GenerationFormInnner {...args} />
    </IsClient>
  );
};
