import { 
  AdPosition, 
  AdBlock, 
  MAGNETIC_EDGE_THRESHOLD, 
  SAFE_ZONE_MIN, 
  SAFE_ZONE_MAX,
  BREAKPOINTS 
} from '../types';

/**
 * Check if we're in a browser environment
 */
function isBrowser() {
  return typeof window !== 'undefined';
}

/**
 * Get viewport dimensions safely
 */
function getViewportDimensions() {
  if (!isBrowser()) {
    return { width: 1920, height: 1080 }; // Default fallback for SSR
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

/**
 * Determine which edge an element is closer to
 */
function determineAnchors(x: number, y: number, adSize: { width: number; height: number }): { anchorX: 'left' | 'right'; anchorY: 'top' | 'bottom' } {
  const { width: viewportWidth, height: viewportHeight } = getViewportDimensions();
  
  const centerX = x + adSize.width / 2;
  const centerY = y + adSize.height / 2;
  
  return {
    anchorX: centerX < viewportWidth / 2 ? 'left' : 'right',
    anchorY: centerY < viewportHeight / 2 ? 'top' : 'bottom',
  };
}

/**
 * Calculate edge distances based on position and size
 */
function calculateEdgeDistances(x: number, y: number, adSize: { width: number; height: number }) {
  const { width: viewportWidth, height: viewportHeight } = getViewportDimensions();
  
  return {
    fromLeft: x,
    fromRight: viewportWidth - (x + adSize.width),
    fromTop: y,
    fromBottom: viewportHeight - (y + adSize.height),
  };
}

/**
 * Convert edge-based position to pixels based on current viewport
 */
export function edgePositionToPixels(position: AdPosition, adSize: { width: number; height: number }): { x: number; y: number } {
  const { width: viewportWidth, height: viewportHeight } = getViewportDimensions();
  
  let x: number;
  let y: number;
  
  // Calculate X based on anchor
  if (position.anchorX === 'left' && position.fromLeft !== undefined) {
    x = position.fromLeft;
  } else if (position.anchorX === 'right' && position.fromRight !== undefined) {
    x = viewportWidth - adSize.width - position.fromRight;
  } else {
    x = position.x; // Fallback to absolute position
  }
  
  // Calculate Y based on anchor
  if (position.anchorY === 'top' && position.fromTop !== undefined) {
    y = position.fromTop;
  } else if (position.anchorY === 'bottom' && position.fromBottom !== undefined) {
    y = viewportHeight - adSize.height - position.fromBottom;
  } else {
    y = position.y; // Fallback to absolute position
  }
  
  // Ensure within bounds
  x = Math.max(0, Math.min(x, viewportWidth - adSize.width));
  y = Math.max(0, Math.min(y, viewportHeight - adSize.height));
  
  return { x, y };
}

/**
 * Update position with edge-based tracking
 */
export function updatePosition(pixelX: number, pixelY: number, adSize: { width: number; height: number }): AdPosition {
  const { width: viewportWidth, height: viewportHeight } = getViewportDimensions();
  
  // Ensure within bounds
  const x = Math.max(0, Math.min(pixelX, viewportWidth - adSize.width));
  const y = Math.max(0, Math.min(pixelY, viewportHeight - adSize.height));
  
  // Determine which edges to anchor to
  const anchors = determineAnchors(x, y, adSize);
  
  // Calculate distances from edges
  const distances = calculateEdgeDistances(x, y, adSize);
  
  // Apply magnetic snapping
  const magneticThreshold = viewportWidth * MAGNETIC_EDGE_THRESHOLD;
  
  // Snap to edges if close enough
  if (distances.fromLeft < magneticThreshold) {
    distances.fromLeft = 0;
  }
  if (distances.fromRight < magneticThreshold) {
    distances.fromRight = 0;
  }
  if (distances.fromTop < magneticThreshold) {
    distances.fromTop = 0;
  }
  if (distances.fromBottom < magneticThreshold) {
    distances.fromBottom = 0;
  }
  
  return {
    x,
    y,
    ...anchors,
    ...distances,
  };
}

/**
 * Recalculate positions on viewport resize
 */
export function recalculatePositions(blocks: AdBlock[]): AdBlock[] {
  return blocks.map(block => {
    const size = block.minimized 
      ? { width: 200, height: 40 } 
      : block.size;
    
    // Convert edge position back to pixels for new viewport size
    const { x, y } = edgePositionToPixels(block.position, size);
    
    // Update with new pixel positions
    const position = updatePosition(x, y, size);
    
    return {
      ...block,
      position,
    };
  });
}

/**
 * Get responsive layout mode based on viewport width
 */
export function getLayoutMode(): 'mobile' | 'tablet' | 'desktop' {
  if (!isBrowser()) {
    return 'desktop'; // Default to desktop for SSR
  }
  const width = window.innerWidth;
  
  if (width < BREAKPOINTS.mobile) {
    return 'mobile';
  } else if (width < BREAKPOINTS.tablet) {
    return 'tablet';
  } else {
    return 'desktop';
  }
}

/**
 * Get default position for new ads
 */
export function getDefaultPosition(index: number, adSize: { width: number; height: number }): AdPosition {
  // Start position with some offset for each ad
  const startX = 100 + (index * 50);
  const startY = 100 + (index * 50);
  
  return updatePosition(startX, startY, adSize);
}