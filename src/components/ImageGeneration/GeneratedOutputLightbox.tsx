import { Modal, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import type { EmblaCarouselType } from 'embla-carousel';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import {
  matchesMarkerTags,
  useGetTextToImageRequestsImages,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';

import { GeneratedOutput } from './GeneratedOutput';

export default function GeneratedOutputLightbox({
  imageId,
  workflowId,
}: {
  imageId: string;
  workflowId: string;
}) {
  const dialog = useDialogContext();
  const { requests, markerTags, isLoading } = useGetTextToImageRequestsImages();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const [embla, setEmbla] = useState<EmblaCarouselType | null>(null);

  useHotkeys([
    ['ArrowLeft', () => embla?.scrollPrev()],
    ['ArrowRight', () => embla?.scrollNext()],
  ]);

  const images = useMemo(
    () =>
      (requests ?? []).flatMap((r) =>
        r.succeededOutput.filter((img) => matchesMarkerTags(img, markerTags))
      ),
    [requests, markerTags]
  );

  useEffect(() => {
    if (!isLoading && requests !== undefined && images.length === 0) dialog.onClose();
  }, [isLoading, requests, images.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const imageKey = (img: { id: string; workflow: { id: string } }) =>
    `${img.workflow.id}_${img.id}`;
  const currentImageKeyRef = useRef(imageKey({ id: imageId, workflow: { id: workflowId } }));
  const initialSlide = images.findIndex(
    (item) => item.id === imageId && item.workflow.id === workflowId
  );
  const [slide, setSlide] = useState(initialSlide > -1 ? initialSlide : 0);

  const imagesRef = useRef(images);
  imagesRef.current = images;

  const handleSlideChange = (index: number) => {
    setSlide(index);
    const image = imagesRef.current[index];
    if (image) {
      currentImageKeyRef.current = imageKey(image);
    }
  };

  useEffect(() => {
    if (!embla) return;

    const desiredIndex = images.findIndex((item) => imageKey(item) === currentImageKeyRef.current);

    if (desiredIndex === -1) {
      if (images.length > 0) {
        const nextIndex = Math.min(slide, images.length - 1);
        currentImageKeyRef.current = imageKey(images[nextIndex]);
        embla.reInit({ startIndex: nextIndex });
        setSlide(nextIndex);
      }
    } else {
      embla.reInit({ startIndex: desiredIndex });
      if (desiredIndex !== slide) setSlide(desiredIndex);
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
          watchSlides={false}
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
                      <GeneratedOutput image={image} isLightbox isActiveSlide={index === slide} />
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
        {images?.[slide] && (
          <GenerationDetails
            label="Generation Details"
            params={{ ...images[slide].params, seed: images[slide].seed }}
            labelWidth={150}
            paperProps={{ radius: 0 }}
            controlProps={{
              style: {
                backgroundColor:
                  colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2],
              },
            }}
          />
        )}
      </div>
    </Modal>
  );
}
