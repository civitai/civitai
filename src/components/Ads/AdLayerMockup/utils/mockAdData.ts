import { AdBlock, AD_SIZES } from '../types';
import { getDefaultPosition } from './positionUtils';

const AD_TITLES = {
  banner: ['Special Offer', 'New Product Launch', 'Limited Time Deal', 'Exclusive Access'],
  square: ['Featured Item', 'Trending Now', 'Hot Deal', 'Popular Choice'],
  video: ['Watch Now', 'Video Ad', 'Featured Content', 'Stream Today'],
};

const AD_COLORS = ['FF6B6B', '4ECDC4', '45B7D1', 'F7DC6F', '82E0AA', 'BB8FCE'];

export function generateMockAd(type: AdBlock['type'], index: number): Omit<AdBlock, 'position'> {
  const size = AD_SIZES[type];
  const titles = AD_TITLES[type];
  const title = titles[index % titles.length];
  const color = AD_COLORS[index % AD_COLORS.length];
  
  return {
    id: `ad-${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type,
    size,
    minimized: false,
    zIndex: 1000 + index,
    content: {
      imageUrl: `https://placehold.co/${size.width}x${size.height}/${color}/FFFFFF?text=${encodeURIComponent(title)}`,
      title,
    },
  };
}

export function generateMockAdContent(type: AdBlock['type'], index: number): AdBlock['content'] {
  const size = AD_SIZES[type];
  const titles = AD_TITLES[type];
  const title = titles[index % titles.length];
  const color = AD_COLORS[index % AD_COLORS.length];
  
  return {
    imageUrl: `https://placehold.co/${size.width}x${size.height}/${color}/FFFFFF?text=${encodeURIComponent(title)}`,
    title,
  };
}

export function getDefaultAdLayout(): AdBlock[] {
  const banner = generateMockAd('banner', 0);
  const square = generateMockAd('square', 1);
  
  return [
    {
      ...banner,
      position: getDefaultPosition(0, banner.size),
      rotationCount: 0,
      currentAdIndex: 0,
    },
    {
      ...square,
      position: getDefaultPosition(1, square.size),
      rotationCount: 0,
      currentAdIndex: 0,
    },
  ];
}