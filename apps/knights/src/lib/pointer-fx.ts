const FINE_POINTER = '(hover: hover) and (pointer: fine)';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Pointer effects are for a mouse and for players who have not asked for less motion: never touch, never reduced motion. */
export const effectsAllowed = () =>
  typeof matchMedia === 'function' &&
  matchMedia(FINE_POINTER).matches &&
  !matchMedia(REDUCED_MOTION).matches;

const clamp = (value: number) => Math.max(-1, Math.min(1, value));

/** Where a point sits in a box, from -1 (left/top edge) to 1 (right/bottom edge), 0 at the centre. */
export function pointerOffset(
  x: number,
  y: number,
  box: { left: number; top: number; width: number; height: number }
) {
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp(((x - box.left) / box.width) * 2 - 1),
    y: clamp(((y - box.top) / box.height) * 2 - 1),
  };
}

/** Keeps `--mx`/`--my` at the pointer's position inside the element. Bounds are read in the same frame as the write, so nothing forces a layout. */
export function glow(node: HTMLElement) {
  let frame = 0;
  let clientX = 0;
  let clientY = 0;
  const paint = () => {
    frame = 0;
    const box = node.getBoundingClientRect();
    node.style.setProperty('--mx', `${(clientX - box.left).toFixed(1)}px`);
    node.style.setProperty('--my', `${(clientY - box.top).toFixed(1)}px`);
  };
  const move = (event: PointerEvent) => {
    if (!effectsAllowed()) return;
    clientX = event.clientX;
    clientY = event.clientY;
    if (!frame) frame = requestAnimationFrame(paint);
  };
  node.addEventListener('pointermove', move, { passive: true });
  return {
    destroy() {
      node.removeEventListener('pointermove', move);
      cancelAnimationFrame(frame);
    },
  };
}

const SETTLED = 0.001;
const EASE = 0.08;

/** Shifts each `[data-depth]` child against the pointer by up to `depth` px. Writes only `transform`, and only while a frame is still moving. */
export function parallax(node: HTMLElement) {
  const layers = [...node.querySelectorAll<HTMLElement>('[data-depth]')].map((el) => ({
    el,
    depth: Number(el.dataset.depth) || 0,
  }));
  let targetX = 0;
  let targetY = 0;
  let x = 0;
  let y = 0;
  let frame = 0;

  const tick = () => {
    x += (targetX - x) * EASE;
    y += (targetY - y) * EASE;
    for (const { el, depth } of layers) {
      el.style.transform = `translate3d(${(-x * depth).toFixed(2)}px, ${(-y * depth).toFixed(
        2
      )}px, 0)`;
    }
    const moving = Math.abs(targetX - x) > SETTLED || Math.abs(targetY - y) > SETTLED;
    frame = moving ? requestAnimationFrame(tick) : 0;
  };
  const kick = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const rest = () => {
    targetX = 0;
    targetY = 0;
    kick();
  };
  const move = (event: PointerEvent) => {
    if (!effectsAllowed()) {
      if (targetX || targetY) rest();
      return;
    }
    ({ x: targetX, y: targetY } = pointerOffset(event.clientX, event.clientY, {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    kick();
  };

  window.addEventListener('pointermove', move, { passive: true });
  document.documentElement.addEventListener('pointerleave', rest);
  return {
    destroy() {
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', rest);
      cancelAnimationFrame(frame);
    },
  };
}
