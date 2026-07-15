import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';

import {
  MAX_OPTIONS_PER_LIST,
  MAX_OPTION_CHARS,
  flattenYamlLists,
  normalizeListKey,
  parsePackFile,
} from '~/server/services/blocks/wildcard-pack.service';

/**
 * Pure parse coverage for wildcard-pack.service (no db / storage / redis):
 * the txt + yaml + zip shapes surveyed in WILDCARD_PACK_SPEC and the caps'
 * truncate-not-reject posture.
 */

async function zipOf(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('normalizeListKey', () => {
  it('drops the extension, lowercases, dashes spaces, strips {}|', () => {
    expect(normalizeListKey('Fantasy Race.txt')).toBe('fantasy-race');
    expect(normalizeListKey('outfit/Heavy Armor.yaml')).toBe('outfit/heavy-armor');
    expect(normalizeListKey('we{ir}d|.txt')).toBe('weird');
  });
});

describe('parsePackFile — zip of txt', () => {
  it('one option per line; comments, blanks, and \\r stripped; deduped', async () => {
    const bytes = await zipOf({
      'race.txt': '# fantasy races\nelf\r\ndwarf\n\nelf\n  orc  \n',
    });
    const pack = await parsePackFile(bytes, 'pack.zip');
    expect(pack.lists).toEqual({ race: ['elf', 'dwarf', 'orc'] });
    expect(pack.truncated).toBe(false);
    expect(pack.truncatedLists).toEqual([]);
  });

  it('nested paths keep their path shape in the key', async () => {
    const bytes = await zipOf({ 'Outfit/Heavy Armor.txt': 'plate\nchain' });
    const pack = await parsePackFile(bytes, 'pack.zip');
    expect(Object.keys(pack.lists)).toEqual(['outfit/heavy-armor']);
  });

  it('skips directories, dotfiles, previews, and nested zips without error', async () => {
    const zip = new JSZip();
    zip.folder('previews');
    zip.file('previews/card.jpg', Buffer.from([0xff, 0xd8, 0xff]));
    zip.file('.hidden.txt', 'nope');
    zip.file('inner.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    zip.file('real.txt', 'yes');
    const pack = await parsePackFile(await zip.generateAsync({ type: 'nodebuffer' }), 'pack.zip');
    expect(pack.lists).toEqual({ real: ['yes'] });
  });

  it('an images-only zip -> empty lists (200-shaped result, not an error)', async () => {
    const bytes = await zipOf({ 'cover.jpg': 'not really an image' });
    const pack = await parsePackFile(bytes, 'pack.zip');
    expect(pack.lists).toEqual({});
    expect(pack.truncated).toBe(false);
  });
});

describe('parsePackFile — caps (truncate, never reject)', () => {
  it('caps options per list and flags the list', async () => {
    const lines = Array.from({ length: MAX_OPTIONS_PER_LIST + 50 }, (_, i) => `opt-${i}`);
    const bytes = await zipOf({ 'huge.txt': lines.join('\n') });
    const pack = await parsePackFile(bytes, 'pack.zip');
    expect(pack.lists.huge).toHaveLength(MAX_OPTIONS_PER_LIST);
    expect(pack.truncated).toBe(true);
    expect(pack.truncatedLists).toEqual(['huge']);
  });

  it('caps option length', async () => {
    const bytes = await zipOf({ 'long.txt': 'x'.repeat(MAX_OPTION_CHARS + 100) });
    const pack = await parsePackFile(bytes, 'pack.zip');
    expect(pack.lists.long[0]).toHaveLength(MAX_OPTION_CHARS);
    expect(pack.truncatedLists).toEqual(['long']);
  });
});

describe('parsePackFile — yaml', () => {
  it('flattens nested maps of string arrays into parent/child keys', async () => {
    const doc = ['outfit:', '  armor:', '    - plate', '    - chain', 'race:', '  - elf'].join(
      '\n'
    );
    const bytes = await zipOf({ 'wildcards.yaml': doc });
    const pack = await parsePackFile(bytes, 'pack.zip');
    expect(pack.lists['wildcards/outfit/armor']).toEqual(['plate', 'chain']);
    expect(pack.lists['wildcards/race']).toEqual(['elf']);
  });

  it('ignores non-string leaves and malformed yaml without failing the pack', async () => {
    const bytes = await zipOf({
      'ok.yaml': 'nums:\n  - 1\n  - 2\nwords:\n  - hi',
      'broken.yaml': ':\n  - [unclosed',
      'also.txt': 'still-here',
    });
    const pack = await parsePackFile(bytes, 'pack.zip');
    expect(pack.lists['ok/words']).toEqual(['hi']);
    expect(pack.lists['ok/nums']).toBeUndefined();
    expect(pack.lists.also).toEqual(['still-here']);
  });
});

describe('parsePackFile — bare (non-zip) primary file', () => {
  it('a bare .txt parses as a single-list pack keyed by its name', async () => {
    const pack = await parsePackFile(Buffer.from('elf\ndwarf\n# c\n'), 'Fantasy Races.txt');
    expect(pack.lists).toEqual({ 'fantasy-races': ['elf', 'dwarf'] });
  });

  it('a bare .yaml parses with the file name as the key prefix', async () => {
    const pack = await parsePackFile(Buffer.from('race:\n  - elf'), 'w.yaml');
    expect(pack.lists['w/race']).toEqual(['elf']);
  });
});

describe('flattenYamlLists', () => {
  it('is safe on garbage', () => {
    const out: Array<{ key: string; options: string[] }> = [];
    flattenYamlLists(null, '', out);
    flattenYamlLists('string', '', out);
    flattenYamlLists(42, 'x', out);
    expect(out).toEqual([]);
  });
});
