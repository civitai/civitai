import { ActionIcon, Card, Modal, Radio, SegmentedControl, Slider } from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import Cropper, { getInitialCropFromCroppedAreaPercentages } from 'react-easy-crop';
import { Point, Area, MediaSize } from 'react-easy-crop/types';
import { IconZoomIn, IconZoomOut } from '@tabler/icons-react';

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
  const initialAspect = state[0].width / state[0].height;
  const [aspect, setAspect] = useState(initialAspect);

  const availableAspects = useMemo(() => {
    return [
      { value: `${initialAspect}`, label: 'Default' },
      { value: `${3 / 2}`, label: 'Landscape (3:2)' },
      { value: `${1}`, label: 'Square (1:1)' },
      { value: `${2 / 3}`, label: 'Portrait (2:3)' },
    ];
  }, [initialAspect]);

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
    <div className="flex gap-3 max-sm:flex-col">
      <div className="flex flex-1 flex-col gap-3 rounded-md bg-[#000] py-3">
        <SegmentedControl
          onChange={setSelected}
          value={selected}
          data={images.map(({ label }, index) => ({
            label: label ?? `Image ${index + 1}`,
            value: `${index}`,
          }))}
          className="mx-3"
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
      <div className="flex flex-col gap-3 sm:w-40">
        {state.map((image, index) => (
          <div
            key={index}
            className="overflow-hidden rounded-md max-sm:hidden"
            onClick={() => setSelected(`${index}`)}
          >
            <ImageCropper
              {...image}
              aspect={aspect}
              readonly
              classes={{ containerClassName: 'cursor-pointer' }}
            />
          </div>
        ))}
        <Card withBorder>
          <Radio.Group
            size="xs"
            label="Aspect Ratio"
            orientation="vertical"
            value={`${aspect}`}
            onChange={(value) => setAspect(Number(value))}
            spacing="sm"
          >
            {availableAspects.map(({ label, value }) => (
              <Radio key={value} value={value} label={label} />
            ))}
          </Radio.Group>
        </Card>
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
  classes,
}: CroppedImageProps & {
  aspect: number;
  onCropComplete?: (croppedArea: Area, croppedAreaPixels: Area, crop: Point, zoom: number) => void;
  readonly?: boolean;
  minZoom?: number;
  maxZoom?: number;
  classes?: {
    containerClassName?: string;
    mediaClassName?: string;
    cropAreaClassName?: string;
  };
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

  function handleZoomOut() {
    setZoom((z) => Math.max(minZoom, z - 0.5));
  }

  function handleZoomIn() {
    setZoom((z) => Math.min(maxZoom, z + 0.5));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-square">
        <Cropper
          classes={classes}
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
        />
      </div>
      {!readonly && (
        <div className="mx-auto flex w-full max-w-80 items-center gap-2">
          <ActionIcon
            size="sm"
            disabled={zoom === minZoom}
            onClick={handleZoomOut}
            variant="transparent"
          >
            <IconZoomOut />
          </ActionIcon>
          <Slider
            className="flex-1"
            value={zoom}
            onChange={(value) => setZoom(value)}
            min={minZoom}
            max={maxZoom}
            step={0.1}
            precision={1}
          />
          <ActionIcon
            size="sm"
            disabled={zoom === maxZoom}
            onClick={handleZoomIn}
            variant="transparent"
          >
            <IconZoomIn />
          </ActionIcon>
        </div>
      )}
    </div>
  );
}
