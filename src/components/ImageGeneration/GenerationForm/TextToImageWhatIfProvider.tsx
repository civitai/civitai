import { useDebouncedValue } from '@mantine/hooks';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useWatch } from 'react-hook-form';
import { useGenerationForm } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import { generationConfig } from '~/server/common/constants';
import { textToImageParamsSchema } from '~/server/schema/orchestrator/textToImage.schema';
import {
  fluxStandardAir,
  fluxKreaAir,
  fluxUltraAir,
  getBaseModelSetType,
  getIsFlux,
  getIsFluxStandard,
  getSizeFromAspectRatio,
  whatIfQueryOverrides,
} from '~/shared/constants/generation.constants';
import { trpc } from '~/utils/trpc';

import type { UseTRPCQueryResult } from '@trpc/react-query/shared';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { GenerationWhatIfResponse } from '~/server/services/orchestrator/types';
import { parseAIR } from '~/utils/string-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { imageGenModelVersionMap } from '~/shared/orchestrator/ImageGen/imageGen.config';
import { useGenerationStore } from '~/store/generation.store';
import { useDebouncer } from '~/utils/debouncer';
import { usePromptFocusedStore } from '~/components/Generate/Input/InputPrompt';
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
  const loading = useGenerationStore((state) => state.loading);
  const [query, setQuery] = useState<Record<string, any> | null>(null);
  const promptRef = useRef('');
  const promptFocused = usePromptFocusedStore((x) => x.focused);

  // const query = useMemo(() => {
  //   const values = { ...form.getValues(), ...watched };
  //   const { model, resources, vae, ...params } = values;
  //   const defaultModel =
  //     generationConfig[getBaseModelSetType(params.baseModel) as keyof typeof generationConfig]
  //       ?.checkpoint ?? model;

  //   if (params.aspectRatio) {
  //     const size = getSizeFromAspectRatio(params.aspectRatio, params.baseModel);
  //     if (size) {
  //       (params as Record<string, any>).width = size.width;
  //       (params as Record<string, any>).height = size.height;
  //     }
  //   }

  //   let modelVersionId = model?.id ?? defaultModel.id;
  //   const isFlux = getIsFlux(params.baseModel);
  //   const isFluxStandard = getIsFluxStandard(model?.model?.id ?? defaultModel.model.id);
  //   if (isFlux && params.fluxMode && isFluxStandard) {
  //     const { version } = parseAIR(params.fluxMode);
  //     modelVersionId = version;
  //     if (params.fluxMode !== fluxStandardAir) params.priority = 'low';
  //   }

  //   // if (params.fluxUltraRaw) params.engine = 'flux-pro-raw';
  //   // else if (model?.id === generationConfig.OpenAI.checkpoint.id) params.engine = 'openai';
  //   // else params.engine = undefined;

  //   delete params.engine;
  //   if (isFluxStandard && params.fluxUltraRaw && params.fluxMode === fluxUltraAir)
  //     params.engine = 'flux-pro-raw';
  //   const imageGenEngine = imageGenModelVersionMap.get(modelVersionId);
  //   if (imageGenEngine) {
  //     params.engine = imageGenEngine;
  //   }

  //   const additionalResources =
  //     resources?.map((x) => {
  //       if (!x.epochDetails?.epochNumber) return { id: x.id as number };
  //       return { id: x.id as number, epochNumber: x.epochDetails?.epochNumber };
  //     }) ?? [];

  //   const parsed = textToImageParamsSchema.parse({
  //     ...params,
  //     ...whatIfQueryOverrides,
  //   });

  //   return {
  //     resources: [{ id: modelVersionId }, ...additionalResources],
  //     params: removeEmpty(parsed),
  //   };
  // }, [watched]);

  const debouncer = useDebouncer(150);
  useEffect(() => {
    debouncer(() => {
      const values = { ...form.getValues(), ...watched };
      const { model, resources, vae, ...params } = values;
      const defaultModel =
        generationConfig[getBaseModelSetType(params.baseModel) as keyof typeof generationConfig]
          ?.checkpoint ?? model;

      let modelVersionId = model?.id ?? defaultModel.id;

      if (params.aspectRatio) {
        const size = getSizeFromAspectRatio(params.aspectRatio, params.baseModel, modelVersionId);
        if (size) {
          (params as Record<string, any>).width = size.width;
          (params as Record<string, any>).height = size.height;
        }
      }
      const isFlux = getIsFlux(params.baseModel);
      const isFluxStandard = getIsFluxStandard(model?.model?.id ?? defaultModel.model.id);
      if (isFlux && params.fluxMode && isFluxStandard) {
        const { version } = parseAIR(params.fluxMode);
        modelVersionId = version;
        if (params.fluxMode !== fluxStandardAir && params.fluxMode !== fluxKreaAir)
          params.priority = 'low';
      }

      // if (params.fluxUltraRaw) params.engine = 'flux-pro-raw';
      // else if (model?.id === generationConfig.OpenAI.checkpoint.id) params.engine = 'openai';
      // else params.engine = undefined;

      delete params.engine;
      if (isFluxStandard && params.fluxUltraRaw && params.fluxMode === fluxUltraAir)
        params.engine = 'flux-pro-raw';
      const imageGenEngine = imageGenModelVersionMap.get(modelVersionId);
      if (imageGenEngine) {
        params.engine = imageGenEngine;
      }

      const additionalResources =
        resources?.map((x) => {
          return { id: x.id as number, epochNumber: x.epochDetails?.epochNumber, air: x.air };
        }) ?? [];

      if (!promptFocused && params.prompt !== undefined) {
        promptRef.current = params.prompt!;
      }

      const parsed = textToImageParamsSchema.parse({
        ...params,
        ...whatIfQueryOverrides,
        prompt: promptRef.current,
      });

      setQuery({
        resources: [{ id: modelVersionId }, ...additionalResources],
        params: removeEmpty(parsed),
      });
    });
  }, [watched, promptFocused]);

  // useEffect(() => {
  //   // enable after timeout to prevent multiple requests as form data is set
  //   setTimeout(() => setEnabled(true), 300);
  // }, []);

  // const [debounced] = useDebouncedValue(query, 150);

  const result = trpc.orchestrator.getImageWhatIf.useQuery(query as any, {
    enabled: !!currentUser && !loading && !!query,
  });

  return <Context.Provider value={result}>{children}</Context.Provider>;
}
