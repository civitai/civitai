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
      // Tests don't ship, and both the guard itself and the editor's own browser
      // tests have to name the node to assert on it.
      .filter((file) => !file.includes('/__tests__/'))
      .sort();

    expect(registers).toEqual([...MAY_REGISTER_STICKER_NODE].sort());
  });

  /**
   * The attribution card is the same containment question one step on: it turns
   * a drawn sticker into a route to its creator's shop.
   *
   * Justin's call was comments now, DMs a separate decision — a card in a DM
   * makes any sticker a stranger sends you a shop link, with no message text to
   * report. `Sticker.tsx` is shared with chat, so mounting the card there would
   * have shipped that decision by accident. It lives in `RenderHtml` behind the
   * same opt-in as drawing the sticker at all.
   */
  it('the attribution card is mounted only by RenderHtml, and only behind the opt-in', () => {
    const mounts = walk(SRC, [], ['.ts', '.tsx'])
      .filter((file) => /<StickerAttributionHoverCard/.test(fs.readFileSync(file, 'utf8')))
      .map(relative)
      .filter((file) => !file.includes('/__tests__/'))
      .sort();

    expect(mounts).toEqual(['components/RenderHtml/RenderHtml.tsx']);

    const source = fs.readFileSync(path.join(SRC, 'components/RenderHtml/RenderHtml.tsx'), 'utf8');
    expect(source).toMatch(/allowStickers && <StickerAttributionHoverCard/);
  });

  it('🔴 the shared inline sticker component carries NO card — that is what keeps it out of DMs', () => {
    // `Sticker.tsx` is what chat renders. A card reached from here is a card in
    // a private message.
    const shared = fs.readFileSync(path.join(SRC, 'components/Sticker/Sticker.tsx'), 'utf8');
    expect(shared).not.toMatch(/HoverCard|Popover|StickerAttribution/);

    const chat = fs.readFileSync(path.join(SRC, 'components/Chat/ExistingChat.tsx'), 'utf8');
    expect(chat).not.toMatch(/StickerAttribution/);
  });
});
