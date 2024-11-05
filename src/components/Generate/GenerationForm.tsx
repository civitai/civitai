import { SegmentedControl } from '@mantine/core';
import { useEffect } from 'react';
import { GenerationFormContent } from '~/components/ImageGeneration/GenerationForm/GenerationForm2';
import { GenerationFormProvider } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import { TextToImageWhatIfProvider } from '~/components/ImageGeneration/GenerationForm/TextToImageWhatIfProvider';
import { VideoGenerationForm } from '~/components/ImageGeneration/GenerationForm/VideoGenerationForm';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useIsClient } from '~/providers/IsClientProvider';
import { generationStore, useGenerationStore } from '~/store/generation.store';
import { useTipStore } from '~/store/tip.store';

export function GenerationForm() {
  const type = useGenerationStore((state) => state.type);
  const isClient = useIsClient();

  // !important - this is to move the 'tip' values to its own local storage bucket
  useEffect(() => {
    const stored = localStorage.getItem('generation-form-2');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (typeof parsed !== 'object' || !('state' in parsed)) return;
      const { creatorTip, civitaiTip, ...state } = parsed.state;
      if (creatorTip !== undefined && civitaiTip !== undefined) {
        useTipStore.setState({ creatorTip, civitaiTip });
        localStorage.setItem('generation-form-2', JSON.stringify({ ...parsed, state }));
      }
    }
  }, []);

  if (!isClient) return null;

  return (
    <ScrollArea scrollRestore={{ key: 'generation-form' }} pt={0} className="flex flex-col gap-2">
      {/* TODO - image remix component */}
      <SegmentedControl
        value={type}
        onChange={generationStore.setType}
        className="mx-3 overflow-visible"
        color="blue"
        data={[
          { label: 'Image', value: 'image' },
          { label: 'Video', value: 'video' },
        ]}
      />
      {type === 'image' && (
        <GenerationFormProvider>
          <TextToImageWhatIfProvider>
            <GenerationFormContent />
          </TextToImageWhatIfProvider>
        </GenerationFormProvider>
      )}
      {type === 'video' && <VideoGenerationForm />}
    </ScrollArea>
  );
}
