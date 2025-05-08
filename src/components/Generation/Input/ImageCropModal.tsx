import { Modal, SegmentedControl } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import Cropper from 'react-easy-crop';
import { Point, Area } from 'react-easy-crop/types';

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
  x: number;
  y: number;
  zoom: number;
  crop: Point;
};

export function ImageCropperTest({ images }: { images: ImageProps[] }) {
  const [selected, setSelected] = useState('0');
  const [state, setState] = useState(
    images.map((image) => ({ ...image, x: 0, y: 0, zoom: 1, crop: { x: 0, y: 0 } }))
  );
  const selectedIndex = Number(selected);
  const image = state[selectedIndex];
  const aspect = state[0].width / state[0].height;

  function handleCropComplete(croppedAreaPixels: Area, crop: Point, zoom: number) {
    setState((state) => {
      state[selectedIndex] = { ...state[selectedIndex], ...croppedAreaPixels, crop, zoom };
      return [...state];
    });
  }

  return (
    <div className="flex flex-1 flex-col gap-3 pb-12">
      <SegmentedControl
        onChange={setSelected}
        value={selected}
        data={images.map(({ label }, index) => ({
          label: label ?? `Image ${index + 1}`,
          value: `${index}`,
        }))}
      />
      <ImageCropper
        key={selectedIndex}
        {...image}
        aspect={aspect}
        onCropComplete={handleCropComplete}
      />
    </div>
  );
}

function ImageCropper({
  url,
  width,
  height,
  label,
  aspect,
  x,
  y,
  zoom: initialZoom,
  crop: initialCrop,
  onCropComplete,
}: CroppedImageProps & {
  aspect: number;
  onCropComplete?: (croppedAreaPixels: Area, crop: Point, zoom: number) => void;
}) {
  const [crop, setCrop] = useState<Point>(initialCrop);
  const [zoom, setZoom] = useState(initialZoom);

  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);

  function handleCropComplete(croppedArea: Area, croppedAreaPixels: Area) {
    setCroppedAreaPixels(croppedAreaPixels);
  }

  useEffect(() => {
    if (croppedAreaPixels) {
      onCropComplete?.(croppedAreaPixels, crop, zoom);
    }
  }, [croppedAreaPixels]);

  return (
    <div className="relative aspect-square">
      <Cropper
        image={url}
        crop={crop}
        zoom={zoom}
        aspect={aspect}
        onCropChange={setCrop}
        onCropComplete={handleCropComplete}
        onZoomChange={setZoom}
      />
    </div>
  );
}
