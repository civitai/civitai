import { useState, useEffect } from 'react';
import { BREAKPOINTS } from '../types';
import { getLayoutMode } from '../utils/positionUtils';

export function useResponsiveMode() {
  const [layoutMode, setLayoutMode] = useState<'mobile' | 'tablet' | 'desktop'>(() => getLayoutMode());

  useEffect(() => {
    const handleResize = () => {
      setLayoutMode(getLayoutMode());
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return {
    layoutMode,
    isMobile: layoutMode === 'mobile',
    isTablet: layoutMode === 'tablet',
    isDesktop: layoutMode === 'desktop',
    canDrag: layoutMode === 'desktop', // Only allow dragging on desktop
  };
}