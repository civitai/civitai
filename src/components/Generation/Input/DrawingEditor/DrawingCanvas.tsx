import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type Konva from 'konva';
import type { DrawingCanvasProps, DrawingLine } from './drawing.types';

// Dynamic imports for SSR compatibility
const Stage = dynamic(() => import('react-konva').then((mod) => mod.Stage), {
  ssr: false,
});

const Layer = dynamic(() => import('react-konva').then((mod) => mod.Layer), {
  ssr: false,
});

const Line = dynamic(() => import('react-konva').then((mod) => mod.Line), {
  ssr: false,
});

const KonvaImage = dynamic(() => import('react-konva').then((mod) => mod.Image), {
  ssr: false,
});

// Helper to ensure single points render as dots by duplicating the point
function getDrawablePoints(points: number[]): number[] {
  // Konva Line needs at least 2 points (4 values) to render
  // For single points, duplicate them so it draws a dot
  if (points.length === 2) {
    return [...points, ...points];
  }
  return points;
}

export function DrawingCanvas({
  backgroundImage,
  width,
  height,
  tool,
  brushSize,
  brushColor,
  lines,
  onLinesChange,
  onStageReady,
}: DrawingCanvasProps) {
  const [isDrawing, setIsDrawing] = useState(false);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const currentLineRef = useRef<DrawingLine | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stageInstanceRef = useRef<Konva.Stage | null>(null);
  const stageReadyCalledRef = useRef(false);

  // Helper to capture stage from event and notify parent
  const captureStageFromEvent = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (!stageReadyCalledRef.current) {
      const stage = e.target.getStage();
      if (stage) {
        stageInstanceRef.current = stage;
        stageReadyCalledRef.current = true;
        onStageReady?.(stage);
      }
    }
  };

  // Load background image
  useEffect(() => {
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.src = backgroundImage;
    img.onload = () => {
      setImage(img);
    };
  }, [backgroundImage]);

  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    e.evt.preventDefault();
    captureStageFromEvent(e);

    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    const newLine: DrawingLine = {
      tool,
      points: [pos.x, pos.y],
      color: tool === 'eraser' ? '#000000' : brushColor,
      strokeWidth: brushSize,
    };
    currentLineRef.current = newLine;
    setIsDrawing(true);
    // Add the line immediately so single clicks (dots) are captured
    onLinesChange([...lines, newLine]);
  };

  const handleMouseMove = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    captureStageFromEvent(e);

    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();

    // Update cursor position for visual feedback
    if (pos) {
      setCursorPos({ x: pos.x, y: pos.y });
    }

    if (!isDrawing || !currentLineRef.current) return;
    e.evt.preventDefault();

    if (!pos) return;

    // Update current line with new point
    currentLineRef.current = {
      ...currentLineRef.current,
      points: [...currentLineRef.current.points, pos.x, pos.y],
    };

    // Replace the last line (which is the current one being drawn) with updated version
    onLinesChange([...lines.slice(0, -1), currentLineRef.current]);
  };

  const handleMouseUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    currentLineRef.current = null;
    // Line is already in the lines array from handleMouseDown/handleMouseMove
  };

  const handleMouseEnter = (e: Konva.KonvaEventObject<MouseEvent>) => {
    captureStageFromEvent(e as Konva.KonvaEventObject<MouseEvent | TouchEvent>);

    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (pos) {
      setCursorPos({ x: pos.x, y: pos.y });
    }
  };

  const handleMouseLeave = () => {
    setCursorPos(null);
    handleMouseUp();
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', width, height }}>
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
        style={{ cursor: 'none' }}
      >
        {/* Background layer with source image */}
        <Layer listening={false}>
          {image && <KonvaImage image={image} width={width} height={height} listening={false} />}
        </Layer>

        {/* Drawing layer */}
        <Layer>
          {lines.map((line, i) => (
            <Line
              key={i}
              points={getDrawablePoints(line.points)}
              stroke={line.color}
              strokeWidth={line.strokeWidth}
              tension={0.5}
              lineCap="round"
              lineJoin="round"
              globalCompositeOperation={line.tool === 'eraser' ? 'destination-out' : 'source-over'}
            />
          ))}
        </Layer>
      </Stage>

      {/* Custom cursor overlay */}
      {cursorPos && (
        <div
          style={{
            position: 'absolute',
            left: cursorPos.x,
            top: cursorPos.y,
            width: brushSize,
            height: brushSize,
            borderRadius: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            ...(tool === 'brush'
              ? {
                  backgroundColor: brushColor,
                  opacity: 0.7,
                  border: '1px solid rgba(0, 0, 0, 0.3)',
                }
              : {
                  backgroundColor: 'transparent',
                  border: '2px solid rgba(100, 100, 100, 0.8)',
                  boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.5)',
                }),
          }}
        />
      )}
    </div>
  );
}
