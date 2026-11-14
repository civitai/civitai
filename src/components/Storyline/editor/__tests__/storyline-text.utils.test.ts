import { describe, expect, test } from 'vitest';
import { STORYLINE_TEXT_CONTROLS } from '~/components/Storyline/editor/storyline-text.utils';
import { setStorylineTextSchema } from '~/server/schema/storyline.schema';

const saved = (content: string) => setStorylineTextSchema.parse({ id: 1, content }).content;

// The text card's toolbar offers only what `setText` keeps. When the sanitizer starts keeping
// headings or lists, this fails, and those controls can go back on.
describe('storyline text toolbar vs the setText sanitizer', () => {
  test('a mention keeps the markup that makes it a mention, so mentions are on', () => {
    const html = saved(
      '<p>Hi <span data-type="mention" data-id="5" data-label="bob" class="mention">@bob</span></p>'
    );
    expect(html).toContain('data-type="mention"');
    expect(html).toContain('data-id="5"');
    expect(STORYLINE_TEXT_CONTROLS).toContain('mentions');
  });

  test('headings and lists are stripped, so those controls stay off', () => {
    const html = saved('<h2>Title</h2><ul><li>one</li></ul>');
    expect(html).not.toMatch(/<h2|<ul|<li/);
    expect(STORYLINE_TEXT_CONTROLS).not.toContain('heading');
    expect(STORYLINE_TEXT_CONTROLS).not.toContain('list');
  });

  test('formatting and links survive, so those controls are on', () => {
    const html = saved('<p><strong>b</strong> <em>i</em> <a href="https://civitai.com">l</a></p>');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<em>i</em>');
    expect(html).toContain('href="https://civitai.com"');
    expect(STORYLINE_TEXT_CONTROLS).toEqual(expect.arrayContaining(['formatting', 'link']));
  });
});
