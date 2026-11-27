import { describe, expect, it } from 'vitest';
import { runCue } from './question-run';

describe('runCue', () => {
  it('opens a run of questions with Question time, whether ratings came before or the visit starts on a question', () => {
    expect(runCue(false, true)).toBe('question-time');
    expect(runCue(null, true)).toBe('question-time');
  });

  it('shows nothing between two questions of the same run', () => {
    expect(runCue(true, true)).toBeNull();
  });

  it('marks the first rating after a run with Questions done, and nothing between ratings', () => {
    expect(runCue(true, false)).toBe('questions-done');
    expect(runCue(false, false)).toBeNull();
    expect(runCue(null, false)).toBeNull();
  });
});
