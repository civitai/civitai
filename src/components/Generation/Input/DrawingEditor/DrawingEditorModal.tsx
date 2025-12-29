import { Button, Modal } from '@mantine/core';
import { useRef, useState, useMemo, useCallback } from 'react';
import type Konva from 'konva';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { isMobileDevice } from '~/hooks/useIsMobile';
import { DrawingCanvas } from './DrawingCanvas';
import { DrawingToolbar } from './DrawingToolbar';
import type { DrawingEditorModalProps, DrawingLine, DrawingTool } from './drawing.types';
import {
  DEFAULT_BRUSH_COLOR,
  DEFAULT_BRUSH_SIZE,
  exportDrawingToBlob,
  calculateCanvasDimensions,
} from './drawing.utils';
import styles from './DrawingEditor.module.scss';

const MAX_CANVAS_WIDTH = 700;
const MAX_CANVAS_HEIGHT = 500;

export function DrawingEditorModal({
  sourceImage,
  onConfirm,
  onCancel,
  initialLines = [],
}: DrawingEditorModalProps) {
  const dialog = useDialogContext();
  const stageRef = useRef<Konva.Stage | null>(null);

  // Drawing state - initialize with existing lines if provided
  const [lines, setLines] = useState<DrawingLine[]>(initialLines);
  const [tool, setTool] = useState<DrawingTool>('brush');
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE);
  const [brushColor, setBrushColor] = useState<string>(DEFAULT_BRUSH_COLOR);
  const [loading, setLoading] = useState(false);

  // Calculate canvas dimensions based on source image
  const canvasDimensions = useMemo(() => {
    return calculateCanvasDimensions(
      sourceImage.width,
      sourceImage.height,
      MAX_CANVAS_WIDTH,
      MAX_CANVAS_HEIGHT
    );
  }, [sourceImage.width, sourceImage.height]);

  // Callback to capture the stage instance when it's ready
  const handleStageReady = useCallback((stage: Konva.Stage) => {
    stageRef.current = stage;
  }, []);

  function handleCancel() {
    onCancel?.();
    dialog.onClose();
  }

  async function handleConfirm() {
    if (lines.length === 0) {
      handleCancel();
      return;
    }

    setLoading(true);
    try {
      const blob = await exportDrawingToBlob(
        stageRef.current,
        canvasDimensions.width,
        canvasDimensions.height
      );
      onConfirm(blob, lines);
      dialog.onClose();
    } catch (error) {
      console.error('Failed to export drawing:', error);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    setLines([]);
  }

  function handleUndo() {
    setLines((prev) => prev.slice(0, -1));
  }

  const isMobile = isMobileDevice();

  return (
    <Modal
      {...dialog}
      title={null}
      size={isMobile ? '100%' : 'auto'}
      fullScreen={isMobile}
      onClose={handleCancel}
      padding={0}
      radius="md"
      className={styles.modal}
    >
      <div className="flex flex-col">
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.headerTitle}>Draw on Image</h2>
          <div className="flex items-center gap-2">
            <Button variant="subtle" color="gray" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleConfirm}
              loading={loading}
              disabled={lines.length === 0}
            >
              Apply
            </Button>
          </div>
        </div>

        {/* Canvas Area */}
        <div className={styles.canvasArea}>
          {/* Canvas Container with subtle shadow */}
          <div
            className={styles.canvasContainer}
            style={{
              width: canvasDimensions.width,
              height: canvasDimensions.height,
            }}
          >
            <DrawingCanvas
              backgroundImage={sourceImage.url}
              width={canvasDimensions.width}
              height={canvasDimensions.height}
              tool={tool}
              brushSize={brushSize}
              brushColor={brushColor}
              lines={lines}
              onLinesChange={setLines}
              onStageReady={handleStageReady}
            />
          </div>
        </div>

        {/* Toolbar - Floating at bottom */}
        <div className={styles.toolbarArea}>
          <DrawingToolbar
            tool={tool}
            onToolChange={setTool}
            brushSize={brushSize}
            onBrushSizeChange={setBrushSize}
            brushColor={brushColor}
            onBrushColorChange={setBrushColor}
            onClear={handleClear}
            onUndo={handleUndo}
            canUndo={lines.length > 0}
          />
        </div>
      </div>
    </Modal>
  );
}
