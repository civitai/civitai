import React, { useEffect } from 'react';
import { Box, Text } from '@mantine/core';
import clsx from 'clsx';
import { DraggableAdBlock } from './DraggableAdBlock';
import { GridOverlay } from './GridOverlay';
import { AdControlButton } from './AdControlButton';
import { AdManagementPanel } from './AdManagementPanel';
import useAdLayerStore from './hooks/useAdLayerStore';
import { useResponsiveMode } from './hooks/useResponsiveMode';

interface AdLayerMockupProps {
  enabled?: boolean;
}

export const AdLayerMockup: React.FC<AdLayerMockupProps> = ({ enabled = true }) => {
  const { blocks, isEditMode, showGrid, handleResize } = useAdLayerStore();
  const { layoutMode, canDrag, isMobile } = useResponsiveMode();

  // Handle keyboard shortcuts (desktop only)
  useEffect(() => {
    if (isMobile) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      // Toggle edit mode with Ctrl/Cmd + E
      if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
        e.preventDefault();
        useAdLayerStore.getState().toggleEditMode();
      }
      // Toggle panel with Ctrl/Cmd + M
      if ((e.ctrlKey || e.metaKey) && e.key === 'm') {
        e.preventDefault();
        useAdLayerStore.getState().togglePanel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMobile]);

  // Handle window resize
  useEffect(() => {
    let resizeTimeout: NodeJS.Timeout;
    
    const handleWindowResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        handleResize();
      }, 100); // Debounce resize events
    };

    window.addEventListener('resize', handleWindowResize);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
      clearTimeout(resizeTimeout);
    };
  }, [handleResize]);

  if (!enabled) return null;

  return (
    <>
      {/* Ad Layer Container - Full Viewport Coverage */}
      <div
        className={clsx(
          'pointer-events-none z-[9999]',
          isEditMode && 'pointer-events-auto'
        )}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          backgroundColor: isEditMode ? 'rgba(0, 0, 0, 0.05)' : 'transparent',
          overflow: 'hidden', // Prevent any scrolling within the ad layer
        }}
      >
        {/* Grid Overlay */}
        {showGrid && isEditMode && <GridOverlay />}

        {/* Ad Blocks */}
        {blocks.map((block) => (
          <DraggableAdBlock 
            key={block.id} 
            block={block} 
            isEditMode={isEditMode && canDrag} 
          />
        ))}

        {/* Edit Mode Indicator */}
        {isEditMode && (
          <Box className="fixed left-1/2 top-4 z-[10000] -translate-x-1/2 transform">
            <div className="rounded-full bg-blue-500 px-4 py-2 text-white shadow-lg">
              <span className="text-sm font-medium">
                {canDrag 
                  ? 'Edit Mode - Drag ads to reposition' 
                  : `${layoutMode} View - Dragging disabled`}
              </span>
            </div>
          </Box>
        )}
        
        {/* Mobile/Tablet Notice */}
        {!canDrag && (
          <Box className="fixed bottom-20 left-1/2 z-[9998] -translate-x-1/2 transform">
            <div className="rounded-lg bg-yellow-500 px-3 py-2 text-white shadow-lg">
              <Text size="xs" className="font-medium">
                Ad positioning is fixed on {layoutMode} devices
              </Text>
            </div>
          </Box>
        )}
      </div>

      {/* Control Button */}
      <AdControlButton />

      {/* Management Panel */}
      <AdManagementPanel />
    </>
  );
};