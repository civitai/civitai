import { describe, expect, test } from 'vitest';
import {
  STORYLINE_TEXT_CONTROLS,
  STORYLINE_TEXT_HEADING_LEVELS,
} from '~/components/Storyline/editor/storyline-text.utils';
import { setStorylineTextSchema } from '~/server/schema/storyline.schema';

const saved = (content: string) => setStorylineTextSchema.parse({ id: 1, content }).content;

// The text card's toolbar offers only what `setText` keeps: a control whose markup the save
// strips would promise something it cannot keep.
describe('storyline text toolbar vs the setText sanitizer', () => {
  test('a mention keeps the markup that makes it a mention, so mentions are on', () => {
    const html = saved(
      '<p>Hi <span data-type="mention" data-id="5" data-label="bob" class="mention">@bob</span></p>'
    );
    expect(html).toContain('data-type="mention"');
    expect(html).toContain('data-id="5"');
    expect(STORYLINE_TEXT_CONTROLS).toContain('mentions');
  });

  test('h2, h3 and lists survive and h1 does not, so heading offers 2 and 3, and lists are on', () => {
    const html = saved(
      '<h1>Big</h1><h2>Title</h2><h3>Sub</h3><ul><li>one</li></ul><ol><li>two</li></ol>'
    );
    expect(html).not.toContain('<h1');
    expect(html).toContain('<h2>Title</h2><h3>Sub</h3><ul><li>one</li></ul><ol><li>two</li></ol>');
    expect(STORYLINE_TEXT_CONTROLS).toContain('heading');
    expect(STORYLINE_TEXT_CONTROLS).toContain('list');
    expect(STORYLINE_TEXT_HEADING_LEVELS).toEqual([2, 3]);
  });

  test('formatting and links survive, so those controls are on', () => {
    const html = saved('<p><strong>b</strong> <em>i</em> <a href="https://civitai.com">l</a></p>');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<em>i</em>');
    expect(html).toContain('href="https://civitai.com"');
    expect(STORYLINE_TEXT_CONTROLS).toEqual(expect.arrayContaining(['formatting', 'link']));
  });
});
