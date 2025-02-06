import { useDebouncedValue } from '@mantine/hooks';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useWatch } from 'react-hook-form';
import { useGenerationForm } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import { generationConfig } from '~/server/common/constants';
import { TextToImageInput } from '~/server/schema/orchestrator/textToImage.schema';
import {
  fluxStandardAir,
  getBaseModelSetType,
  getIsFlux,
  getIsSD3,
  getSizeFromAspectRatio,
  whatIfQueryOverrides,
} from '~/shared/constants/generation.constants';
import { trpc } from '~/utils/trpc';

import { UseTRPCQueryResult } from '@trpc/react-query/shared';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { GenerationWhatIfResponse } from '~/server/services/orchestrator/types';
import { parseAIR } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
// import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

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
  const currentUser = useCurrentUser();
  const watched = useWatch({ control: form.control });
  const [enabled, setEnabled] = useState(false);
  const defaultModel =
    generationConfig[getBaseModelSetType(watched.baseModel) as keyof typeof generationConfig]
      ?.checkpoint ?? watched.model;

  const query = useMemo(() => {
    const { model, resources = [], vae, ...params } = watched;
    if (params.aspectRatio) {
      const size = getSizeFromAspectRatio(Number(params.aspectRatio), params.baseModel);
      if (size) {
        params.width = size.width;
        params.height = size.height;
      }
    }

    let modelId = defaultModel.id;
    const isFlux = getIsFlux(watched.baseModel);
    if (isFlux && watched.fluxMode) {
      const { version } = parseAIR(watched.fluxMode);
      modelId = version;
      if (watched.fluxMode !== fluxStandardAir) params.priority = 'low';
    }

    const isSD3 = getIsSD3(watched.baseModel);
    if (isSD3 && model?.id) {
      modelId = model.id;
    }
    const additionalResources = resources.map((x) => (x ? x.id : undefined)).filter(isDefined);

    return {
      resources: [modelId, ...additionalResources],
      params: {
        ...params,
        ...whatIfQueryOverrides,
      } as TextToImageInput,
    };
  }, [watched, defaultModel.id]);

  useEffect(() => {
    // enable after timeout to prevent multiple requests as form data is set
    setTimeout(() => setEnabled(true), 150);
  }, []);

  const [debounced] = useDebouncedValue(query, 100);

  const result = trpc.orchestrator.getImageWhatIf.useQuery(debounced, {
    enabled: !!currentUser && debounced && enabled,
  });

  return <Context.Provider value={result}>{children}</Context.Provider>;
}
