import { useDebouncedValue } from '@mantine/hooks';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useWatch } from 'react-hook-form';
import { useGenerationForm } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import { generationConfig } from '~/server/common/constants';
import { TextToImageParams } from '~/server/schema/orchestrator/textToImage.schema';
import {
  getBaseModelSetType,
  getSizeFromAspectRatio,
  whatIfQueryOverrides,
} from '~/shared/constants/generation.constants';
import { trpc } from '~/utils/trpc';

import { UseTRPCQueryResult } from '@trpc/react-query/shared';
import { GenerationWhatIfResponse } from '~/server/services/orchestrator/types';

const Context = createContext<UseTRPCQueryResult<
  GenerationWhatIfResponse | undefined,
  unknown
> | null>(null);

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
    const { model, resources, vae, creatorTip, civitaiTip, ...params } = watched;
    if (params.aspectRatio) {
      const size = getSizeFromAspectRatio(Number(params.aspectRatio), params.baseModel);
      params.width = size.width;
      params.height = size.height;
    }

    return {
      resources: [defaultModel.id],
      // resources: [model, ...resources, vae].map((x) => (x ? x.id : undefined)).filter(isDefined),
      params: {
        ...params,
        ...whatIfQueryOverrides,
      } as TextToImageParams,
    };
  }, [watched, defaultModel.id]);

  useEffect(() => {
    // enable after timeout to prevent multiple requests as form data is set
    setTimeout(() => setEnabled(true), 150);
  }, []);

  const [debounced] = useDebouncedValue(query, 100);

  const result = trpc.orchestrator.getImageWhatIf.useQuery(debounced, {
    enabled: debounced && enabled,
  });

  return <Context.Provider value={result}>{children}</Context.Provider>;
}
