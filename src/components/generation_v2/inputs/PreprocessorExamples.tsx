/**
 * PreprocessorExamples
 *
 * Card showing a preprocessor's description plus before/after example images so
 * the user knows what output to expect. Used by both the standalone Control
 * Preprocessor workflow (`preprocessKind` controller) and the ControlNets input.
 *
 * When `onPrev`/`onNext` are provided the preview becomes a focusable carousel:
 * chevron buttons flank it and ←/→ cycle through preprocessors while focused, so
 * users who recognise an output but not its name can browse by appearance.
 *
 * Rows whose output image is missing (e.g. a kind that errors on the
 * orchestrator and has no generated sample) hide themselves, so a missing asset
 * never leaves a broken "before → blank" pair — and auto-recover if the asset
 * is added later. The whole card hides when nothing is renderable.
 */
import { ActionIcon, Card, Group, Stack, Text } from '@mantine/core';
import { IconArrowRight, IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { ControlNetExample } from '~/shared/constants/controlnets.constants';

interface PreprocessorExamplesProps {
  examples: ControlNetExample[];
  /**
   * Content rendered at the top of the card. Pass the preprocessor select here
   * so its value acts as the card heading. When provided, the card always
   * renders (the header must stay visible) and `title` is ignored.
   */
  header?: ReactNode;
  /** Preprocessor name shown as the card title (when no `header` is given). */
  title?: string;
  /** Short explanation of what the preprocessor does. */
  description?: string;
  /** Select the previous preprocessor. Enables the prev/← control. */
  onPrev?: () => void;
  /** Select the next preprocessor. Enables the next/→ control. */
  onNext?: () => void;
}

export function PreprocessorExamples({
  examples,
  header,
  title,
  description,
  onPrev,
  onNext,
}: PreprocessorExamplesProps) {
  // Reset the "missing" set whenever the example set changes (kind switched).
  const outputsKey = examples.map((e) => e.output).join('|');
  const [missing, setMissing] = useState<Set<string>>(new Set());
  useEffect(() => setMissing(new Set()), [outputsKey]);

  const visible = examples.filter((ex) => !missing.has(ex.output));
  const hasExamples = visible.length > 0;
  const canNavigate = !!(onPrev || onNext);
  // With a header (e.g. the select) or navigation, always render so those
  // controls stay visible. Otherwise hide when there's nothing to show.
  if (!header && !canNavigate && !hasExamples && !description && !title) return null;

  const previewBody = hasExamples ? (
    <Stack gap="sm" className="w-full">
      {visible.map((ex) => (
        <Group key={ex.output} gap="sm" align="center" justify="center" wrap="nowrap">
          <ExampleThumb src={ex.input} alt={`${ex.label} input`} caption="Input" />
          <IconArrowRight size={20} className="shrink-0 text-gray-5 dark:text-dark-2" />
          <ExampleThumb
            src={ex.output}
            alt={`${ex.label} output`}
            caption="Output"
            onError={() => setMissing((prev) => new Set(prev).add(ex.output))}
          />
        </Group>
      ))}
    </Stack>
  ) : canNavigate ? (
    <Text fz="xs" c="dimmed" ta="center" className="w-full py-6">
      No preview available for this preprocessor.
    </Text>
  ) : null;

  return (
    <Card withBorder radius="md" padding="sm" className="bg-gray-0 dark:bg-dark-6">
      <Stack gap="xs">
        {header ??
          (title && (
            <Text fw={600} fz="sm">
              {title}
            </Text>
          ))}
        {description && (
          <Text fz="xs" c="dimmed">
            {description}
          </Text>
        )}

        {canNavigate ? (
          <div
            tabIndex={0}
            role="group"
            aria-label="Preprocessor preview — use left and right arrow keys to browse"
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') {
                e.preventDefault();
                onPrev?.();
              } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                onNext?.();
              }
            }}
            className={clsx(
              'flex items-center gap-1 rounded-md outline-none',
              'focus-visible:ring-2 focus-visible:ring-blue-5'
            )}
          >
            <ActionIcon
              variant="default"
              radius="xl"
              onClick={onPrev}
              aria-label="Previous preprocessor"
              className="shrink-0"
            >
              <IconChevronLeft size={18} />
            </ActionIcon>
            <div className="flex min-w-0 flex-1 justify-center">{previewBody}</div>
            <ActionIcon
              variant="default"
              radius="xl"
              onClick={onNext}
              aria-label="Next preprocessor"
              className="shrink-0"
            >
              <IconChevronRight size={18} />
            </ActionIcon>
          </div>
        ) : (
          previewBody
        )}
      </Stack>
    </Card>
  );
}

function ExampleThumb({
  src,
  alt,
  caption,
  onError,
}: {
  src: string;
  alt: string;
  caption: string;
  onError?: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1">
      <div
        className={clsx(
          'aspect-square w-full max-w-[160px] overflow-hidden rounded-md',
          'border border-solid border-gray-3 bg-gray-1 dark:border-dark-4 dark:bg-dark-7'
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="size-full object-cover"
          onError={onError}
        />
      </div>
      <Text fz={10} c="dimmed">
        {caption}
      </Text>
    </div>
  );
}
