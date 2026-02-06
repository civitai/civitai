/**
 * GenerationForm (Legacy)
 *
 * Combined image and video generation form with media type switching.
 * Adapted from civitai GenerationForm.tsx.
 * Uses generation-graph.store for loading state and generation-form.store for UI preferences.
 */

import { LoadingOverlay, SegmentedControl } from '@mantine/core';
import { useEffect } from 'react';
import GenerationErrorBoundary from '~/components/Generation/Error/ErrorBoundary';
import { VideoGenerationFormWrapper } from '~/components/Generation/Video/VideoGenerationFormWrapper';
import { VideoGenerationProvider } from '~/components/Generation/Video/VideoGenerationProvider';
import { GenerationFormContent } from '~/components/ImageGeneration/GenerationForm/GenerationForm2';
import { GenerationFormProvider } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import { TextToImageWhatIfProvider } from '~/components/ImageGeneration/GenerationForm/TextToImageWhatIfProvider';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';

import { useIsClient } from '~/providers/IsClientProvider';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { useGenerationGraphStore } from '~/store/generation-graph.store';
import { generationFormStore, useGenerationFormStore } from '~/store/generation-form.store';

export function GenerationForm() {
  const type = useGenerationFormStore((state) => state.type);
  const loading = useGenerationGraphStore((state) => state.loading);
  const counter = useGenerationGraphStore((state) => state.counter);
  const isClient = useIsClient();

  // !important - this is to move the 'tip' values to its own local storage bucket
  useEffect(() => {
    const stored = localStorage.getItem('generation-form-2');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (typeof parsed !== 'object' || !('state' in parsed)) return;
      const { creatorTip, civitaiTip, ...state } = parsed.state;
      if (creatorTip !== undefined && civitaiTip !== undefined) {
        localStorage.setItem('generation-form-2', JSON.stringify({ ...parsed, state }));
      }
    }
  }, []);

  if (!isClient) return null;

  return (
    <GenerationErrorBoundary>
      <GenerationProvider>
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <LoadingOverlay visible={loading} />
          <ScrollArea
            scrollRestore={{ key: 'generation-form' }}
            pt={0}
            className="flex flex-col gap-2"
          >
            <div className="flex flex-col gap-2 px-3">
              <SegmentedControl
                value={type}
                onChange={(v) => generationFormStore.setType(v as MediaType)}
                className="overflow-visible"
                color="blue"
                data={[
                  { label: 'Image', value: 'image' },
                  { label: 'Video', value: 'video' },
                ]}
                suppressHydrationWarning
              />
            </div>
            {type === 'image' && (
              <GenerationFormProvider key={counter}>
                <TextToImageWhatIfProvider>
                  <GenerationFormContent />
                </TextToImageWhatIfProvider>
              </GenerationFormProvider>
            )}
            {type === 'video' && (
              <VideoGenerationProvider>
                <VideoGenerationFormWrapper />
              </VideoGenerationProvider>
            )}
          </ScrollArea>
        </div>
      </GenerationProvider>
    </GenerationErrorBoundary>
  );
}
