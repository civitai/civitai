import { describe, expect, it } from 'vitest';
import {
  APP_BLOCK_TAG_REFUSED_MESSAGE,
  CALLER_TAGS_SHAPE_MESSAGE,
  callerTagsRefusal,
} from '~/shared/utils/app-block-tags';

// Decision (civitai/civitai#10435): only an App Blocks submit puts an app-block tag on a workflow,
// so caller tags carrying one are refused, as are tags that are not a list of strings.
describe('callerTagsRefusal', () => {
  it.each([
    'app-block:my-app',
    'App-Block:my-app',
    '  app-block:my-app',
    'app-block',
    ' App-Block ',
  ])('🔴 refuses %j', (tag) => {
    expect(callerTagsRefusal(['favorite', tag])).toBe(APP_BLOCK_TAG_REFUSED_MESSAGE);
  });

  it.each([['app-block:my-app'], [['favorite', 7]], [{ 0: 'app-block:x' }]])(
    '🔴 refuses tags that are not a list of strings: %j',
    (tags) => {
      expect(callerTagsRefusal(tags)).toBe(CALLER_TAGS_SHAPE_MESSAGE);
    }
  );

  it('POSITIVE CONTROL: no tags and ordinary tags are allowed', () => {
    expect(callerTagsRefusal(undefined)).toBeNull();
    expect(callerTagsRefusal(null)).toBeNull();
    expect(callerTagsRefusal([])).toBeNull();
    expect(callerTagsRefusal(['favorite', 'my-app-block:x', 'feedback:liked'])).toBeNull();
  });
});
