import { existsSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  controlNetToPreprocessVideoKind,
  getControlNetPreprocessorExamples,
  videoControlNetPreprocessors,
} from '../controlnets.constants';

const PUBLIC_DIR = path.resolve(__dirname, '../../../../public');

/**
 * The preview card drops any example whose image 404s, so a missing asset shows
 * as an empty card rather than an error — the preview would quietly disappear
 * with nothing failing. These assert the file is actually on disk.
 */
describe('video ControlNet preprocessor examples', () => {
  it.each(videoControlNetPreprocessors)('%s resolves at least one example', (key) => {
    expect(getControlNetPreprocessorExamples(key).length).toBeGreaterThan(0);
  });

  it.each(videoControlNetPreprocessors)('%s example files exist in public/', (key) => {
    for (const example of getControlNetPreprocessorExamples(key)) {
      for (const url of [example.input, example.output]) {
        expect(existsSync(path.join(PUBLIC_DIR, url)), `missing asset: ${url}`).toBe(true);
      }
    }
  });

  it('maps every video preprocessor to a kind that has examples', () => {
    for (const key of videoControlNetPreprocessors) {
      expect(controlNetToPreprocessVideoKind[key], `no kind for ${key}`).toBeTruthy();
    }
  });
});
