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
    // Every mount gated, not merely one — a second ungated mount beside the
    // gated one would satisfy an existence check. The optional paren allows
    // prettier to wrap the line when a prop pushes it past printWidth, which
    // would otherwise turn a formatting change into a failed gate.
    const mountCount = (source.match(/<StickerAttributionHoverCard/g) ?? []).length;
    // `[^<]*` allows further conditions and prettier's wrapping between the gate
    // and the mount, while still refusing any mount that no `allowStickers` in
    // the same expression reaches — an intervening tag ends the match.
    const gatedCount = (source.match(/allowStickers &&[^<]*<StickerAttributionHoverCard/g) ?? [])
      .length;
    expect(mountCount, 'mounts of the attribution card in RenderHtml').toBe(1);
    expect(gatedCount, 'those mounts sitting behind the allowStickers gate').toBe(mountCount);
  });

  it('🔴 the shared inline sticker component carries NO card — that is what keeps it out of DMs', () => {
    // `Sticker.tsx` is what chat renders. A card reached from here is a card in
    // a private message.
    //
    // Read by fixed path rather than by glob: a rename or move throws instead of
    // quietly matching nothing.
    const shared = fs.readFileSync(path.join(SRC, 'components/Sticker/Sticker.tsx'), 'utf8');

    // Two assertions, because they fail for different reasons and the first is
    // not enough. Forbidding component names forbids three spellings of one
    // implementation — a Tooltip whose label holds an Anchor to the shop is a
    // shop link in a DM and matches none of them. The data is the property: any
    // route to a shop needs a username or an href, and the only server source of
    // either is `getStickerAttribution`. `Sticker.tsx`'s own data is
    // `{url, slug, animated}`.
    expect(shared).not.toMatch(/getStickerAttribution|shopHref|creatorName/);
    expect(shared).not.toMatch(/HoverCard|Popover|StickerAttribution/);

    // Every chat surface, not one file: `ChatWindow` picks between `ExistingChat`
    // and `ExistingChatV1` behind a flag, and both render stickers. The filename
    // is prefixed into the subject so a failure names the file rather than
    // dumping it.
    const chatFiles = walk(path.join(SRC, 'components/Chat'), [], ['.ts', '.tsx']);
    expect(chatFiles.length, 'chat files scanned').toBeGreaterThan(3);
    for (const file of chatFiles) {
      expect(`${relative(file)}: ${fs.readFileSync(file, 'utf8')}`).not.toMatch(
        /StickerAttribution|getStickerAttribution|shopHref/
      );
    }
  });
});
