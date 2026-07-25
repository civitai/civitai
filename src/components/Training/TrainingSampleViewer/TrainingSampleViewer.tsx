import {
  ActionIcon,
  Badge,
  Center,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconZoomIn,
  IconZoomOut,
} from '@tabler/icons-react';
import { useHotkeys } from '@mantine/hooks';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CopyButton } from '~/components/CopyButton/CopyButton';

export type TrainingSampleEpoch = {
  epochNumber: number;
  sampleImages: string[];
};

// Unzoomed rendering is `object-contain` capped at natural size, so 2x the intrinsic pixels is
// always a visible magnification — and never interpolates a sample beyond double its real detail.
const ZOOM_FACTOR = 2;

export type TrainingSampleViewerProps = {
  epochs: TrainingSampleEpoch[];
  prompts: string[];
  isVideo: boolean;
  epochIndex: number;
  sampleIndex: number;
};

// A sample that failed to render is stored as an empty string in place, so presence is
// emptiness, never array length.
export const hasSampleAt = (epoch: TrainingSampleEpoch | undefined, index: number) =>
  !!epoch?.sampleImages?.[index];

export default function TrainingSampleViewer({
  epochs,
  prompts,
  isVideo,
  epochIndex: initialEpochIndex,
  sampleIndex: initialSampleIndex,
}: TrainingSampleViewerProps) {
  const dialog = useDialogContext();
  const [epochIndex, setEpochIndex] = useState(initialEpochIndex);
  const [sampleIndex, setSampleIndex] = useState(initialSampleIndex);
  const [zoomed, setZoomed] = useState(false);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  const epoch = epochs[epochIndex];
  const samples = epoch?.sampleImages ?? [];
  const url = samples[sampleIndex];
  const prompt = prompts[sampleIndex];

  // Epochs are laid out newest-first, so "up" is a later epoch. Both axes skip past samples that
  // were never produced so navigation can never land on an empty frame.
  const findEpochWithSample = (step: number) => {
    for (let i = epochIndex + step; i >= 0 && i < epochs.length; i += step) {
      if (hasSampleAt(epochs[i], sampleIndex)) return i;
    }
    return undefined;
  };

  const findSampleInEpoch = (step: number) => {
    for (let i = sampleIndex + step; i >= 0 && i < samples.length; i += step) {
      if (samples[i]) return i;
    }
    return undefined;
  };

  const prevEpochIndex = findEpochWithSample(-1);
  const nextEpochIndex = findEpochWithSample(1);
  const prevSampleIndex = findSampleInEpoch(-1);
  const nextSampleIndex = findSampleInEpoch(1);

  const navigableCount = samples.filter(Boolean).length;
  const navigablePosition = samples.slice(0, sampleIndex + 1).filter(Boolean).length;

  useEffect(() => {
    setStatus('loading');
    setZoomed(false);
    setNatural(null);
  }, [url]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    if (!zoomed) {
      pane.scrollTo(0, 0);
      return;
    }
    pane.scrollLeft = (pane.scrollWidth - pane.clientWidth) / 2;
    pane.scrollTop = (pane.scrollHeight - pane.clientHeight) / 2;
  }, [zoomed, url]);

  const missing = !epoch || !url;
  useEffect(() => {
    if (missing) dialog.onClose();
  }, [missing]); // eslint-disable-line react-hooks/exhaustive-deps

  const isTopLevel = dialog.closeOnEscape !== false;
  useHotkeys(
    isTopLevel
      ? [
          [
            'ArrowLeft',
            () => prevSampleIndex !== undefined && setSampleIndex(prevSampleIndex),
            { preventDefault: prevSampleIndex !== undefined },
          ],
          [
            'ArrowRight',
            () => nextSampleIndex !== undefined && setSampleIndex(nextSampleIndex),
            { preventDefault: nextSampleIndex !== undefined },
          ],
          [
            'ArrowUp',
            () => prevEpochIndex !== undefined && setEpochIndex(prevEpochIndex),
            { preventDefault: prevEpochIndex !== undefined },
          ],
          [
            'ArrowDown',
            () => nextEpochIndex !== undefined && setEpochIndex(nextEpochIndex),
            { preventDefault: nextEpochIndex !== undefined },
          ],
        ]
      : []
  );

  if (missing) return null;

  const canZoom = status === 'loaded' && !!natural;
  const zoomActive = zoomed && !!natural;

  const mediaClassName = clsx(
    'transition-opacity',
    status === 'loaded' ? 'opacity-100' : 'opacity-0',
    zoomActive ? 'm-auto max-w-none shrink-0' : 'max-h-full max-w-full object-contain'
  );

  const zoomStyle = zoomActive
    ? { width: natural.width * ZOOM_FACTOR, height: natural.height * ZOOM_FACTOR }
    : undefined;

  const zoomLabel = zoomed ? 'Fit to screen' : `Magnify ${ZOOM_FACTOR}x`;
  const toggleZoom = () => canZoom && setZoomed((z) => !z);

  return (
    <Modal
      {...dialog}
      fullScreen
      withOverlay={false}
      withinPortal={!dialog.target}
      closeButtonProps={{ 'aria-label': 'Close sample viewer' }}
      styles={{
        inner: { position: 'absolute' },
        content: { display: 'flex', flexDirection: 'column', overflow: 'hidden' },
        header: { position: 'absolute', right: 0, zIndex: 10 },
        body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 16 },
      }}
    >
      <Group justify="space-between" wrap="nowrap" pr={48} mb="xs">
        <Group gap="xs" wrap="nowrap">
          <Badge size="lg" variant="filled">
            Epoch #{epoch.epochNumber}
          </Badge>
          <Text size="sm" c="dimmed">
            {epochIndex + 1} of {epochs.length} epochs &middot; sample {navigablePosition} of{' '}
            {navigableCount}
          </Text>
        </Group>
        {canZoom && (
          <Tooltip label={zoomLabel} withArrow>
            <ActionIcon size="lg" variant="light" aria-label={zoomLabel} onClick={toggleZoom}>
              {zoomed ? <IconZoomOut size={20} /> : <IconZoomIn size={20} />}
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      <div className="relative flex min-h-0 flex-1">
        <div
          ref={paneRef}
          className={clsx(
            'flex flex-1',
            // `m-auto` on the media rather than flex centering — a centered flex item clamps
            // scrollLeft/Top at 0, making the start edge of a zoomed sample unreachable.
            zoomActive ? 'overflow-auto' : 'items-center justify-center overflow-hidden'
          )}
        >
          {status === 'loading' && (
            <Center className="absolute inset-0">
              <Loader />
            </Center>
          )}
          {status === 'error' && (
            <Center className="absolute inset-0">
              <Stack align="center" gap="xs">
                <IconAlertTriangle size={40} color="var(--mantine-color-yellow-6)" />
                <Text>This sample could not be loaded.</Text>
                <Text size="sm" c="dimmed">
                  Sample media is removed 30 days after training completes.
                </Text>
              </Stack>
            </Center>
          )}
          {isVideo ? (
            // `src` on the element, not a child <source> — resource errors on <source> do not
            // bubble, leaving a failed sample stuck on the loading spinner.
            <video
              key={url}
              src={url}
              loop
              playsInline
              disablePictureInPicture
              muted
              autoPlay
              controls
              className={mediaClassName}
              style={zoomStyle}
              onLoadedData={(e) => {
                const el = e.currentTarget;
                setStatus('loaded');
                if (el.videoWidth && el.videoHeight)
                  setNatural({ width: el.videoWidth, height: el.videoHeight });
              }}
              onError={() => setStatus('error')}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={url}
              alt={`Epoch ${epoch.epochNumber} sample ${navigablePosition}`}
              className={clsx(
                mediaClassName,
                canZoom && (zoomed ? 'cursor-zoom-out' : 'cursor-zoom-in')
              )}
              style={zoomStyle}
              onClick={toggleZoom}
              onLoad={(e) => {
                const el = e.currentTarget;
                setStatus('loaded');
                if (el.naturalWidth && el.naturalHeight)
                  setNatural({ width: el.naturalWidth, height: el.naturalHeight });
              }}
              onError={() => setStatus('error')}
            />
          )}
        </div>

        <NavButton
          label={
            prevSampleIndex !== undefined
              ? 'Previous sample (Left)'
              : 'No earlier sample in this epoch'
          }
          className="left-2 top-1/2 -translate-y-1/2"
          disabled={prevSampleIndex === undefined}
          onClick={() => prevSampleIndex !== undefined && setSampleIndex(prevSampleIndex)}
        >
          <IconChevronLeft size={24} />
        </NavButton>
        <NavButton
          label={
            nextSampleIndex !== undefined ? 'Next sample (Right)' : 'No later sample in this epoch'
          }
          className="right-2 top-1/2 -translate-y-1/2"
          disabled={nextSampleIndex === undefined}
          onClick={() => nextSampleIndex !== undefined && setSampleIndex(nextSampleIndex)}
        >
          <IconChevronRight size={24} />
        </NavButton>
        <NavButton
          label={
            prevEpochIndex !== undefined
              ? `Same sample in epoch #${epochs[prevEpochIndex].epochNumber} (Up)`
              : 'No later epoch with this sample'
          }
          className="left-1/2 top-2 -translate-x-1/2"
          disabled={prevEpochIndex === undefined}
          onClick={() => prevEpochIndex !== undefined && setEpochIndex(prevEpochIndex)}
        >
          <IconChevronUp size={24} />
        </NavButton>
        <NavButton
          label={
            nextEpochIndex !== undefined
              ? `Same sample in epoch #${epochs[nextEpochIndex].epochNumber} (Down)`
              : 'No earlier epoch with this sample'
          }
          className="bottom-2 left-1/2 -translate-x-1/2"
          disabled={nextEpochIndex === undefined}
          onClick={() => nextEpochIndex !== undefined && setEpochIndex(nextEpochIndex)}
        >
          <IconChevronDown size={24} />
        </NavButton>
      </div>

      <Group align="flex-start" wrap="nowrap" gap="xs" mt="xs">
        <Text size="sm" c="dimmed" className="shrink-0">
          Prompt
        </Text>
        <Text size="sm" className="flex-1 whitespace-pre-wrap break-words">
          {prompt?.trim().length ? prompt : '(no prompt provided)'}
        </Text>
        {!!prompt?.trim().length && (
          <CopyButton value={prompt}>
            {({ copy, copied, Icon, color }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy prompt'} withArrow>
                <ActionIcon variant="subtle" color={color} onClick={copy}>
                  <Icon size={16} />
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        )}
      </Group>
    </Modal>
  );
}

function NavButton({
  label,
  className,
  disabled,
  onClick,
  children,
}: {
  label: string;
  className: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label} withArrow>
      <ActionIcon
        size="xl"
        radius="xl"
        variant="filled"
        color="dark"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={clsx('absolute z-10 opacity-80', className)}
      >
        {children}
      </ActionIcon>
    </Tooltip>
  );
}
