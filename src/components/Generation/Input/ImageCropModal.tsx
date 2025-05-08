import { Modal, SegmentedControl } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import Cropper, { getInitialCropFromCroppedAreaPercentages } from 'react-easy-crop';
import { Point, Area, MediaSize } from 'react-easy-crop/types';

type ImageProps = { url: string; width: number; height: number; label?: string };

export function ImageCropModal({ images }: { images: ImageProps[] }) {
  const dialog = useDialogContext();
  const [selected, setSelected] = useState('0');
  const [state, setState] = useState(images);

  return (
    <Modal {...dialog} title="Crop Images">
      <SegmentedControl
        onChange={setSelected}
        value={selected}
        data={images.map(({ label }, index) => ({
          label: label ?? `Image ${index + 1}`,
          value: `${index}`,
        }))}
      />
    </Modal>
  );
}

type CroppedImageProps = ImageProps & {
  zoom: number;
  crop: Point;
  croppedAreaPixels: Area | null;
  croppedArea: Area | null;
};

export function ImageCropperTest({ images }: { images: ImageProps[] }) {
  const [selected, setSelected] = useState('0');
  const [state, setState] = useState<CroppedImageProps[]>(
    images.map((image) => ({
      ...image,
      x: 0,
      y: 0,
      zoom: 1,
      crop: { x: 0, y: 0 },
      croppedArea: null,
      croppedAreaPixels: null,
    }))
  );
  const selectedIndex = Number(selected);
  const image = state[selectedIndex];
  const aspect = state[0].width / state[0].height;

  function handleCropComplete(
    croppedArea: Area,
    croppedAreaPixels: Area,
    crop: Point,
    zoom: number
  ) {
    setState((state) => {
      state[selectedIndex] = {
        ...state[selectedIndex],
        croppedArea,
        croppedAreaPixels,
        crop,
        zoom,
      };
      return [...state];
    });
  }

  return (
    <div className="flex gap-3">
      <div className="flex flex-1 flex-col gap-3">
        <SegmentedControl
          onChange={setSelected}
          value={selected}
          data={images.map(({ label }, index) => ({
            label: label ?? `Image ${index + 1}`,
            value: `${index}`,
          }))}
        />
        <div className="relative aspect-square">
          <ImageCropper
            key={selectedIndex}
            {...image}
            aspect={aspect}
            onCropComplete={handleCropComplete}
          />
        </div>
      </div>
      <div className="flex w-32 flex-col gap-3">
        {state.map((image, index) => (
          <div key={index} className="relative aspect-square">
            <ImageCropper {...image} aspect={aspect} readonly />
          </div>
        ))}
      </div>
    </div>
  );
}

function ImageCropper({
  url,
  width,
  height,
  label,
  aspect,
  croppedArea: initialCroppedArea,
  croppedAreaPixels: initialCroppedAreaPixels,
  zoom: initialZoom,
  crop: initialCrop,
  onCropComplete,
  readonly,
  minZoom = 1,
  maxZoom = 3,
}: CroppedImageProps & {
  aspect: number;
  onCropComplete?: (croppedArea: Area, croppedAreaPixels: Area, crop: Point, zoom: number) => void;
  readonly?: boolean;
  minZoom?: number;
  maxZoom?: number;
}) {
  const [crop, setCrop] = useState<Point>(initialCrop);
  const [zoom, setZoom] = useState(initialZoom);
  const [cropSize, setCropSize] = useState({ width: 0, height: 0 });
  const [mediaSize, setMediaSize] = useState<MediaSize | null>();

  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(initialCroppedAreaPixels);
  const [croppedArea, setCroppedArea] = useState<Area | null>(initialCroppedArea);

  function handleCropComplete(croppedArea: Area, croppedAreaPixels: Area) {
    setCroppedArea(croppedArea);
    setCroppedAreaPixels(croppedAreaPixels);
  }

  useEffect(() => {
    if (croppedArea && croppedAreaPixels && !readonly) {
      onCropComplete?.(croppedArea, croppedAreaPixels, crop, zoom);
    }
  }, [croppedArea, croppedAreaPixels, readonly]);

  useEffect(() => {
    if (readonly && initialCroppedArea && mediaSize) {
      const { crop, zoom } = getInitialCropFromCroppedAreaPercentages(
        initialCroppedArea,
        mediaSize,
        0,
        cropSize,
        minZoom,
        maxZoom
      );
      setCrop(crop);
      setZoom(zoom);
    }
  }, [initialCroppedArea, readonly, mediaSize]);

  return (
    <Cropper
      image={url}
      crop={crop}
      zoom={zoom}
      aspect={aspect}
      onCropChange={!readonly ? setCrop : () => undefined}
      onZoomChange={!readonly ? setZoom : undefined}
      onCropComplete={!readonly ? handleCropComplete : undefined}
      onMediaLoaded={setMediaSize}
      setCropSize={setCropSize}
      minZoom={minZoom}
      maxZoom={maxZoom}
      // initialCroppedAreaPercentages={initialCroppedArea ?? undefined}
      // initialCroppedAreaPixels={initialCroppedAreaPixels ?? undefined}
    />
  );
}
