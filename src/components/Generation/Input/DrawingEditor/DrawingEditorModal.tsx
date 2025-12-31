import { Badge, Button, Modal, Textarea } from '@mantine/core';
import { useRef, useState, useMemo, useCallback, useEffect } from 'react';
import type Konva from 'konva';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { isMobileDevice } from '~/hooks/useIsMobile';
import { DrawingCanvas } from './DrawingCanvas';
import { DrawingToolbar } from './DrawingToolbar';
import type {
  DrawingEditorModalProps,
  DrawingTool,
  DrawingElement,
  DrawingTextElement,
} from './drawing.types';
import {
  DEFAULT_BRUSH_COLOR,
  DEFAULT_BRUSH_SIZE,
  exportDrawingToBlob,
  calculateCanvasDimensions,
  normalizeElements,
  generateElementId,
} from './drawing.utils';
import styles from './DrawingEditor.module.scss';

const MAX_CANVAS_WIDTH = 700;
const MAX_CANVAS_HEIGHT = 500;
const DEFAULT_FONT_SIZE = 16;

export function DrawingEditorModal({
  sourceImage,
  onConfirm,
  onCancel,
  initialLines = [],
}: DrawingEditorModalProps) {
  const dialog = useDialogContext();
  const stageRef = useRef<Konva.Stage | null>(null);

  // Normalize initial lines to elements format
  const normalizedInitialElements = useMemo(() => normalizeElements(initialLines), [initialLines]);

  // Drawing state - initialize with existing elements if provided
  const [elements, setElements] = useState<DrawingElement[]>(normalizedInitialElements);
  const [tool, setTool] = useState<DrawingTool>('brush');
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE);
  const [brushColor, setBrushColor] = useState<string>(DEFAULT_BRUSH_COLOR);
  const [loading, setLoading] = useState(false);

  // Ref to always have current elements (avoids stale closure in commitToHistory)
  const elementsRef = useRef<DrawingElement[]>(elements);
  elementsRef.current = elements;

  // History state - combined to avoid stale closure issues
  const [historyState, setHistoryState] = useState<{
    entries: DrawingElement[][];
    index: number;
  }>({
    entries: [normalizedInitialElements],
    index: 0,
  });

  // Commit current elements to history (called when an action is finalized)
  const commitToHistory = useCallback(() => {
    const currentElements = elementsRef.current;
    setHistoryState((state) => {
      const lastEntry = state.entries[state.index];
      if (JSON.stringify(lastEntry) !== JSON.stringify(currentElements)) {
        const newEntries = [...state.entries.slice(0, state.index + 1), currentElements];
        return { entries: newEntries, index: newEntries.length - 1 };
      }
      return state;
    });
  }, []); // No dependencies needed - uses ref and functional update

  // Check if there are unsaved changes
  const hasChanges = useMemo(() => {
    return JSON.stringify(elements) !== JSON.stringify(normalizedInitialElements);
  }, [elements, normalizedInitialElements]);

  // Selection state for move/resize
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Text input state - supports both new placement and editing existing text
  const [textInput, setTextInput] = useState<{
    position: { x: number; y: number };
    value: string;
    editingId?: string; // ID of element being edited (undefined for new text)
    color?: string; // Color to use (element's color when editing)
    fontSize?: number; // Font size to preserve when editing
  } | null>(null);

  // Handle keyboard events for delete/backspace
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle delete when we have a selection and not in text input mode
      if (!selectedId || textInput) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        setElements((prev) => prev.filter((el) => el.id !== selectedId));
        setSelectedId(null);
        // Use setTimeout to ensure state is updated before committing
        setTimeout(commitToHistory, 0);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedId, textInput, commitToHistory]);

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

  // Handle text placement from canvas (new text)
  const handleTextPlacement = useCallback(
    (position: { x: number; y: number }) => {
      setTextInput({ position, value: '', color: brushColor });
    },
    [brushColor]
  );

  // Handle text edit from canvas (double-click on existing text)
  const handleTextEdit = useCallback((element: DrawingTextElement) => {
    setTextInput({
      position: { x: element.x, y: element.y },
      value: element.text,
      editingId: element.id,
      color: element.color,
      fontSize: element.fontSize,
    });
  }, []);

  // Handle text input confirmation
  const handleTextConfirm = useCallback(() => {
    if (!textInput) {
      return;
    }

    const trimmedValue = textInput.value.trim();

    if (textInput.editingId) {
      // Editing existing text
      if (trimmedValue) {
        // Update the text element
        setElements((prev) =>
          prev.map((el) => (el.id === textInput.editingId ? { ...el, text: trimmedValue } : el))
        );
      } else {
        // Empty text - delete the element
        setElements((prev) => prev.filter((el) => el.id !== textInput.editingId));
      }
      // Commit after editing
      setTimeout(commitToHistory, 0);
    } else if (trimmedValue) {
      // Creating new text (only if not empty)
      const newText: DrawingTextElement = {
        type: 'text',
        id: generateElementId(),
        x: textInput.position.x,
        y: textInput.position.y,
        text: trimmedValue,
        fontSize: textInput.fontSize || DEFAULT_FONT_SIZE,
        color: textInput.color || brushColor,
        strokeWidth: 0,
      };
      setElements((prev) => [...prev, newText]);
      // Commit after adding text
      setTimeout(commitToHistory, 0);
    }

    setTextInput(null);
  }, [textInput, brushColor, commitToHistory]);

  // Handle text input cancel
  const handleTextCancel = useCallback(() => {
    setTextInput(null);
  }, []);

  function handleCancel() {
    onCancel?.();
    dialog.onClose();
  }

  async function handleConfirm() {
    if (elements.length === 0) {
      handleCancel();
      return;
    }

    setLoading(true);
    try {
      const blob = await exportDrawingToBlob(
        stageRef.current,
        canvasDimensions.width,
        canvasDimensions.height,
        sourceImage.width,
        sourceImage.height,
        sourceImage.url
      );
      // Wait for onConfirm to complete (handles upload) before closing
      await onConfirm(blob, elements);
      dialog.onClose();
    } catch (error) {
      console.error('Failed to export drawing:', error);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    setElements([]);
    // Reset history to empty state
    setHistoryState({ entries: [[]], index: 0 });
  }

  function handleUndo() {
    if (historyState.index > 0) {
      const prevIndex = historyState.index - 1;
      setHistoryState((state) => ({ ...state, index: prevIndex }));
      setElements(historyState.entries[prevIndex]);
    }
  }

  const canUndo = historyState.index > 0;

  const isMobile = isMobileDevice();

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
      className={styles.modal}
    >
      <div className="flex flex-col">
        {/* Header */}
        <div className={styles.header}>
          <div className="flex items-center gap-2">
            <h2 className={styles.headerTitle}>Sketch Edit</h2>
            <Badge color="yellow" variant="light">
              Beta
            </Badge>
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
              position: 'relative',
            }}
          >
            <DrawingCanvas
              backgroundImage={sourceImage.url}
              width={canvasDimensions.width}
              height={canvasDimensions.height}
              tool={tool}
              brushSize={brushSize}
              brushColor={brushColor}
              elements={elements}
              onElementsChange={setElements}
              onStageReady={handleStageReady}
              onTextPlacement={handleTextPlacement}
              onTextEdit={handleTextEdit}
              selectedId={selectedId}
              onSelectedIdChange={setSelectedId}
              onCommit={commitToHistory}
              editingTextId={textInput?.editingId}
            />

            {/* Text Input Overlay - positioned relative to canvas */}
            {textInput && (
              <div
                className={styles.textInputOverlay}
                style={{
                  position: 'absolute',
                  left: textInput.position.x,
                  top: textInput.position.y,
                  transform: 'translate(-4px, -12px)',
                  zIndex: 1000,
                }}
              >
                <Textarea
                  autoFocus
                  autosize
                  minRows={1}
                  value={textInput.value}
                  onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      handleTextCancel();
                    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleTextConfirm();
                    }
                  }}
                  onBlur={handleTextConfirm}
                  placeholder={textInput.editingId ? 'Edit text...' : 'Type text...'}
                  size="sm"
                  classNames={{ input: styles.textInputField }}
                  styles={{
                    input: {
                      color: textInput.color || brushColor,
                      fontSize: textInput.fontSize || DEFAULT_FONT_SIZE,
                      minWidth: 150,
                      maxWidth: 400,
                    },
                  }}
                />
              </div>
            )}
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
            canUndo={canUndo}
          />
        </div>
      </div>
    </Modal>
  );
}
