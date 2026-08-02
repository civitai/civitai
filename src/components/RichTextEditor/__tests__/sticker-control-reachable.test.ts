import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// `includeControls={[... 'sticker']}` only puts the control in the toolbar, and
// three of the four comment editors pass `hideToolbar`. The control existed in
// source and rendered nowhere on image details, articles and posts — grepping
// includeControls said it was wired, and it wasn't. Any editor that asks for the
// sticker control while hiding its toolbar has to mount the picker itself.
const SRC = path.resolve(__dirname, '../../..');

function walk(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('the sticker control is reachable wherever it is requested', () => {
  const editors = walk(SRC)
    .map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }))
    .filter(({ source }) => /includeControls=\{\[[^\]]*'sticker'/.test(source));

  it('finds the editors that request it', () => {
    expect(editors.length).toBeGreaterThan(0);
  });

  it('mounts the picker directly wherever the toolbar is hidden', () => {
    // File-level rather than per-editor: a file with several editors is flagged
    // if any of them hides the toolbar. Coarse in the safe direction.
    const unreachable = editors
      // The open tag, not the bare identifier: the realistic regression is
      // deleting the JSX and leaving the import behind, which the identifier
      // check would happily accept.
      .filter(({ source }) => source.includes('hideToolbar') && !source.includes('<StickerPicker'))
      .map(({ file }) => path.relative(SRC, file).split(path.sep).join('/'));

    expect(unreachable).toEqual([]);
  });
});
