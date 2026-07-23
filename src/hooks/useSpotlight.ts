import { useCallback, useRef } from 'react';

// Cursor-following spotlight glow. Wire the returned handlers onto the surface
// and render a `pointer-events-none absolute inset-0 transition-opacity
// duration-500` div carrying `spotlightRef`. Written via refs to avoid
// re-rendering on every mouse move.
export function useSpotlight(opts?: { size?: number; color?: string }) {
  const size = opts?.size ?? 400;
  const color = opts?.color ?? 'light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05))';
  const spotlightRef = useRef<HTMLDivElement>(null);
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = spotlightRef.current;
      if (!el) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      el.style.background = `radial-gradient(${size}px circle at ${x}px ${y}px, ${color}, transparent 70%)`;
      el.style.opacity = '1';
    },
    [size, color]
  );
  const handleMouseLeave = useCallback(() => {
    const el = spotlightRef.current;
    if (el) el.style.opacity = '0';
  }, []);
  return { spotlightRef, handleMouseMove, handleMouseLeave };
}
