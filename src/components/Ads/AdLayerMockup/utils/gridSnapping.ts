import { GRID_SIZE } from '../types';

export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

export function snapPosition(x: number, y: number): { x: number; y: number } {
  return {
    x: snapToGrid(x),
    y: snapToGrid(y),
  };
}