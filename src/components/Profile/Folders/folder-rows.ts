import type { FolderRowSchema } from '~/server/schema/profile-folders.schema';
import type { ProfileFolderRow } from '~/server/services/profile-folders.service';

/**
 * The rows as shown with one folder's visibility flipped, in the shape `setRows` saves. A row
 * with no id (the trailing untitled row of unplaced folders) is saved as a row of its own.
 */
export function rowsWithFolderToggled(
  rows: ProfileFolderRow[],
  folder: { id: number; hidden: boolean }
): FolderRowSchema[] {
  return rows.map((row, i) => ({
    id: row.id ?? `top${i}`,
    name: row.name,
    folders: row.folders.map((f) => {
      const hidden = f.id === folder.id ? !folder.hidden : f.hidden;
      return hidden ? { id: f.id, hidden: true } : { id: f.id };
    }),
  }));
}
