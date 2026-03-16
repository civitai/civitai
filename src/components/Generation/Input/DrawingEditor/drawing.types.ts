import type Konva from 'konva';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';

// Tool types for selection
export type DrawingTool = 'select' | 'brush' | 'eraser' | 'rectangle' | 'circle' | 'arrow' | 'text' | 'speechBubble';

// Base interface with shared properties
interface DrawingElementBase {
  id: string; // Unique identifier for selection/manipulation
  color: string;
  strokeWidth: number;
}

// Line element (brush and eraser strokes)
export interface DrawingLineElement extends DrawingElementBase {
  type: 'line';
  tool: 'brush' | 'eraser';
  points: number[]; // [x1, y1, x2, y2, ...] flat array
}

// Rectangle element
export interface DrawingRectElement extends DrawingElementBase {
  type: 'rectangle';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
}

// Circle/Ellipse element
export interface DrawingCircleElement extends DrawingElementBase {
  type: 'circle';
  x: number; // center x
  y: number; // center y
  radiusX: number; // horizontal radius
  radiusY: number; // vertical radius (allows ellipse)
  rotation?: number;
}

// Arrow element
export interface DrawingArrowElement extends DrawingElementBase {
  type: 'arrow';
  points: number[]; // [startX, startY, endX, endY]
  rotation?: number;
}

// Speech bubble element
export interface DrawingSpeechBubbleElement extends DrawingElementBase {
  type: 'speechBubble';
  x: number;
  y: number;
  width: number;
  height: number;
  tailX: number; // tail tip position relative to bubble center
  tailY: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
}

// Image overlay element
export interface DrawingImageElement {
  type: 'image';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  imageUrl: string; // Data URL of the overlay
  color: string; // Unused, kept for interface consistency
  strokeWidth: number; // Unused, kept for consistency
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
}

// Text element
export interface DrawingTextElement {
  type: 'text';
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  strokeWidth: number; // kept for interface consistency, not used for text
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  width?: number; // text width for transformer resize
}

// Union type for all drawing elements
export type DrawingElement =
  | DrawingLineElement
  | DrawingRectElement
  | DrawingCircleElement
  | DrawingArrowElement
  | DrawingSpeechBubbleElement
  | DrawingTextElement
  | DrawingImageElement;

// Schema-compatible element type (id is optional for backward compatibility with form data)
export type DrawingElementSchema =
  | (Omit<DrawingLineElement, 'id'> & { id?: string })
  | (Omit<DrawingRectElement, 'id'> & { id?: string })
  | (Omit<DrawingCircleElement, 'id'> & { id?: string })
  | (Omit<DrawingArrowElement, 'id'> & { id?: string })
  | (Omit<DrawingSpeechBubbleElement, 'id'> & { id?: string })
  | (Omit<DrawingTextElement, 'id'> & { id?: string })
  | (Omit<DrawingImageElement, 'id'> & { id?: string });

// Legacy type alias for backward compatibility (DrawingLine without 'type' field)
export interface DrawingLine {
  tool: 'brush' | 'eraser';
  points: number[];
  color: string;
  strokeWidth: number;
}

// Type that accepts legacy, schema-compatible, and full formats for initialLines
export type DrawingLineInput = DrawingLine | DrawingElement | DrawingElementSchema;

// Updated state interface
export interface DrawingState {
  elements: DrawingElement[];
  tool: DrawingTool;
  brushSize: number;
  brushColor: string;
}

// Updated canvas props
export interface DrawingCanvasProps {
  backgroundImage: string;
  width: number;
  height: number;
  tool: DrawingTool;
  brushSize: number;
  brushColor: string;
  elements: DrawingElement[];
  onElementsChange: (elements: DrawingElement[]) => void;
  onStageReady?: (stage: Konva.Stage) => void;
  // Text input callback - canvas tells parent to show text input at this position
  onTextPlacement?: (position: { x: number; y: number }) => void;
  // Text edit callback - canvas tells parent to edit existing text element
  onTextEdit?: (element: DrawingTextElement) => void;
  // Selection state for move/resize
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  // Called when an action is finalized (mouse up, transform end) to commit to history
  onCommit?: () => void;
  // ID of text element currently being edited (to hide it from canvas)
  editingTextId?: string | null;
  // Pre-loaded HTMLImageElement instances for image overlay elements
  overlayImages?: Map<string, HTMLImageElement>;
}

// Updated toolbar props
export interface DrawingToolbarProps {
  tool: DrawingTool;
  onToolChange: (tool: DrawingTool) => void;
  brushSize: number;
  onBrushSizeChange: (size: number) => void;
  brushColor: string;
  onBrushColorChange: (color: string) => void;
  onClear: () => void;
  onUndo: () => void;
  canUndo: boolean;
  onDownload?: () => void;
  onAddImage?: () => void;
  isMobile?: boolean;
}

// Updated modal props - accepts legacy format, outputs new format
export interface DrawingEditorModalProps {
  sourceImage: SourceImageProps;
  // onConfirm can return a Promise - modal will wait for it to resolve before closing
  onConfirm: (drawingBlob: Blob, elements: DrawingElement[]) => void | Promise<void>;
  onCancel?: () => void;
  initialLines?: DrawingLineInput[]; // Accepts both old and new formats
  confirmLabel?: string; // Custom label for the confirm button (default: "Apply")
}
