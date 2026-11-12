// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showPointPop } from '~/components/HatTurf/PointPop';

// A pop is centred on the button pressed, but never cut off by the edge of the screen.
const pop = () => document.querySelector<HTMLElement>('[data-testid="event-point-pop"]');

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
  vi.stubGlobal('innerWidth', 390);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pop()?.remove();
});

describe('showPointPop', () => {
  it('centres on the point it rises from', () => {
    showPointPop({ points: 5, team: 'Yellow' }, { x: 200, y: 300 });
    expect(pop()!.style.left).toBe('200px');
    expect(pop()!.textContent).toBe('+5 Yellow points');
  });

  it('keeps a pop by the left or right edge on screen', () => {
    showPointPop({ points: 5, team: 'Yellow' }, { x: 20, y: 300 });
    expect(pop()!.style.left).toBe('58px');
    pop()!.remove();
    showPointPop({ points: 5, team: 'Yellow' }, { x: 380, y: 300 });
    expect(pop()!.style.left).toBe('332px');
  });

  it('shows nothing for 0 points', () => {
    showPointPop({ points: 0, team: 'Yellow' }, { x: 200, y: 300 });
    expect(pop()).toBeNull();
  });
});
