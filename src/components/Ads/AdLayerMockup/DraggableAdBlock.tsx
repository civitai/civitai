import React, { useState, useEffect, useRef } from 'react';
import Draggable from 'react-draggable';
import { ActionIcon, Box, Image, Text, ThemeIcon, Transition } from '@mantine/core';
import { IconMinus, IconPlus, IconX, IconGripVertical, IconBolt } from '@tabler/icons-react';
import clsx from 'clsx';
import { AdBlock, GRID_SIZE } from './types';
import useAdLayerStore from './hooks/useAdLayerStore';
import { edgePositionToPixels } from './utils/positionUtils';
import { generateMockAdContent } from './utils/mockAdData';

interface DraggableAdBlockProps {
  block: AdBlock;
  isEditMode: boolean;
}

export const DraggableAdBlock: React.FC<DraggableAdBlockProps> = ({ block, isEditMode }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [showBuzzReward, setShowBuzzReward] = useState(false);
  const [rotationTimer, setRotationTimer] = useState<number>(0);
  const [currentAdContent, setCurrentAdContent] = useState(block.content);
  const rotationIntervalRef = useRef<NodeJS.Timeout>();
  const timerIntervalRef = useRef<NodeJS.Timeout>();

  const { updateBlockPosition, toggleMinimize, removeBlock, bringToFront, rotateAd } = useAdLayerStore();

  // Calculate current position based on edge anchoring
  const currentSize = block.minimized
    ? { width: 200, height: 40 }
    : block.size;

  const currentPosition = edgePositionToPixels(block.position, currentSize);

  const handleDragStop = (_e: any, data: any) => {
    updateBlockPosition(block.id, data.x, data.y);
    setIsDragging(false);
  };

  const handleDragStart = () => {
    setIsDragging(true);
    bringToFront(block.id);
  };

  const canRemove = useAdLayerStore((state) => state.blocks.length > 2);

  // Update content when currentAdIndex changes
  useEffect(() => {
    if (block.currentAdIndex !== undefined && block.currentAdIndex > 0) {
      const newContent = generateMockAdContent(block.type, block.currentAdIndex);
      setCurrentAdContent(newContent);
    }
  }, [block.currentAdIndex, block.type]);

  // Ad rotation logic
  useEffect(() => {
    // Don't rotate if in edit mode or minimized
    if (isEditMode || block.minimized) {
      if (rotationIntervalRef.current) {
        clearTimeout(rotationIntervalRef.current);
        clearInterval(timerIntervalRef.current!);
        setRotationTimer(0);
      }
      return;
    }

    const startRotation = () => {
      // Random rotation interval between 5-20 seconds
      const rotationInterval = Math.random() * 15000 + 5000; // 5-20 seconds
      let timeLeft = Math.floor(rotationInterval / 1000);
      setRotationTimer(timeLeft);

      // Update timer display
      timerIntervalRef.current = setInterval(() => {
        timeLeft -= 1;
        setRotationTimer(timeLeft);
        if (timeLeft <= 0) {
          clearInterval(timerIntervalRef.current!);
        }
      }, 1000);

      // Set up rotation
      rotationIntervalRef.current = setTimeout(() => {
        // Show buzz reward animation
        setShowBuzzReward(true);
        setTimeout(() => setShowBuzzReward(false), 2000);

        // Update rotation count and trigger content change via currentAdIndex
        rotateAd(block.id);

        // Clear timer interval
        clearInterval(timerIntervalRef.current!);

        // Start next rotation cycle
        startRotation();
      }, rotationInterval);
    };

    // Start the first rotation
    startRotation();

    return () => {
      if (rotationIntervalRef.current) clearTimeout(rotationIntervalRef.current);
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, [block.id, block.minimized, isEditMode, rotateAd]);

  return (
    <>
      <Draggable
        position={currentPosition}
        onStop={handleDragStop}
        onStart={handleDragStart}
        disabled={!isEditMode}
        grid={[GRID_SIZE, GRID_SIZE]}
        handle=".drag-handle"
      >
        <Box
          className={clsx(
            'absolute pointer-events-auto',
            isDragging && 'scale-105 opacity-90',
            isEditMode && 'ring-2 ring-blue-400 ring-opacity-50',
            !isDragging && 'transition-all duration-200'
          )}
          style={{
            zIndex: block.zIndex,
            width: block.minimized ? 200 : block.size.width,
            height: block.minimized ? 40 : block.size.height,
          }}
        >
          {/* Ad Controls Header */}
          <Box
            className={clsx(
              'relative flex items-center justify-between bg-gray-100 px-2 py-1 dark:bg-dark-6',
              isEditMode && 'drag-handle cursor-move'
            )}
          >
            <div className="flex items-center gap-1">
              {isEditMode && <IconGripVertical size={16} className="text-gray-500" />}
              <Text size="xs" className="text-gray-600 dark:text-gray-400">
                {currentAdContent.title}
              </Text>
              {/* Rotation timer */}
              {!isEditMode && !block.minimized && rotationTimer > 0 && (
                <Text size="xs" className="ml-2 text-gray-500">
                  {rotationTimer}s
                </Text>
              )}
            </div>
            <div className="flex items-center gap-1">
              {/* Buzz rewards counter */}
              {(block.rotationCount || 0) > 0 && (
                <div className="flex items-center gap-1 mr-2">
                  <IconBolt size={14} className="text-blue-500 fill-blue-500" />
                  <Text size="xs" className="text-blue-600 dark:text-blue-400 font-semibold">
                    {block.rotationCount}
                  </Text>
                </div>
              )}
              <ActionIcon
                size="xs"
                variant="subtle"
                onClick={() => toggleMinimize(block.id)}
                title={block.minimized ? 'Expand' : 'Minimize'}
              >
                {block.minimized ? <IconPlus size={14} /> : <IconMinus size={14} />}
              </ActionIcon>
              {isEditMode && canRemove && (
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={() => {
                    if (confirm('Remove this ad block?')) {
                      removeBlock(block.id);
                    }
                  }}
                  title="Remove ad block"
                >
                  <IconX size={14} />
                </ActionIcon>
              )}
            </div>
          </Box>

          {/* Ad Content */}
          {!block.minimized && (
            <Box className="relative h-full w-full overflow-hidden border border-gray-200 bg-white dark:border-dark-4 dark:bg-dark-7">
              <Image
                src={currentAdContent.imageUrl}
                alt={currentAdContent.title}
                className="h-full w-full object-cover"
              />
              {isEditMode && (
                <Box className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-20">
                  <Text className="text-white" fw={600}>
                    {block.type.toUpperCase()} AD
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Draggable>

      {/* Buzz Reward Animation Overlay */}
      <Transition
        mounted={showBuzzReward}
        transition="pop"
        duration={400}
        timingFunction="ease"
      >
        {(styles) => (
          <div
            style={{
              ...styles,
              position: 'absolute',
              left: currentPosition.x + currentSize.width / 2 - 30,
              top: currentPosition.y + currentSize.height / 2 - 30,
              zIndex: block.zIndex + 1000,
              pointerEvents: 'none',
            }}
          >
            <ThemeIcon
              size={60}
              radius="xl"
              className="bg-blue-500 shadow-lg animate-bounce"
              style={{
                boxShadow: '0 0 20px rgba(59, 130, 246, 0.5)',
              }}
            >
              <IconBolt size={32} className="text-white fill-white" />
            </ThemeIcon>
            <Text
              className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-blue-600 font-bold text-nowrap"
              size="lg"
              style={{ textShadow: '0 0 10px rgba(59, 130, 246, 0.3)' }}
            >
              +1 Buzz!
            </Text>
          </div>
        )}
      </Transition>
    </>
  );
};
