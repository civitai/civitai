import { Alert, Badge, Button, Modal, Text, Textarea } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useHotkeys } from '@mantine/hooks';
import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import type Konva from 'konva';
import dynamic from 'next/dynamic';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { DrawingToolbar } from './DrawingToolbar';
import type {
  DrawingEditorModalProps,
  DrawingTool,
  DrawingElement,
  DrawingTextElement,
  DrawingImageElement,
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
import { showErrorNotification } from '~/utils/notifications';

// Dynamically import DrawingCanvas (uses react-konva which requires browser APIs)
const DrawingCanvas = dynamic(
  () => import('./DrawingCanvas').then((mod) => mod.DrawingCanvas),
  { ssr: false }
);

const MAX_CANVAS_WIDTH = 700;
const MAX_CANVAS_HEIGHT = 500;
const DEFAULT_FONT_SIZE = 16;

// Mobile layout constants
const MOBILE_HEADER_HEIGHT = 52;
const MOBILE_TOOLBAR_HEIGHT = 60;
const MOBILE_PADDING = 16;

export function DrawingEditorModal({
  sourceImage,
  onConfirm,
  onCancel,
  initialLines = [],
  confirmLabel = 'Apply',
}: DrawingEditorModalProps) {
  const dialog = useDialogContext();
  const stageRef = useRef<Konva.Stage | null>(null);
  const isMobile = useIsMobile({ type: 'media', breakpoint: 'md' });

  // Normalize initial lines to elements format
  const normalizedInitialElements = useMemo(() => normalizeElements(initialLines), [initialLines]);

  // Drawing state - initialize with existing elements if provided
  const [elements, setElements] = useState<DrawingElement[]>(normalizedInitialElements);
  const [tool, setTool] = useState<DrawingTool>('brush');
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE);
  const [brushColor, setBrushColor] = useState<string>(DEFAULT_BRUSH_COLOR);
  const [loading, setLoading] = useState(false);
  // Selection state for move/resize
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  // Undo function
  const handleUndo = useCallback(() => {
    setHistoryState((state) => {
      if (state.index > 0) {
        const prevIndex = state.index - 1;
        setElements(state.entries[prevIndex]);
        return { ...state, index: prevIndex };
      }
      return state;
    });
  }, []);

  // Redo function
  const handleRedo = useCallback(() => {
    setHistoryState((state) => {
      if (state.index < state.entries.length - 1) {
        const nextIndex = state.index + 1;
        setElements(state.entries[nextIndex]);
        return { ...state, index: nextIndex };
      }
      return state;
    });
  }, []);

  // Delete selected element
  const handleDeleteSelected = useCallback(() => {
    if (selectedId) {
      setElements((prev) => prev.filter((el) => el.id !== selectedId));
      setSelectedId(null);
      setTimeout(commitToHistory, 0);
    }
  }, [selectedId, commitToHistory]);

  // Handle modal cancel/close
  const handleCancel = useCallback(() => {
    onCancel?.();
    dialog.onClose();
  }, [onCancel, dialog]);

  // Check if there are unsaved changes
  const hasChanges = useMemo(() => {
    return JSON.stringify(elements) !== JSON.stringify(normalizedInitialElements);
  }, [elements, normalizedInitialElements]);

  // Text input state - supports both new placement and editing existing text
  const [textInput, setTextInput] = useState<{
    position: { x: number; y: number };
    value: string;
    editingId?: string; // ID of element being edited (undefined for new text)
    color?: string; // Color to use (element's color when editing)
    fontSize?: number; // Font size to preserve when editing
  } | null>(null);

  // ── Image overlay state ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [overlayImages, setOverlayImages] = useState<Map<string, HTMLImageElement>>(new Map());

  // Trigger file picker for image overlay
  const handleAddImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Handle keyboard shortcuts using Mantine's useHotkeys
  useHotkeys(
    [
      // Undo: Ctrl+Z (Windows/Linux) or Cmd+Z (Mac)
      ['mod+Z', handleUndo, { preventDefault: true }],
      // Redo: Ctrl+Shift+Z (Windows/Linux/Mac) or Cmd+Shift+Z (Mac)
      ['mod+shift+Z', handleRedo, { preventDefault: true }],
      // Redo alternative: Ctrl+Y (Windows)
      ['ctrl+Y', handleRedo, { preventDefault: true }],
      // Delete selected element
      ['Delete', handleDeleteSelected, { preventDefault: true }],
      // Backspace as alternative to Delete
      ['Backspace', handleDeleteSelected, { preventDefault: true }],
    ],
    ['INPUT', 'TEXTAREA'] // Ignore hotkeys when focus is in input/textarea elements (allows native undo/redo in text fields)
  );

  // Calculate canvas dimensions based on source image and device
  const canvasDimensions = useMemo(() => {
    // On mobile, use viewport dimensions to prevent overflow
    if (isMobile && typeof window !== 'undefined') {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Calculate available space accounting for UI elements, padding, and safe areas
      // Be conservative to ensure no horizontal scroll
      const maxWidth = Math.floor(viewportWidth - MOBILE_PADDING * 2 - 16); // Extra 16px buffer for safe area/scrollbar
      const maxHeight = Math.floor(
        viewportHeight - MOBILE_HEADER_HEIGHT - MOBILE_TOOLBAR_HEIGHT - MOBILE_PADDING * 2
      );

      // Use the standard calculation which handles aspect ratio properly
      return calculateCanvasDimensions(sourceImage.width, sourceImage.height, maxWidth, maxHeight);
    }

    // Desktop: use fixed max dimensions
    return calculateCanvasDimensions(
      sourceImage.width,
      sourceImage.height,
      MAX_CANVAS_WIDTH,
      MAX_CANVAS_HEIGHT
    );
  }, [sourceImage.width, sourceImage.height, isMobile]);

  // Handle file selection for image overlay
  const handleImageFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      // Reset input so the same file can be selected again
      e.target.value = '';

      // Limit file size to 10MB to avoid bloating undo history with huge data URLs
      if (file.size > 10 * 1024 * 1024) {
        showErrorNotification({ title: 'Image too large', error: new Error('Please select an image under 10MB') });
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => {
        showErrorNotification({ title: 'Failed to read image', error: new Error('Could not read the selected file') });
      };
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const img = new window.Image();
        img.onerror = () => {
          showErrorNotification({ title: 'Invalid image', error: new Error('The selected file could not be loaded as an image') });
        };
        img.onload = () => {
          // Scale to max 40% of canvas
          const maxW = canvasDimensions.width * 0.4;
          const maxH = canvasDimensions.height * 0.4;
          let w = img.naturalWidth;
          let h = img.naturalHeight;
          if (w > maxW || h > maxH) {
            const scale = Math.min(maxW / w, maxH / h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }

          const newElement: DrawingImageElement = {
            type: 'image',
            id: generateElementId(),
            x: Math.round((canvasDimensions.width - w) / 2),
            y: Math.round((canvasDimensions.height - h) / 2),
            width: w,
            height: h,
            imageUrl: dataUrl,
            color: '#000000',
            strokeWidth: 0,
          };

          // Add to overlay map
          setOverlayImages((prev) => {
            const next = new Map(prev);
            next.set(newElement.id, img);
            return next;
          });

          setElements((prev) => [...prev, newElement]);
          setTool('select');
          setSelectedId(newElement.id);
          setTimeout(commitToHistory, 0);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    },
    [canvasDimensions, commitToHistory]
  );

  // Add a speech bubble stamp image to the canvas
  const handleAddSpeechBubble = useCallback(
    (imagePath: string) => {
      const img = new window.Image();
      img.onload = () => {
        // Scale to max 30% of canvas
        const maxW = canvasDimensions.width * 0.3;
        const maxH = canvasDimensions.height * 0.3;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > maxW || h > maxH) {
          const scale = Math.min(maxW / w, maxH / h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }

        const newElement: DrawingImageElement = {
          type: 'image',
          id: generateElementId(),
          x: Math.round((canvasDimensions.width - w) / 2),
          y: Math.round((canvasDimensions.height - h) / 2),
          width: w,
          height: h,
          imageUrl: imagePath,
          color: '#000000',
          strokeWidth: 0,
        };

        setOverlayImages((prev) => {
          const next = new Map(prev);
          next.set(newElement.id, img);
          return next;
        });

        setElements((prev) => [...prev, newElement]);
        setTool('select');
        setSelectedId(newElement.id);
        setTimeout(commitToHistory, 0);
      };
      img.onerror = () => {
        showErrorNotification({
          title: 'Failed to load speech bubble',
          error: new Error('Could not load the speech bubble image'),
        });
      };
      img.src = imagePath;
    },
    [canvasDimensions, commitToHistory]
  );

  // Sync overlayImages map when elements change (handles undo/redo, clear)
  useEffect(() => {
    const imageElements = elements.filter((el): el is DrawingImageElement => el.type === 'image');
    const currentIds = new Set(imageElements.map((el) => el.id));

    // Remove images from map that are no longer in elements
    setOverlayImages((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!currentIds.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      // Load any image elements not yet in the map (e.g., from undo)
      for (const el of imageElements) {
        if (!next.has(el.id)) {
          changed = true;
          const img = new window.Image();
          img.onload = () => {
            setOverlayImages((p) => {
              const n = new Map(p);
              n.set(el.id, img);
              return n;
            });
          };
          img.src = el.imageUrl;
        }
      }
      return changed ? next : prev;
    });
  }, [elements]);

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

  async function handleConfirm() {
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
      showErrorNotification({
        title: 'Export Failed',
        error: new Error('An error occurred while exporting the drawing. Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload() {
    if (!stageRef.current) return;

    try {
      const blob = await exportDrawingToBlob(
        stageRef.current,
        canvasDimensions.width,
        canvasDimensions.height,
        sourceImage.width,
        sourceImage.height,
        sourceImage.url
      );

      // Create download link
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `annotated-image-${Date.now()}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download image:', error);
    }
  }

  function handleClear() {
    setElements([]);
    // Reset history to empty state
    setHistoryState({ entries: [[]], index: 0 });
  }

  const canUndo = historyState.index > 0;

  return (
    <Modal
      {...dialog}
      title={null}
      size={isMobile ? '100%' : 'xl'}
      fullScreen={isMobile}
      onClose={handleCancel}
      closeOnClickOutside={!loading}
      closeOnEscape={!textInput && !loading}
      padding={0}
      radius="md"
      className={styles.modal}
    >
      <div className={isMobile ? styles.mobileLayout : 'flex flex-col'}>
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
              {confirmLabel}
            </Button>
          </div>
        </div>

        <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />} mx="md" py="xs">
          <Text size="xs">
            Sketch annotations produce varying results depending on the model used. For best results,
            use <Text span fw={600}>Nano Banana</Text>.
          </Text>
        </Alert>

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
              overlayImages={overlayImages}
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
            onDownload={handleDownload}
            onAddImage={handleAddImage}
            onAddSpeechBubble={handleAddSpeechBubble}
            isMobile={isMobile}
          />
        </div>
      </div>

      {/* Hidden file input for image overlays */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleImageFileSelect}
      />
    </Modal>
  );
}
