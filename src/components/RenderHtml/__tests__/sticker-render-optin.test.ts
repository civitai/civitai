import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// Stickers are paid, and roughly thirty rich-text surfaces render through
// RenderHtml — several of which store user HTML without sanitizing it. Rather
// than keep that write-side list exhaustive (it was incomplete four times),
// containment lives here: RenderHtml refuses to draw a sticker unless the call
// site opts in, so a surface added later fails closed.
const SRC = path.resolve(__dirname, '../../..');

const OPTED_IN = [
  'components/CommentsV2/Comment/Comment.tsx',
  'components/CommentSection/CommentSectionItem.tsx',
  'components/Model/Discussion/CommentThreadModal.tsx',
  'components/Model/ModelDiscussion/CommentDiscussionItem.tsx',
];

// Tiptap keeps a parallel renderer to RenderHtml, and registering the sticker
// node there let a crafted article `contentJson` draw one with no opt-in at all.
// Only the editor may register it — where the node exists so a sticker survives
// an edit round-trip, not so it gets drawn.
const MAY_REGISTER_STICKER_NODE = [
  'components/RichTextEditor/RichTextEditorComponent.tsx',
  'components/TipTap/StickerNode.tsx',
  'shared/tiptap/sticker.node.ts',
];

function walk(dir: string, out: string[] = [], ext = ['.tsx']) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, ext);
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const relative = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

describe('sticker rendering is opt-in', () => {
  const files = walk(SRC).filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return source.includes('<RenderHtml');
  });

  it('finds the RenderHtml call sites', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('is granted only at the comment call sites', () => {
    const granted = files
      .filter((file) => fs.readFileSync(file, 'utf8').includes('allowStickers'))
      .map(relative)
      .sort();

    expect(granted).toEqual([...OPTED_IN].sort());
  });

  it('defaults to denying', () => {
    const source = fs.readFileSync(path.join(SRC, 'components/RenderHtml/RenderHtml.tsx'), 'utf8');
    expect(source).toContain('allowStickers = false');
  });

  it('is not reachable through a second renderer', () => {
    const registers = walk(SRC, [], ['.ts', '.tsx'])
      .filter((file) => /StickerNode|StickerEditNode/.test(fs.readFileSync(file, 'utf8')))
      .map(relative)
      .filter((file) => !file.startsWith('components/RenderHtml/__tests__/'))
      .sort();

    expect(registers).toEqual([...MAY_REGISTER_STICKER_NODE].sort());
  });
});
