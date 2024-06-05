import { useDebouncedValue } from '@mantine/hooks';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useWatch } from 'react-hook-form';
import { useGenerationForm } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import { generationConfig } from '~/server/common/constants';
import { textToImageWhatIfSchema } from '~/server/schema/orchestrator/textToImage.schema';
import { getBaseModelSetType } from '~/shared/constants/generation.constants';
import { trpc } from '~/utils/trpc';

import { TextToImageWhatIf } from '~/server/services/orchestrator/textToImage';
import { UseTRPCQueryResult } from '@trpc/react-query/shared';
import { isDefined } from '~/utils/type-guards';

const Context = createContext<UseTRPCQueryResult<TextToImageWhatIf | undefined, unknown> | null>(
  null
);

export function useTextToImageWhatIfContext() {
  const context = useContext(Context);
  if (!context) throw new Error('no TextToImageWhatIfProvider in tree');
  return context;
}

export function TextToImageWhatIfProvider({ children }: { children: React.ReactNode }) {
  const form = useGenerationForm();
  const watched = useWatch({ control: form.control });
  const [enabled, setEnabled] = useState(false);
  const defaultModel =
    generationConfig[getBaseModelSetType(watched.baseModel) as keyof typeof generationConfig]
      ?.checkpoint ?? watched.model;

  const query = useMemo(() => {
    const { model, resources = [], vae, ...params } = watched;
    return textToImageWhatIfSchema.safeParse({
      ...params,
      prompt: '',
      negativePrompt: '',
      seed: undefined,
      // resources: [defaultModel.id],
      resources: [model, ...resources, vae].map((x) => (x ? x.id : undefined)).filter(isDefined),
    });
  }, [watched, defaultModel.id]);

  useEffect(() => {
    // enable after timeout to prevent multiple requests as form data is set
    setTimeout(() => setEnabled(true), 150);
  }, []);

  const [debounced] = useDebouncedValue(query, 50);

  const result = trpc.orchestrator.textToImageWhatIf.useQuery(
    debounced.success ? debounced.data : ({} as any),
    {
      enabled: debounced && debounced.success && enabled,
    }
  );

  return <Context.Provider value={result}>{children}</Context.Provider>;
}
