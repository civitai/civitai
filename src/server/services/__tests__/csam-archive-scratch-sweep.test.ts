import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepArchiveScratchDirs } from '~/server/services/csam.service-new';

/** The archive job's start-of-run sweep of what a pass that died left on disk. Ids are invented. */

const SEND = '11111111-1111-4111-8111-111111111111';

let root: string;
const dir = (scratch: string, name: string) => path.join(root, scratch, name);
const make = (scratch: string, name: string) => {
  fs.mkdirSync(path.join(dir(scratch, name), 'spool'), { recursive: true });
  fs.writeFileSync(path.join(dir(scratch, name), 'spool', 'part'), 'x');
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'csam-archive-sweep-'));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('sweepArchiveScratchDirs', () => {
  it('removes every archive directory, files and all', async () => {
    make('base', '1');
    make('images', '2');
    make('generated-images', '3');
    make('training-data', '4');

    const removed = await sweepArchiveScratchDirs(root);

    const swept = [
      ['base', '1'],
      ['images', '2'],
      ['generated-images', '3'],
      ['training-data', '4'],
    ];
    expect(removed.sort()).toEqual(swept.map(([scratch, name]) => dir(scratch, name)).sort());
    for (const [scratch, name] of swept) expect(fs.existsSync(dir(scratch, name))).toBe(false);
  });

  it('leaves send directories and anything not named by a report id', async () => {
    make('training-data', `4-${SEND}`);
    make('generated-send', '5');
    make('images', 'notes');

    expect(await sweepArchiveScratchDirs(root)).toEqual([]);
    expect(fs.existsSync(dir('training-data', `4-${SEND}`))).toBe(true);
    expect(fs.existsSync(dir('generated-send', '5'))).toBe(true);
    expect(fs.existsSync(dir('images', 'notes'))).toBe(true);
  });

  it('throws when a root cannot be read, so the job logs it', async () => {
    fs.writeFileSync(path.join(root, 'images'), 'not a directory');

    await expect(sweepArchiveScratchDirs(root)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('does nothing when no pass has ever run', async () => {
    expect(await sweepArchiveScratchDirs(path.join(root, 'absent'))).toEqual([]);
  });
});
