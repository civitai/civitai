import { useEffect, useRef, useState, useCallback } from 'react';
import type Konva from 'konva';
import { Stage, Layer, Line, Image as KonvaImage } from 'react-konva';
import { Loader, Text } from '@mantine/core';

export type MaskStroke = {
  points: number[];
  strokeWidth: number;
};

interface MaskEditorCanvasProps {
  sourceImageUrl: string;
  width: number;
  height: number;
  brushSize: number;
  strokes: MaskStroke[];
  onStrokesChange: (strokes: MaskStroke[]) => void;
  onCommit?: () => void;
  onStageReady?: (stage: Konva.Stage) => void;
  /** Color shown under the image where the user has erased. `null` shows a transparency checkerboard. */
  backgroundColor: string | null;
}

function getDrawablePoints(points: number[]): number[] {
  return points.length === 2 ? [...points, ...points] : points;
}

export function MaskEditorCanvas({
  sourceImageUrl,
  width,
  height,
  brushSize,
  strokes,
  onStrokesChange,
  onCommit,
  onStageReady,
  backgroundColor,
}: MaskEditorCanvasProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const currentStrokeRef = useRef<MaskStroke | null>(null);
  const stageReadyCalledRef = useRef(false);

  const cursorRef = useRef<HTMLDivElement>(null);
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);

  const updateCursorPosition = useCallback((x: number, y: number) => {
    cursorPosRef.current = { x, y };
    if (cursorRef.current) {
      cursorRef.current.style.left = `${x}px`;
      cursorRef.current.style.top = `${y}px`;
      cursorRef.current.style.display = 'block';
    }
  }, []);

  const hideCursor = useCallback(() => {
    cursorPosRef.current = null;
    if (cursorRef.current) cursorRef.current.style.display = 'none';
  }, []);

  useEffect(() => {
    setImageLoading(true);
    setImageError(false);
    setImage(null);

    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.src = sourceImageUrl;
    img.onload = () => {
      setImage(img);
      setImageLoading(false);
    };
    img.onerror = () => {
      setImage(null);
      setImageLoading(false);
      setImageError(true);
    };
  }, [sourceImageUrl]);

  const captureStageFromEvent = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (!stageReadyCalledRef.current) {
      const stage = e.target.getStage();
      if (stage) {
        stageReadyCalledRef.current = true;
        onStageReady?.(stage);
      }
    }
  };

  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    e.evt.preventDefault();
    captureStageFromEvent(e);
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    const newStroke: MaskStroke = {
      points: [pos.x, pos.y],
      strokeWidth: brushSize,
    };
    currentStrokeRef.current = newStroke;
    setIsDrawing(true);
    onStrokesChange([...strokes, newStroke]);
  };

  const handleMouseMove = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    captureStageFromEvent(e);
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (pos) updateCursorPosition(pos.x, pos.y);

    if (!isDrawing || !pos || !currentStrokeRef.current) return;
    e.evt.preventDefault();

    currentStrokeRef.current = {
      ...currentStrokeRef.current,
      points: [...currentStrokeRef.current.points, pos.x, pos.y],
    };
    onStrokesChange([...strokes.slice(0, -1), currentStrokeRef.current]);
  };

  const handleMouseUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    currentStrokeRef.current = null;
    onCommit?.();
  };

  const handleMouseEnter = (e: Konva.KonvaEventObject<MouseEvent>) => {
    captureStageFromEvent(e as Konva.KonvaEventObject<MouseEvent | TouchEvent>);
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (pos) updateCursorPosition(pos.x, pos.y);
  };

  const handleMouseLeave = () => {
    hideCursor();
    handleMouseUp();
  };

  return (
    <div style={{ position: 'relative', width, height }}>
      {imageLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
          <div className="text-center">
            <Loader size="lg" />
            <Text mt="md" c="white">
              Loading image...
            </Text>
          </div>
        </div>
      )}

      {imageError && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
          <Text c="red" fw={500}>
            Failed to load image
          </Text>
        </div>
      )}

      {/* Backdrop under the image — shows through wherever the user erases. */}
      {backgroundColor !== null ? (
        <div className="absolute inset-0" style={{ backgroundColor }} />
      ) : (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(45deg, #cbd5e1 25%, transparent 25%),' +
              'linear-gradient(-45deg, #cbd5e1 25%, transparent 25%),' +
              'linear-gradient(45deg, transparent 75%, #cbd5e1 75%),' +
              'linear-gradient(-45deg, transparent 75%, #cbd5e1 75%)',
            backgroundSize: '16px 16px',
            backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
            backgroundColor: '#e2e8f0',
          }}
        />
      )}

      <Stage
        width={width}
        height={height}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleMouseDown}
        onTouchMove={handleMouseMove}
        onTouchEnd={handleMouseUp}
        style={{ cursor: 'none', position: 'relative' }}
      >
        {/* Single layer so eraser strokes (destination-out) punch through the image */}
        <Layer>
          {image && <KonvaImage image={image} width={width} height={height} listening={false} />}
          {strokes.map((stroke, i) => (
            <Line
              key={i}
              points={getDrawablePoints(stroke.points)}
              stroke="#000"
              strokeWidth={stroke.strokeWidth}
              tension={0.5}
              lineCap="round"
              lineJoin="round"
              globalCompositeOperation="destination-out"
              listening={false}
            />
          ))}
        </Layer>
      </Stage>

      <div
        ref={cursorRef}
        style={{
          position: 'absolute',
          left: -100,
          top: -100,
          width: brushSize,
          height: brushSize,
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          display: 'none',
          backgroundColor: 'transparent',
          border: '2px solid rgba(100, 100, 100, 0.8)',
          boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.5)',
        }}
      />
    </div>
  );
}
