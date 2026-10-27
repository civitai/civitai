import { describe, expect, it } from 'vitest';
import { liftToContrastOnBlack } from '~/utils/contrast-floor';

describe('liftToContrastOnBlack', () => {
  it.each([
    ['#7b2fe0', '#9354e6'],
    ['#b31a1a', '#c55050'],
    ['#3e43ff', '#5d61ff'],
  ])('lifts %s just enough to %s', (color, lifted) => {
    expect(liftToContrastOnBlack(color)).toBe(lifted);
  });

  it.each(['#e58cff', '#b142ff', '#FD7E14', 'blue.4', 'white'])('leaves %s alone', (color) => {
    expect(liftToContrastOnBlack(color)).toBe(color);
  });
});
