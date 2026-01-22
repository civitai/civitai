import { useEffect, useRef, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import type Konva from 'konva';
import type {
  DrawingCanvasProps,
  DrawingLineElement,
  DrawingRectElement,
  DrawingCircleElement,
  DrawingArrowElement,
  DrawingTextElement,
  DrawingElement,
} from './drawing.types';
import { generateElementId, isTransformableElement } from './drawing.utils';
import styles from './DrawingEditor.module.scss';
import { ActionIcon, Loader, Text } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useIsMobile } from '~/hooks/useIsMobile';

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

const Rect = dynamic(() => import('react-konva').then((mod) => mod.Rect), {
  ssr: false,
});

const Ellipse = dynamic(() => import('react-konva').then((mod) => mod.Ellipse), {
  ssr: false,
});

const Arrow = dynamic(() => import('react-konva').then((mod) => mod.Arrow), {
  ssr: false,
});

const KonvaText = dynamic(() => import('react-konva').then((mod) => mod.Text), {
  ssr: false,
});

const Transformer = dynamic(() => import('react-konva').then((mod) => mod.Transformer), {
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
  elements,
  onElementsChange,
  onStageReady,
  onTextPlacement,
  onTextEdit,
  selectedId,
  onSelectedIdChange,
  onCommit,
  editingTextId,
}: DrawingCanvasProps) {
  const isMobile = useIsMobile({ type: 'media', breakpoint: 'md' });
  const [isDrawing, setIsDrawing] = useState(false);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [transformerReady, setTransformerReady] = useState(false);
  const currentLineRef = useRef<DrawingLineElement | null>(null);
  const stageInstanceRef = useRef<Konva.Stage | null>(null);
  const stageReadyCalledRef = useRef(false);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const shapeRefs = useRef<Map<string, Konva.Node>>(new Map());

  // Use ref for cursor position to avoid re-renders on mouse move
  const cursorRef = useRef<HTMLDivElement>(null);
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);

  // Update cursor element position directly (bypasses React re-render)
  const updateCursorPosition = useCallback((x: number, y: number) => {
    cursorPosRef.current = { x, y };
    if (cursorRef.current) {
      cursorRef.current.style.left = `${x}px`;
      cursorRef.current.style.top = `${y}px`;
    }
  }, []);

  // Hide cursor element directly
  const hideCursor = useCallback(() => {
    cursorPosRef.current = null;
    if (cursorRef.current) {
      cursorRef.current.style.display = 'none';
    }
  }, []);

  // Show cursor element directly
  const showCursor = useCallback(() => {
    if (cursorRef.current) {
      cursorRef.current.style.display = 'block';
    }
  }, []);

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
    setImageLoading(true);
    setImageError(false);
    setImage(null);

    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.src = backgroundImage;
    img.onload = () => {
      setImage(img);
      setImageLoading(false);
      setImageError(false);
    };
    img.onerror = () => {
      setImage(null);
      setImageLoading(false);
      setImageError(true);
    };
  }, [backgroundImage]);

  // Update transformer when selection changes or transformer becomes ready
  // Uses requestAnimationFrame to ensure shape refs are populated after dynamic components render
  useEffect(() => {
    // Check if transformer is available and has the nodes method (may not be ready due to dynamic import)
    if (
      !transformerReady ||
      !transformerRef.current ||
      typeof transformerRef.current.nodes !== 'function'
    )
      return;

    // Use requestAnimationFrame to ensure shape refs are populated after render
    const frameId = requestAnimationFrame(() => {
      if (selectedId && tool === 'select') {
        const selectedElement = elements.find((el) => el.id === selectedId);
        const selectedNode = shapeRefs.current.get(selectedId);
        // Only attach transformer if element is transformable (not lines)
        // Lines can be selected and moved but don't show resize/rotate handles
        if (
          selectedNode &&
          selectedElement &&
          isTransformableElement(selectedElement) &&
          transformerRef.current
        ) {
          transformerRef.current.nodes([selectedNode]);
          transformerRef.current.getLayer()?.batchDraw();
        } else if (transformerRef.current) {
          transformerRef.current.nodes([]);
          transformerRef.current.getLayer()?.batchDraw();
        }
      } else if (transformerRef.current) {
        transformerRef.current.nodes([]);
        transformerRef.current.getLayer()?.batchDraw();
      }
    });

    return () => cancelAnimationFrame(frameId);
  }, [selectedId, tool, elements, transformerReady]);

  // Store shape ref
  const setShapeRef = useCallback((id: string, node: Konva.Node | null) => {
    if (node) {
      shapeRefs.current.set(id, node);
    } else {
      shapeRefs.current.delete(id);
    }
  }, []);

  // Handle shape selection
  const handleShapeClick = useCallback(
    (e: Konva.KonvaEventObject<Event>, element: DrawingElement) => {
      if (tool !== 'select') return;
      e.cancelBubble = true; // Prevent stage click from deselecting
      onSelectedIdChange(element.id);
    },
    [tool, onSelectedIdChange]
  );

  // Handle text double-click to edit
  const handleTextDoubleClick = useCallback(
    (e: Konva.KonvaEventObject<Event>, element: DrawingTextElement) => {
      e.cancelBubble = true;
      onSelectedIdChange(null); // Deselect to hide transformer
      onTextEdit?.(element);
    },
    [onSelectedIdChange, onTextEdit]
  );

  // Handle drag end - update element position
  const handleDragEnd = useCallback(
    (e: Konva.KonvaEventObject<DragEvent>, element: DrawingElement) => {
      const node = e.target;
      const newX = node.x();
      const newY = node.y();

      const updatedElements = elements.map((el) => {
        if (el.id !== element.id) return el;

        switch (el.type) {
          case 'rectangle':
            return { ...el, x: newX, y: newY };
          case 'circle':
            return { ...el, x: newX, y: newY };
          case 'arrow': {
            // For arrows, newX/newY are the drag offset (node starts at 0,0)
            // Simply add the offset to all points
            return {
              ...el,
              points: [
                el.points[0] + newX,
                el.points[1] + newY,
                el.points[2] + newX,
                el.points[3] + newY,
              ],
            };
          }
          case 'line': {
            // For lines, newX/newY are the drag offset (node starts at 0,0)
            // Apply the offset to all points in the points array
            const newPoints = el.points.map((val, i) => (i % 2 === 0 ? val + newX : val + newY));
            return { ...el, points: newPoints };
          }
          case 'text':
            return { ...el, x: newX, y: newY };
          default:
            return el;
        }
      });

      onElementsChange(updatedElements);

      // Reset node position for arrows and lines (they use points, not x/y)
      if (element.type === 'arrow' || element.type === 'line') {
        node.x(0);
        node.y(0);
      }

      // Commit to history after drag is finalized
      onCommit?.();
    },
    [elements, onElementsChange, onCommit]
  );

  // Handle transform end - update element size/rotation
  const handleTransformEnd = useCallback(
    (e: Konva.KonvaEventObject<Event>, element: DrawingElement) => {
      const node = e.target;

      const updatedElements = elements.map((el) => {
        if (el.id !== element.id) return el;

        switch (el.type) {
          case 'rectangle': {
            const scaleX = node.scaleX();
            const scaleY = node.scaleY();
            node.scaleX(1);
            node.scaleY(1);
            return {
              ...el,
              x: node.x(),
              y: node.y(),
              width: Math.max(5, (el as DrawingRectElement).width * scaleX),
              height: Math.max(5, (el as DrawingRectElement).height * scaleY),
              rotation: node.rotation(),
            };
          }
          case 'circle': {
            const scaleX = node.scaleX();
            const scaleY = node.scaleY();
            node.scaleX(1);
            node.scaleY(1);
            return {
              ...el,
              x: node.x(),
              y: node.y(),
              radiusX: Math.max(5, (el as DrawingCircleElement).radiusX * scaleX),
              radiusY: Math.max(5, (el as DrawingCircleElement).radiusY * scaleY),
              rotation: node.rotation(),
            };
          }
          case 'arrow': {
            // For arrows, transform affects scale - we apply it to points
            const scaleX = node.scaleX();
            const scaleY = node.scaleY();
            node.scaleX(1);
            node.scaleY(1);
            const arrowEl = el as DrawingArrowElement;
            const [x1, y1, x2, y2] = arrowEl.points;
            const cx = (x1 + x2) / 2;
            const cy = (y1 + y2) / 2;
            return {
              ...el,
              points: [
                cx + (x1 - cx) * scaleX,
                cy + (y1 - cy) * scaleY,
                cx + (x2 - cx) * scaleX,
                cy + (y2 - cy) * scaleY,
              ],
              rotation: node.rotation(),
            };
          }
          case 'text': {
            const textEl = el as DrawingTextElement;
            const scaleX = node.scaleX();
            const scaleY = node.scaleY();
            // Convert scale to width for horizontal resizing, keep scaleY for vertical
            const currentWidth = textEl.width || node.width();
            const newWidth = currentWidth * scaleX;
            node.scaleX(1); // Reset scaleX since we're using width
            return {
              ...el,
              x: node.x(),
              y: node.y(),
              width: Math.max(20, newWidth),
              scaleX: 1,
              scaleY: scaleY,
              rotation: node.rotation(),
            };
          }
          default:
            return el;
        }
      });

      onElementsChange(updatedElements);

      // Commit to history after transform is finalized
      onCommit?.();
    },
    [elements, onElementsChange, onCommit]
  );

  // Handle element removal
  const handleRemoveElement = useCallback(() => {
    if (!selectedId) return;
    const updatedElements = elements.filter((el) => el.id !== selectedId);
    onElementsChange(updatedElements);
    onSelectedIdChange(null);
    onCommit?.();
  }, [selectedId, elements, onElementsChange, onSelectedIdChange, onCommit]);

  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    e.evt.preventDefault();
    captureStageFromEvent(e);

    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    // In select mode, clicking on empty area deselects
    if (tool === 'select') {
      const clickedOnEmpty = e.target === stage;
      if (clickedOnEmpty) {
        onSelectedIdChange(null);
      }
      return;
    }

    // Clear selection when using other tools
    if (selectedId) {
      onSelectedIdChange(null);
    }

    if (tool === 'brush' || tool === 'eraser') {
      // Line drawing logic
      const newLine: DrawingLineElement = {
        type: 'line',
        id: generateElementId(),
        tool,
        points: [pos.x, pos.y],
        color: tool === 'eraser' ? '#000000' : brushColor,
        strokeWidth: brushSize,
      };
      currentLineRef.current = newLine;
      setIsDrawing(true);
      onElementsChange([...elements, newLine]);
    } else if (tool === 'rectangle') {
      setDragStart(pos);
      const newRect: DrawingRectElement = {
        type: 'rectangle',
        id: generateElementId(),
        x: pos.x,
        y: pos.y,
        width: 0,
        height: 0,
        color: brushColor,
        strokeWidth: brushSize,
      };
      setIsDrawing(true);
      onElementsChange([...elements, newRect]);
    } else if (tool === 'circle') {
      setDragStart(pos);
      const newCircle: DrawingCircleElement = {
        type: 'circle',
        id: generateElementId(),
        x: pos.x,
        y: pos.y,
        radiusX: 0,
        radiusY: 0,
        color: brushColor,
        strokeWidth: brushSize,
      };
      setIsDrawing(true);
      onElementsChange([...elements, newCircle]);
    } else if (tool === 'arrow') {
      setDragStart(pos);
      const newArrow: DrawingArrowElement = {
        type: 'arrow',
        id: generateElementId(),
        points: [pos.x, pos.y, pos.x, pos.y], // start and end same initially
        color: brushColor,
        strokeWidth: brushSize,
      };
      setIsDrawing(true);
      onElementsChange([...elements, newArrow]);
    } else if (tool === 'text') {
      // Notify parent to show text input at this position
      onTextPlacement?.(pos);
    }
  };

  const handleMouseMove = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    captureStageFromEvent(e);

    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();

    // Update cursor position for visual feedback (direct DOM update, no re-render)
    if (pos) {
      updateCursorPosition(pos.x, pos.y);
    }

    if (!isDrawing || !pos) return;
    e.evt.preventDefault();

    if (tool === 'brush' || tool === 'eraser') {
      // Line drawing logic
      if (!currentLineRef.current) return;
      currentLineRef.current = {
        ...currentLineRef.current,
        points: [...currentLineRef.current.points, pos.x, pos.y],
      };
      onElementsChange([...elements.slice(0, -1), currentLineRef.current]);
    } else if (tool === 'rectangle' && dragStart) {
      // Calculate rect from drag start to current position
      const lastElement = elements[elements.length - 1] as DrawingRectElement;
      const updatedRect: DrawingRectElement = {
        ...lastElement,
        x: Math.min(dragStart.x, pos.x),
        y: Math.min(dragStart.y, pos.y),
        width: Math.abs(pos.x - dragStart.x),
        height: Math.abs(pos.y - dragStart.y),
      };
      onElementsChange([...elements.slice(0, -1), updatedRect]);
    } else if (tool === 'circle' && dragStart) {
      // Calculate ellipse from drag start to current position
      const lastElement = elements[elements.length - 1] as DrawingCircleElement;
      const radiusX = Math.abs(pos.x - dragStart.x);
      const radiusY = Math.abs(pos.y - dragStart.y);
      const updatedCircle: DrawingCircleElement = {
        ...lastElement,
        x: dragStart.x,
        y: dragStart.y,
        radiusX,
        radiusY,
      };
      onElementsChange([...elements.slice(0, -1), updatedCircle]);
    } else if (tool === 'arrow' && dragStart) {
      // Update arrow end point
      const lastElement = elements[elements.length - 1] as DrawingArrowElement;
      const updatedArrow: DrawingArrowElement = {
        ...lastElement,
        points: [dragStart.x, dragStart.y, pos.x, pos.y],
      };
      onElementsChange([...elements.slice(0, -1), updatedArrow]);
    }
  };

  const handleMouseUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    currentLineRef.current = null;
    setDragStart(null);

    // Check if element should be removed (zero-dimension from accidental clicks)
    const lastElement = elements[elements.length - 1];
    let shouldRemove = false;

    if (lastElement) {
      if (lastElement.type === 'rectangle') {
        shouldRemove = lastElement.width < 2 && lastElement.height < 2;
      } else if (lastElement.type === 'circle') {
        shouldRemove = lastElement.radiusX < 2 && lastElement.radiusY < 2;
      } else if (lastElement.type === 'arrow') {
        const [x1, y1, x2, y2] = lastElement.points;
        shouldRemove = Math.abs(x2 - x1) < 2 && Math.abs(y2 - y1) < 2;
      }

      if (shouldRemove) {
        onElementsChange(elements.slice(0, -1));
      } else {
        // Valid element created, commit to history
        onCommit?.();
      }
    }
  };

  const handleMouseEnter = (e: Konva.KonvaEventObject<MouseEvent>) => {
    captureStageFromEvent(e as Konva.KonvaEventObject<MouseEvent | TouchEvent>);

    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (pos) {
      updateCursorPosition(pos.x, pos.y);
      showCursor();
    }
  };

  const handleMouseLeave = () => {
    hideCursor();
    handleMouseUp();
  };

  // Render cursor based on tool type
  const renderCursor = () => {
    // Don't render cursor on mobile (touch devices) or in select mode
    if (isMobile || tool === 'select') {
      return null;
    }

    const initialPos = cursorPosRef.current || { x: -100, y: -100 };
    const isHidden = !cursorPosRef.current;

    if (tool === 'brush' || tool === 'eraser') {
      // Circular brush/eraser cursor
      return (
        <div
          ref={cursorRef}
          style={{
            position: 'absolute',
            left: initialPos.x,
            top: initialPos.y,
            width: brushSize,
            height: brushSize,
            borderRadius: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            display: isHidden ? 'none' : 'block',
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
      );
    } else if (tool === 'text') {
      // Text cursor (I-beam style)
      return (
        <div
          ref={cursorRef}
          className={styles.textCursor}
          style={{
            position: 'absolute',
            left: initialPos.x,
            top: initialPos.y,
            width: 2,
            height: 20,
            backgroundColor: brushColor,
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            display: isHidden ? 'none' : 'block',
          }}
        />
      );
    } else {
      // Crosshair cursor for shapes
      return (
        <div
          ref={cursorRef}
          className={styles.crosshairCursor}
          style={{
            position: 'absolute',
            left: initialPos.x,
            top: initialPos.y,
            width: 16,
            height: 16,
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            display: isHidden ? 'none' : 'block',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 0,
              width: 1,
              height: '100%',
              backgroundColor: 'rgba(0, 0, 0, 0.8)',
              transform: 'translateX(-50%)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: 0,
              width: '100%',
              height: 1,
              backgroundColor: 'rgba(0, 0, 0, 0.8)',
              transform: 'translateY(-50%)',
            }}
          />
        </div>
      );
    }
  };

  // Check if an element should be draggable/selectable
  const isSelectMode = tool === 'select';
  // On mobile, show default cursor; on desktop with custom cursor, hide it
  const stageCursor = isMobile || isSelectMode ? 'default' : 'none';

  return (
    <div style={{ position: 'relative', width, height }}>
      {/* Loading state */}
      {imageLoading && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: 100,
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <Loader size="lg" />
            <Text mt="md" c="white">
              Loading image...
            </Text>
          </div>
        </div>
      )}

      {/* Error state */}
      {imageError && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: 100,
          }}
        >
          <Text c="red" fw={500}>
            Failed to load image
          </Text>
        </div>
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
        style={{ cursor: stageCursor }}
      >
        {/* Background layer with source image */}
        <Layer listening={false}>
          {image && <KonvaImage image={image} width={width} height={height} listening={false} />}
        </Layer>

        {/* Drawing layer */}
        <Layer>
          {elements.map((element) => {
            const canTransform = isTransformableElement(element);
            const isDraggable = isSelectMode && canTransform;

            switch (element.type) {
              case 'line':
                return (
                  <Line
                    key={element.id}
                    ref={canTransform ? (node) => setShapeRef(element.id, node) : undefined}
                    points={getDrawablePoints(element.points)}
                    stroke={element.color}
                    strokeWidth={element.strokeWidth}
                    tension={0.5}
                    lineCap="round"
                    lineJoin="round"
                    globalCompositeOperation={
                      element.tool === 'eraser' ? 'destination-out' : 'source-over'
                    }
                    listening={isDraggable}
                    draggable={isDraggable}
                    onClick={isDraggable ? (e) => handleShapeClick(e, element) : undefined}
                    onTap={isDraggable ? (e) => handleShapeClick(e, element) : undefined}
                    onDragEnd={isDraggable ? (e) => handleDragEnd(e, element) : undefined}
                  />
                );
              case 'rectangle':
                return (
                  <Rect
                    key={element.id}
                    ref={(node) => setShapeRef(element.id, node)}
                    x={element.x}
                    y={element.y}
                    width={element.width}
                    height={element.height}
                    stroke={element.color}
                    strokeWidth={element.strokeWidth}
                    rotation={element.rotation || 0}
                    draggable={isDraggable}
                    onClick={(e) => handleShapeClick(e, element)}
                    onTap={(e) => handleShapeClick(e, element)}
                    onDragEnd={(e) => handleDragEnd(e, element)}
                    onTransformEnd={(e) => handleTransformEnd(e, element)}
                  />
                );
              case 'circle':
                return (
                  <Ellipse
                    key={element.id}
                    ref={(node) => setShapeRef(element.id, node)}
                    x={element.x}
                    y={element.y}
                    radiusX={element.radiusX}
                    radiusY={element.radiusY}
                    stroke={element.color}
                    strokeWidth={element.strokeWidth}
                    rotation={element.rotation || 0}
                    draggable={isDraggable}
                    onClick={(e) => handleShapeClick(e, element)}
                    onTap={(e) => handleShapeClick(e, element)}
                    onDragEnd={(e) => handleDragEnd(e, element)}
                    onTransformEnd={(e) => handleTransformEnd(e, element)}
                  />
                );
              case 'arrow':
                return (
                  <Arrow
                    key={element.id}
                    ref={(node) => setShapeRef(element.id, node)}
                    points={element.points}
                    stroke={element.color}
                    strokeWidth={element.strokeWidth}
                    pointerLength={element.strokeWidth * 2}
                    pointerWidth={element.strokeWidth * 2}
                    rotation={element.rotation || 0}
                    draggable={isDraggable}
                    onClick={(e) => handleShapeClick(e, element)}
                    onTap={(e) => handleShapeClick(e, element)}
                    onDragEnd={(e) => handleDragEnd(e, element)}
                    onTransformEnd={(e) => handleTransformEnd(e, element)}
                  />
                );
              case 'text':
                return (
                  <KonvaText
                    key={element.id}
                    ref={(node) => setShapeRef(element.id, node)}
                    x={element.x}
                    y={element.y}
                    text={element.text}
                    fontSize={element.fontSize}
                    fill={element.color}
                    rotation={element.rotation || 0}
                    scaleX={element.scaleX || 1}
                    scaleY={element.scaleY || 1}
                    width={element.width}
                    draggable={isDraggable}
                    visible={element.id !== editingTextId}
                    onClick={(e) => handleShapeClick(e, element)}
                    onTap={(e) => handleShapeClick(e, element)}
                    onDblClick={(e) => handleTextDoubleClick(e, element)}
                    onDblTap={(e) => handleTextDoubleClick(e, element)}
                    onDragEnd={(e) => handleDragEnd(e, element)}
                    onTransformEnd={(e) => handleTransformEnd(e, element)}
                  />
                );
              default:
                return null;
            }
          })}

          {/* Transformer for selected element - ALWAYS render, control via nodes */}
          <Transformer
            ref={(node) => {
              transformerRef.current = node;
              if (node && !transformerReady) {
                setTransformerReady(true);
              }
            }}
            flipEnabled={false}
            rotateEnabled={true}
            enabledAnchors={[
              'top-left',
              'top-right',
              'bottom-left',
              'bottom-right',
              'middle-left',
              'middle-right',
              'top-center',
              'bottom-center',
            ]}
            boundBoxFunc={(oldBox, newBox) => {
              // Limit minimum size
              if (Math.abs(newBox.width) < 5 || Math.abs(newBox.height) < 5) {
                return oldBox;
              }
              return newBox;
            }}
          />
        </Layer>
      </Stage>

      {/* Custom cursor overlay */}
      {renderCursor()}

      {/* Floating remove button */}
      {selectedId && isSelectMode && (
        <div
          style={{
            position: 'absolute',
            bottom: 20,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
          }}
        >
          <ActionIcon
            size="lg"
            color="red"
            variant="filled"
            onClick={handleRemoveElement}
            style={{
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)',
            }}
          >
            <IconTrash size={18} />
          </ActionIcon>
        </div>
      )}
    </div>
  );
}
