import React from 'react';
import { GRID_SIZE } from './types';

export const GridOverlay: React.FC = () => {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[999]"
      style={{
        backgroundImage: `
          repeating-linear-gradient(
            0deg,
            transparent,
            transparent ${GRID_SIZE - 1}px,
            rgba(59, 130, 246, 0.1) ${GRID_SIZE - 1}px,
            rgba(59, 130, 246, 0.1) ${GRID_SIZE}px
          ),
          repeating-linear-gradient(
            90deg,
            transparent,
            transparent ${GRID_SIZE - 1}px,
            rgba(59, 130, 246, 0.1) ${GRID_SIZE - 1}px,
            rgba(59, 130, 246, 0.1) ${GRID_SIZE}px
          )
        `,
      }}
    />
  );
};