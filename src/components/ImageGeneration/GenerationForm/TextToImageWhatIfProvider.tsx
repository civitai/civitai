import { useDebouncedValue } from '@mantine/hooks';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useWatch } from 'react-hook-form';
import { useGenerationForm } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import { generationConfig } from '~/server/common/constants';
import type { TextToImageInput } from '~/server/schema/orchestrator/textToImage.schema';
import {
  fluxStandardAir,
  fluxUltraAir,
  getBaseModelSetType,
  getIsFlux,
  getIsFluxStandard,
  getIsSD3,
  getSizeFromAspectRatio,
  whatIfQueryOverrides,
  fluxModelId,
} from '~/shared/constants/generation.constants';
import { trpc } from '~/utils/trpc';

import type { UseTRPCQueryResult } from '@trpc/react-query/shared';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { GenerationWhatIfResponse } from '~/server/services/orchestrator/types';
import { parseAIR } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { removeEmpty } from '~/utils/object-helpers';
import { imageGenModelVersionMap } from '~/shared/orchestrator/ImageGen/imageGen.config';
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

  const query = useMemo(() => {
    const values = { ...form.getValues(), ...watched };
    const { model, resources, vae, ...params } = values;
    const defaultModel =
      generationConfig[getBaseModelSetType(params.baseModel) as keyof typeof generationConfig]
        ?.checkpoint ?? model;

    if (params.aspectRatio) {
      const size = getSizeFromAspectRatio(params.aspectRatio, params.baseModel);
      if (size) {
        params.width = size.width;
        params.height = size.height;
      }
    }

    let modelVersionId = model?.id ?? defaultModel.id;
    const isFlux = getIsFlux(params.baseModel);
    const isFluxStandard = getIsFluxStandard(model?.model?.id ?? defaultModel.model.id);
    if (isFlux && params.fluxMode && isFluxStandard) {
      const { version } = parseAIR(params.fluxMode);
      modelVersionId = version;
      if (params.fluxMode !== fluxStandardAir) params.priority = 'low';
    }

    // if (params.fluxUltraRaw) params.engine = 'flux-pro-raw';
    // else if (model?.id === generationConfig.OpenAI.checkpoint.id) params.engine = 'openai';
    // else params.engine = undefined;

    delete params.engine;
    if (isFluxStandard && params.fluxUltraRaw && params.fluxMode === fluxUltraAir)
      params.engine = 'flux-pro-raw';
    const imageGenEngine = imageGenModelVersionMap.get(modelVersionId);
    if (imageGenEngine) params.engine = imageGenEngine;

    const additionalResources =
      resources?.map((x) => {
        if (!x.epochDetails?.epochNumber) return { id: x.id as number };
        return { id: x.id as number, epochNumber: x.epochDetails?.epochNumber };
      }) ?? [];

    return {
      resources: [{ id: modelVersionId }, ...additionalResources],
      params: removeEmpty({
        ...params,
        ...whatIfQueryOverrides,
      } as TextToImageInput),
    };
  }, [watched]);

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
