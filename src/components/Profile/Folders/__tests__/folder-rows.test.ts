import { describe, expect, it } from 'vitest';
import { rowsWithFolderToggled } from '~/components/Profile/Folders/folder-rows';
import type { ProfileFolderRow } from '~/server/services/profile-folders.service';

const folder = (id: number, hidden = false) =>
  ({
    id,
    name: `f${id}`,
    description: null,
    read: 'Public',
    hidden,
    counts: {},
    preview: [],
  } as never);

const rows: ProfileFolderRow[] = [
  { id: 'r1', name: 'Styles', folders: [folder(10), folder(11, true)] },
  { id: null, name: '', folders: [folder(12)] },
];

describe('rowsWithFolderToggled', () => {
  it('hides only the folder that was switched, leaving the others as they were', () => {
    expect(rowsWithFolderToggled(rows, { id: 10, hidden: false })).toEqual([
      {
        id: 'r1',
        name: 'Styles',
        folders: [
          { id: 10, hidden: true },
          { id: 11, hidden: true },
        ],
      },
      { id: 'top1', name: '', folders: [{ id: 12 }] },
    ]);
  });

  it('shows a hidden folder again', () => {
    expect(rowsWithFolderToggled(rows, { id: 11, hidden: true })[0].folders).toEqual([
      { id: 10 },
      { id: 11 },
    ]);
  });
});
