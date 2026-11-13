import classes from './PointPop.module.css';

export type PointPop = { points: number; team: string; color?: string };

// "+N Team points", rising off a point on screen and then gone. Outside React on purpose: a pop outlives the
// button that caused it (a feed card scrolled away, a menu closed) and needs no state of its own.
export function showPointPop({ points, team, color }: PointPop, at: { x: number; y: number }) {
  if (typeof document === 'undefined' || points <= 0) return;
  const el = document.createElement('div');
  el.className = classes.pop;
  el.textContent = `+${points} ${team} points`;
  el.setAttribute('role', 'status');
  el.dataset.testid = 'event-point-pop';
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;
  if (color) el.style.color = color;
  el.addEventListener('animationend', () => el.remove());
  // A backstop for a tab hidden mid-animation, where animationend may never fire.
  setTimeout(() => el.remove(), 2000);
  document.body.appendChild(el);
  // Centred on the button, but kept on screen: a button by the edge of a phone would cut it off.
  const half = el.offsetWidth / 2;
  const margin = 8;
  const max = window.innerWidth - half - margin;
  el.style.left = `${Math.max(half + margin, Math.min(at.x, max))}px`;
}

/** The top centre of an element: where a pop off it starts. */
export const popAnchor = (el: Element) => {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top };
};
