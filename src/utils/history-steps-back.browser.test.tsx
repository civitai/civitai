import { describe, expect, test } from 'vitest';
import { historyStepsBackPast } from '~/utils/history-layers';

// Marked by a query flag rather than a path, so the test page's own URL stays put.
const inRun = (url: URL) => url.searchParams.has('run');

describe('historyStepsBackPast', () => {
  test('counts back past every entry of the run, to the page before it', () => {
    history.pushState(null, '', '?run=page');
    history.pushState(null, '', '?run=dialog-leftover');
    history.pushState(null, '', '?run=layer');

    expect(historyStepsBackPast(inRun)).toBe(3);
  });
});
