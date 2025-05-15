import { LoadingOverlay, SegmentedControl } from '@mantine/core';
import { useEffect } from 'react';
import GenerationErrorBoundary from '~/components/Generation/Error/ErrorBoundary';
import { GenerationFormContent } from '~/components/ImageGeneration/GenerationForm/GenerationForm2';
import { GenerationFormProvider } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import { TextToImageWhatIfProvider } from '~/components/ImageGeneration/GenerationForm/TextToImageWhatIfProvider';
import { VideoGenerationForm } from '~/components/ImageGeneration/GenerationForm/VideoGenerationForm';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';

import { useIsClient } from '~/providers/IsClientProvider';
import { MediaType } from '~/shared/utils/prisma/enums';
import {
  generationFormStore,
  useGenerationFormStore,
  useGenerationStore,
} from '~/store/generation.store';

export function GenerationForm() {
  const type = useGenerationFormStore((state) => state.type);
  const loading = useGenerationStore((state) => state.loading);
  const counter = useGenerationStore((state) => state.counter);
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
            {/* TODO - image remix component */}
            <div className="flex flex-col gap-2 px-3">
              {/* <RemixOfControl /> */}
              <SegmentedControl
                value={type}
                onChange={(v) => generationFormStore.setType(v as MediaType)}
                className="overflow-visible"
                color="blue"
                data={[
                  { label: 'Image', value: 'image' },
                  { label: 'Video', value: 'video' },
                ]}
              />
            </div>
            {type === 'image' && (
              <GenerationFormProvider key={counter}>
                <TextToImageWhatIfProvider>
                  <GenerationFormContent />
                </TextToImageWhatIfProvider>
              </GenerationFormProvider>
            )}
            {type === 'video' && <VideoGenerationForm key={counter} />}
          </ScrollArea>
        </div>
      </GenerationProvider>
    </GenerationErrorBoundary>
  );
}

// function RemixOfControl() {
//   const remixOf = useRemixStore((state) => state.remixOf);
//   console.log({ remixOf });

//   if (!remixOf) return null;

//   return (
//     <TwCard className="border">
//       <div className="flex">
//         {remixOf?.url && (
//           <div className="relative aspect-square w-[100px]">
//             <EdgeMedia
//               src={remixOf.url}
//               type={remixOf.type}
//               width={DEFAULT_EDGE_IMAGE_WIDTH}
//               className="absolute object-cover"
//             />
//           </div>
//         )}
//         <div className="flex flex-1 items-center justify-center p-3">
//           <Text>Remixing {remixOf.type}</Text>
//         </div>
//       </div>
//     </TwCard>
//   );
// }
