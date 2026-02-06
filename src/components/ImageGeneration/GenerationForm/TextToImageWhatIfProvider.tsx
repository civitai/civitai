/**
 * TextToImageWhatIfProvider (Legacy)
 *
 * Adapted from civitai TextToImageWhatIfProvider.tsx.
 * Uses whatIfFromGraph instead of getImageWhatIf,
 * and mapDataToGraphInput to convert form values to graph format.
 */

import { useDebouncedValue } from '@mantine/hooks';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useWatch } from 'react-hook-form';
import { useGenerationForm } from './GenerationFormProvider';
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
import { useGenerationGraphStore } from '~/store/generation-graph.store';
import { useDebouncer } from '~/utils/debouncer';
import { usePromptFocusedStore } from '~/components/Generate/Input/InputPrompt';
import { mapDataToGraphInput } from '~/server/services/orchestrator/legacy-metadata-mapper';

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
  const loading = useGenerationGraphStore((state) => state.loading);
  const [query, setQuery] = useState<Record<string, any> | null>(null);
  const promptRef = useRef('');
  const promptFocused = usePromptFocusedStore((x) => x.focused);

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

      delete params.engine;
      if (isFluxStandard && params.fluxUltraRaw && params.fluxMode === fluxUltraAir)
        params.engine = 'flux-pro-raw';
      const imageGenEngine = imageGenModelVersionMap.get(modelVersionId);
      if (imageGenEngine) {
        params.engine = imageGenEngine;
      }

      if (!promptFocused && params.prompt !== undefined) {
        promptRef.current = params.prompt!;
      }

      const parsed = textToImageParamsSchema.parse({
        ...params,
        ...whatIfQueryOverrides,
        prompt: promptRef.current,
      });

      // Build enriched resources with all needed fields:
      // - id, epochNumber, air (for whatIfFromGraph resources)
      // - baseModel, model.type (for mapDataToGraphInput inference)
      const enrichedResources = [
        // Main model (checkpoint)
        removeEmpty({
          id: modelVersionId,
          epochNumber: model?.epochDetails?.epochNumber,
          air: model?.air,
          baseModel: params.baseModel,
          model: { type: model?.model?.type ?? 'Checkpoint' },
        }),
        // Additional resources (LoRAs, embeddings, etc.)
        ...(resources?.map((r) =>
          removeEmpty({
            id: r.id as number,
            epochNumber: r.epochDetails?.epochNumber,
            air: r.air,
            baseModel: r.baseModel ?? params.baseModel,
            model: { type: r.model?.type ?? 'LORA' },
          })
        ) ?? []),
        // VAE
        ...(vae?.id
          ? [
              removeEmpty({
                id: vae.id,
                epochNumber: vae.epochDetails?.epochNumber,
                air: vae.air,
                baseModel: vae.baseModel ?? params.baseModel,
                model: { type: 'VAE' as const },
              }),
            ]
          : []),
      ];

      // Convert to graph input format using the mapper
      // Don't pass stepType - let resolveWorkflow infer it from params and ecosystem
      const graphInput = mapDataToGraphInput(
        removeEmpty(parsed),
        enrichedResources as any
      );

      // Add resources to graph input (needed for whatIfFromGraph)
      graphInput.resources = enrichedResources;

      setQuery(graphInput);
    });
  }, [watched, promptFocused]);

  // Use whatIfFromGraph instead of getImageWhatIf
  const result = trpc.orchestrator.whatIfFromGraph.useQuery(query as any, {
    enabled: !!currentUser && !loading && !!query,
  });

  return <Context.Provider value={result}>{children}</Context.Provider>;
}
