import { Modal, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import type { EmblaCarouselType } from 'embla-carousel';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import { useGetTextToImageRequestsImages } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';

import { GeneratedImage } from './GeneratedImage';

export default function GeneratedImageLightbox({
  imageId,
  workflowId,
}: {
  imageId: string;
  workflowId: string;
}) {
  const dialog = useDialogContext();
  const { requests, isLoading } = useGetTextToImageRequestsImages();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const [embla, setEmbla] = useState<EmblaCarouselType | null>(null);

  useHotkeys([
    ['ArrowLeft', () => embla?.scrollPrev()],
    ['ArrowRight', () => embla?.scrollNext()],
  ]);

  // Build flat image list across all loaded workflows
  const images = useMemo(
    () =>
      (requests ?? []).flatMap((request) => {
        const { steps, ...workflow } = request;
        return steps.flatMap(({ images, ...step }) =>
          images
            .filter((x) => x.status === 'succeeded' && !x.blockedReason)
            .map((image) => ({
              ...image,
              params: { ...step.params, seed: image.seed },
              step,
              workflow,
            }))
        );
      }),
    [requests]
  );

  // Close if the initial workflow isn't in the feed data after loading
  const hasWorkflow = requests?.some((x) => x.id === workflowId);
  useEffect(() => {
    if (!isLoading && !hasWorkflow) dialog.onClose();
  }, [isLoading, hasWorkflow]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentImageIdRef = useRef(imageId);
  const initialSlide = images.findIndex(
    (item) => item.id === imageId && item.workflow.id === workflowId
  );
  const [slide, setSlide] = useState(initialSlide > -1 ? initialSlide : 0);

  const handleSlideChange = (index: number) => {
    setSlide(index);
    const image = images[index];
    if (image) {
      currentImageIdRef.current = image.id;
    }
  };

  // When images array shifts, re-sync slide index to the tracked image
  useEffect(() => {
    const newIndex = images.findIndex((item) => item.id === currentImageIdRef.current);
    if (newIndex !== -1 && newIndex !== slide) {
      embla?.scrollTo(newIndex, true);
      setSlide(newIndex);
    }
  }, [images, embla]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal
      {...dialog}
      closeButtonProps={{
        'aria-label': 'Close lightbox',
      }}
      fullScreen
      withOverlay={false}
      withinPortal={!dialog.target}
      zIndex={dialog.target ? undefined : 400}
      styles={{
        inner: { position: 'absolute' },
        content: { display: 'flex', flexDirection: 'column', overflow: 'hidden' },
        header: { position: 'absolute', right: 0, zIndex: 10 },
        body: { flex: 1, minHeight: 0, overflow: 'hidden', padding: 16 },
      }}
    >
      <IntersectionObserverProvider id="generated-image-lightbox">
        <Embla
          align="center"
          withControls
          controlSize={40}
          startIndex={slide}
          loop
          onSlideChange={handleSlideChange}
          withKeyboardEvents={false}
          setEmbla={setEmbla}
          className="h-full"
        >
          <Embla.Viewport className="h-full">
            <Embla.Container className="flex h-full">
              {images.map((image, index) => (
                <Embla.Slide
                  key={`${image.workflow.id}_${image.id}`}
                  index={index}
                  className="flex flex-[0_0_100%] items-center justify-center"
                >
                  {image.url &&
                    (Math.abs(index - slide) <= 1 ||
                      Math.abs(index - slide) >= images.length - 1) && (
                      <GeneratedImage
                        image={image}
                        request={image.workflow}
                        step={image.step}
                        isLightbox
                      />
                    )}
                </Embla.Slide>
              ))}
            </Embla.Container>
          </Embla.Viewport>
        </Embla>
      </IntersectionObserverProvider>
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          right: 0,
          width: '100%',
          maxWidth: 450,
          zIndex: 10,
        }}
      >
        <GenerationDetails
          label="Generation Details"
          params={images?.[slide]?.params}
          labelWidth={150}
          paperProps={{ radius: 0 }}
          controlProps={{
            style: {
              backgroundColor: colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2],
            },
          }}
        />
      </div>
    </Modal>
  );
}
