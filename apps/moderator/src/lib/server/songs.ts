import { dbRead } from './db';

/** Which of `ids` are songs (`Image` rows of type audio). */
export async function songIds(ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await dbRead
    .selectFrom('Image')
    .select('id')
    .where('id', 'in', ids)
    .where('type', '=', 'audio')
    .execute();
  return rows.map((r) => r.id);
}

export const isSong = async (id: number) => (await songIds([id])).length > 0;
