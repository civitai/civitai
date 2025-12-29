import type Konva from 'konva';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';

export type DrawingTool = 'brush' | 'eraser';

export interface DrawingLine {
  tool: DrawingTool;
  points: number[];
  color: string;
  strokeWidth: number;
}

export interface DrawingState {
  lines: DrawingLine[];
  tool: DrawingTool;
  brushSize: number;
  brushColor: string;
}

export interface DrawingCanvasProps {
  backgroundImage: string;
  width: number;
  height: number;
  tool: DrawingTool;
  brushSize: number;
  brushColor: string;
  lines: DrawingLine[];
  onLinesChange: (lines: DrawingLine[]) => void;
  onStageReady?: (stage: Konva.Stage) => void;
}

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
}

export interface DrawingEditorModalProps {
  sourceImage: SourceImageProps;
  onConfirm: (drawingBlob: Blob, lines: DrawingLine[]) => void;
  onCancel?: () => void;
  initialLines?: DrawingLine[];
}
