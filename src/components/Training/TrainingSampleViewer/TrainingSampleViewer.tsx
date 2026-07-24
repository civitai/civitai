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
import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CopyButton } from '~/components/CopyButton/CopyButton';

export type TrainingSampleEpoch = {
  epochNumber: number;
  sampleImages: string[];
};

export type TrainingSampleViewerProps = {
  epochs: TrainingSampleEpoch[];
  prompts: string[];
  isVideo: boolean;
  epochIndex: number;
  sampleIndex: number;
};

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

  const epoch = epochs[epochIndex];
  const url = epoch?.sampleImages?.[sampleIndex];
  const prompt = prompts[sampleIndex];

  // Epochs are laid out newest-first, so "up" is a later epoch. Epochs that never emitted a
  // sample at this index are skipped so the vertical axis always lands on a comparable image.
  const findEpochWithSample = useCallback(
    (step: number) => {
      for (let i = epochIndex + step; i >= 0 && i < epochs.length; i += step) {
        if (hasSampleAt(epochs[i], sampleIndex)) return i;
      }
      return undefined;
    },
    [epochs, epochIndex, sampleIndex]
  );

  const prevEpochIndex = findEpochWithSample(-1);
  const nextEpochIndex = findEpochWithSample(1);
  const canPrevSample = sampleIndex > 0;
  const canNextSample = sampleIndex < (epoch?.sampleImages?.length ?? 0) - 1;

  useEffect(() => {
    setStatus('loading');
    setZoomed(false);
  }, [url]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      if (e.key === 'ArrowLeft' && canPrevSample) setSampleIndex((i) => i - 1);
      else if (e.key === 'ArrowRight' && canNextSample) setSampleIndex((i) => i + 1);
      else if (e.key === 'ArrowUp' && prevEpochIndex !== undefined) setEpochIndex(prevEpochIndex);
      else if (e.key === 'ArrowDown' && nextEpochIndex !== undefined) setEpochIndex(nextEpochIndex);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canPrevSample, canNextSample, prevEpochIndex, nextEpochIndex]);

  if (!epoch || !url) return null;

  const mediaClassName = clsx(
    'transition-opacity',
    status === 'loaded' ? 'opacity-100' : 'opacity-0',
    zoomed ? 'max-w-none' : 'max-h-full max-w-full object-contain'
  );

  return (
    <Modal
      {...dialog}
      fullScreen
      withOverlay={false}
      withinPortal={!dialog.target}
      zIndex={dialog.target ? undefined : 400}
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
            {epochIndex + 1} of {epochs.length} epochs &middot; sample {sampleIndex + 1} of{' '}
            {epoch.sampleImages.length}
          </Text>
        </Group>
        {!isVideo && (
          <Tooltip label={zoomed ? 'Fit to screen' : 'View at full size'} withArrow>
            <ActionIcon
              size="lg"
              variant="light"
              aria-label={zoomed ? 'Fit to screen' : 'View at full size'}
              onClick={() => setZoomed((z) => !z)}
            >
              {zoomed ? <IconZoomOut size={20} /> : <IconZoomIn size={20} />}
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      <div className="relative flex min-h-0 flex-1">
        <div
          className={clsx(
            'flex flex-1 items-center justify-center',
            zoomed ? 'overflow-auto' : 'overflow-hidden'
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
            <video
              key={url}
              loop
              playsInline
              disablePictureInPicture
              muted
              autoPlay
              controls
              className={mediaClassName}
              onLoadedData={() => setStatus('loaded')}
              onError={() => setStatus('error')}
            >
              <source src={url} type="video/mp4" />
            </video>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={url}
              alt={`Epoch ${epoch.epochNumber} sample ${sampleIndex + 1}`}
              className={clsx(mediaClassName, 'cursor-zoom-in', zoomed && 'cursor-zoom-out')}
              onClick={() => setZoomed((z) => !z)}
              onLoad={() => setStatus('loaded')}
              onError={() => setStatus('error')}
            />
          )}
        </div>

        <NavButton
          label="Previous sample (Left)"
          className="left-2 top-1/2 -translate-y-1/2"
          disabled={!canPrevSample}
          onClick={() => setSampleIndex((i) => i - 1)}
        >
          <IconChevronLeft size={24} />
        </NavButton>
        <NavButton
          label="Next sample (Right)"
          className="right-2 top-1/2 -translate-y-1/2"
          disabled={!canNextSample}
          onClick={() => setSampleIndex((i) => i + 1)}
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
