/**
 * MaskEditorModal
 *
 * Opens a modal where the user can erase parts of a reference image. The
 * exported PNG fills erased areas with a configurable color (black, white,
 * or transparent). Black is the default because most ControlNet preprocessors
 * treat black as "no signal," giving deterministic masking behavior without
 * depending on whether the preprocessor honors alpha.
 */

import { ActionIcon, Button, Modal, SegmentedControl, Slider, Text, Tooltip } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useCallback, useMemo, useRef, useState } from 'react';
import type Konva from 'konva';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { calculateCanvasDimensions } from '~/components/Generation/Input/DrawingEditor/drawing.utils';
import { showErrorNotification } from '~/utils/notifications';
import type { MaskStroke } from './MaskEditorCanvas';

const MaskEditorCanvas = dynamic(
  () => import('./MaskEditorCanvas').then((mod) => mod.MaskEditorCanvas),
  { ssr: false }
);

const MAX_CANVAS_WIDTH = 700;
const MAX_CANVAS_HEIGHT = 500;
const MIN_BRUSH = 5;
const MAX_BRUSH = 80;
const DEFAULT_BRUSH = 25;

const MOBILE_HEADER_HEIGHT = 52;
const MOBILE_TOOLBAR_HEIGHT = 70;
const MOBILE_PADDING = 16;

export type FillMode = 'black' | 'white' | 'transparent';

const FILL_COLOR: Record<Exclude<FillMode, 'transparent'>, string> = {
  black: '#000000',
  white: '#ffffff',
};

export interface MaskResult {
  url: string;
  width: number;
  height: number;
}

export interface MaskEditorModalProps {
  sourceImage: { url: string; width: number; height: number };
  onConfirm: (result: MaskResult) => void | Promise<void>;
  onCancel?: () => void;
  confirmLabel?: string;
}

export function MaskEditorModal({
  sourceImage,
  onConfirm,
  onCancel,
  confirmLabel = 'Apply Mask',
}: MaskEditorModalProps) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile({ type: 'media', breakpoint: 'md' });
  const stageRef = useRef<Konva.Stage | null>(null);

  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [history, setHistory] = useState<MaskStroke[][]>([[]]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH);
  const [fill, setFill] = useState<FillMode>('black');
  const [loading, setLoading] = useState(false);

  const strokesRef = useRef<MaskStroke[]>(strokes);
  strokesRef.current = strokes;

  const sourceUrl = useMemo(() => {
    return sourceImage.url.startsWith('http')
      ? sourceImage.url
      : getEdgeUrl(sourceImage.url, { original: true }) ?? sourceImage.url;
  }, [sourceImage.url]);

  const canvasDimensions = useMemo(() => {
    if (isMobile && typeof window !== 'undefined') {
      const maxW = Math.floor(window.innerWidth - MOBILE_PADDING * 2 - 16);
      const maxH = Math.floor(
        window.innerHeight - MOBILE_HEADER_HEIGHT - MOBILE_TOOLBAR_HEIGHT - MOBILE_PADDING * 2
      );
      return calculateCanvasDimensions(sourceImage.width, sourceImage.height, maxW, maxH);
    }
    return calculateCanvasDimensions(
      sourceImage.width,
      sourceImage.height,
      MAX_CANVAS_WIDTH,
      MAX_CANVAS_HEIGHT
    );
  }, [isMobile, sourceImage.width, sourceImage.height]);

  const commitToHistory = useCallback(() => {
    setHistory((prev) => {
      const truncated = prev.slice(0, historyIndex + 1);
      const next = [...truncated, strokesRef.current];
      setHistoryIndex(next.length - 1);
      return next;
    });
  }, [historyIndex]);

  const handleUndo = useCallback(() => {
    setHistoryIndex((idx) => {
      if (idx <= 0) return idx;
      const next = idx - 1;
      setStrokes(history[next] ?? []);
      return next;
    });
  }, [history]);

  const handleClear = useCallback(() => {
    setStrokes([]);
    setHistory((prev) => {
      const next = [...prev.slice(0, historyIndex + 1), []];
      setHistoryIndex(next.length - 1);
      return next;
    });
  }, [historyIndex]);

  useHotkeys([['mod+Z', handleUndo, { preventDefault: true }]], ['INPUT', 'TEXTAREA']);

  const handleCancel = useCallback(() => {
    onCancel?.();
    dialog.onClose();
  }, [onCancel, dialog]);

  const handleStageReady = useCallback((stage: Konva.Stage) => {
    stageRef.current = stage;
  }, []);

  const exportPng = async (): Promise<Blob> => {
    const stage = stageRef.current;
    if (!stage) throw new Error('Stage is not available');
    const pixelRatio = sourceImage.width / canvasDimensions.width;
    const stageCanvas = stage.toCanvas({
      pixelRatio,
      width: canvasDimensions.width,
      height: canvasDimensions.height,
    });

    let outCanvas: HTMLCanvasElement = stageCanvas;
    if (fill !== 'transparent') {
      // Composite the stage (with transparent erased regions) over a solid
      // background so the uploaded PNG is opaque. This makes mask behavior
      // deterministic regardless of how the preprocessor handles alpha.
      const composite = document.createElement('canvas');
      composite.width = stageCanvas.width;
      composite.height = stageCanvas.height;
      const ctx = composite.getContext('2d');
      if (!ctx) throw new Error('Could not get 2d context');
      ctx.fillStyle = FILL_COLOR[fill];
      ctx.fillRect(0, 0, composite.width, composite.height);
      ctx.drawImage(stageCanvas, 0, 0);
      outCanvas = composite;
    }

    const dataUrl = outCanvas.toDataURL('image/png');
    const res = await fetch(dataUrl);
    return await res.blob();
  };

  const handleConfirm = async () => {
    if (strokes.length === 0) {
      handleCancel();
      return;
    }
    setLoading(true);
    try {
      const blob = await exportPng();
      const result = await uploadConsumerBlob(blob);
      if (!result.url) throw new Error('Upload returned no URL');
      await onConfirm({
        url: result.url,
        width: sourceImage.width,
        height: sourceImage.height,
      });
      dialog.onClose();
    } catch (error) {
      console.error('Failed to apply mask:', error);
      showErrorNotification({
        title: 'Mask Failed',
        error:
          error instanceof Error ? error : new Error('Could not apply mask. Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  };

  const canUndo = historyIndex > 0;
  const hasChanges = strokes.length > 0;

  return (
    <Modal
      {...dialog}
      title={null}
      size={isMobile ? '100%' : 'xl'}
      fullScreen={isMobile}
      onClose={handleCancel}
      closeOnClickOutside={!loading}
      closeOnEscape={!loading}
      padding={0}
      radius="md"
    >
      <div className="flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-0 border-b border-solid border-gray-3 px-4 py-3 dark:border-dark-4">
          <div>
            <Text fz="md" fw={500}>
              Erase Mask
            </Text>
            <Text fz="xs" c="dimmed">
              Erase areas to remove them from the ControlNet reference.
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="subtle"
              color="gray"
              size="sm"
              onClick={handleCancel}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleConfirm} loading={loading} disabled={!hasChanges}>
              {confirmLabel}
            </Button>
          </div>
        </div>

        {/* Canvas */}
        <div className="flex items-center justify-center bg-gray-1 p-4 dark:bg-dark-8">
          <div
            className="overflow-hidden rounded-md shadow-xl"
            style={{
              width: canvasDimensions.width,
              height: canvasDimensions.height,
              position: 'relative',
            }}
          >
            <MaskEditorCanvas
              sourceImageUrl={sourceUrl}
              width={canvasDimensions.width}
              height={canvasDimensions.height}
              brushSize={brushSize}
              strokes={strokes}
              onStrokesChange={setStrokes}
              onCommit={commitToHistory}
              onStageReady={handleStageReady}
              backgroundColor={fill === 'transparent' ? null : FILL_COLOR[fill]}
            />
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-center gap-4 border-0 border-t border-solid border-gray-3 px-4 py-3 dark:border-dark-4">
          <div className="flex w-64 items-center gap-3">
            <Text fz="xs" c="dimmed" className="shrink-0">
              Brush
            </Text>
            <Slider
              className="flex-1"
              min={MIN_BRUSH}
              max={MAX_BRUSH}
              step={1}
              value={brushSize}
              onChange={setBrushSize}
              label={(v) => `${v}px`}
              size="sm"
            />
            <Text fz="xs" c="dimmed" w={36} ta="right">
              {brushSize}px
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip
              label="What to put in erased areas. Most ControlNets treat black as 'no signal'."
              withArrow
              multiline
              w={220}
            >
              <Text fz="xs" c="dimmed" className="shrink-0 cursor-help">
                Fill
              </Text>
            </Tooltip>
            <SegmentedControl
              size="xs"
              value={fill}
              onChange={(v) => setFill(v as FillMode)}
              data={[
                { value: 'black', label: 'Black' },
                { value: 'white', label: 'White' },
                { value: 'transparent', label: 'None' },
              ]}
            />
          </div>
          <Tooltip label="Undo (Ctrl+Z)" withArrow>
            <ActionIcon
              variant="subtle"
              size="lg"
              radius="md"
              onClick={handleUndo}
              disabled={!canUndo}
            >
              <IconArrowBackUp size={20} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Clear all" withArrow>
            <ActionIcon
              variant="subtle"
              size="lg"
              radius="md"
              color="red"
              onClick={handleClear}
              disabled={!hasChanges}
            >
              <IconTrash size={18} />
            </ActionIcon>
          </Tooltip>
        </div>
      </div>
    </Modal>
  );
}
