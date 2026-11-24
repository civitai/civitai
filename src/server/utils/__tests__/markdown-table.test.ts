import { generateHTML } from '@tiptap/html/server';
import { describe, expect, it } from 'vitest';
import { markdownForEditor } from '~/components/RichTextEditor/markdown-for-editor';
import { upsertArticleInput } from '~/server/schema/article.schema';
import {
  modelVersionUpsertSchema,
  modelVersionUpsertSchema2,
} from '~/server/schema/model-version.schema';
import { modelSchema, modelUpsertSchema } from '~/server/schema/model.schema';
import { upsertModel3DSchema } from '~/server/schema/model3d.schema';
import { articleContentJson } from '~/server/utils/article-content-json';
import { tiptapExtensions } from '~/shared/tiptap/extensions';

const table = [
  '| Model | Steps |',
  '| :--- | ---: |',
  '| **A\\|B** | `24` |',
  '| C | ~~old~~ |',
].join('\n');

describe('Markdown tables in author content', () => {
  it.each([
    ['model', modelUpsertSchema.shape.description],
    ['alternate listing', modelUpsertSchema.shape.sfwDescription],
    ['model schema', modelSchema.shape.description],
    ['version', modelVersionUpsertSchema2.shape.description],
    ['legacy version', modelVersionUpsertSchema.shape.description],
    ['3D model', upsertModel3DSchema.shape.description],
    ['article', upsertArticleInput.shape.content],
  ] as const)('keeps a table editable after saving a %s', (_, field) => {
    const doc = articleContentJson(markdownForEditor(table));
    const saved = field.parse(generateHTML(doc, tiptapExtensions));
    expect(saved).toContain('<table>');
    expect(saved).toContain('scope="col"');
    expect(saved).toContain('<strong>A|B</strong>');
    expect(saved).toContain('<code>24</code>');
    expect(saved).toContain('<s>old</s>');
    const reopened = articleContentJson(saved!);
    expect(reopened).toEqual(doc);
    expect(reopened.content[0]).toMatchObject({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', attrs: { align: 'left' } },
            { type: 'tableHeader', attrs: { align: 'right' } },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', attrs: { align: 'left' } },
            { type: 'tableCell', attrs: { align: 'right' } },
          ],
        },
        { type: 'tableRow' },
      ],
    });
  });

  it('imports surrounding formatting and leaves fenced table examples as code', () => {
    const html = markdownForEditor(
      ['## Settings', '', '- *Example*', '', '```', table, '```'].join('\n')
    );
    expect(html).toContain('<h2>Settings</h2>');
    expect(html).toContain('<li><em>Example</em></li>');
    expect(html).toContain('<pre><code>| Model | Steps |');
    expect(html).not.toContain('<table>');
  });
});
