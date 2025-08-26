export interface AdPosition {
  // Edge-based positioning
  fromLeft?: number;   // Distance from left edge (pixels)
  fromRight?: number;  // Distance from right edge (pixels)
  fromTop?: number;    // Distance from top edge (pixels)
  fromBottom?: number; // Distance from bottom edge (pixels)
  
  // Current pixel position for react-draggable
  x: number;
  y: number;
  
  // Which edges to anchor to
  anchorX: 'left' | 'right';
  anchorY: 'top' | 'bottom';
}

export interface AdBlock {
  id: string;
  type: 'banner' | 'square' | 'video';
  position: AdPosition;
  size: { width: number; height: number };
  minimized: boolean;
  zIndex: number;
  content: {
    imageUrl: string;
    title: string;
  };
  rotationCount?: number; // Track how many times the ad has rotated
  currentAdIndex?: number; // Current ad in rotation
  lastRotation?: number; // Timestamp of last rotation
}

export interface AdLayerState {
  blocks: AdBlock[];
  isEditMode: boolean;
  showGrid: boolean;
  isPanelOpen: boolean;
  lastSaved: string;
}

export const AD_SIZES = {
  banner: { width: 728, height: 90 },
  square: { width: 300, height: 250 },
  video: { width: 400, height: 225 },
} as const;

export const GRID_SIZE = 10;
export const MAX_AD_BLOCKS = 5;
export const MIN_AD_BLOCKS = 2;
export const MAGNETIC_EDGE_THRESHOLD = 0.05; // 5% from edge
export const SAFE_ZONE_MIN = 0.02; // 2% from edge minimum
export const SAFE_ZONE_MAX = 0.98; // 98% from edge maximum

export const BREAKPOINTS = {
  mobile: 768,
  tablet: 1200,
} as const;