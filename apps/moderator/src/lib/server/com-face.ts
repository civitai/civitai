import type { ComFace, ComFaceCover } from '$lib/com-face';
import type { MediaType } from '$lib/media/edge-url';
import { civitaiAppUrl } from './civitai-url';
import { dbRead } from './db';

export type ComFaceSource = { id: number; sfwName: string | null; sfwCoverImageId: number | null };

/**
 * Each model's civitai.com face, or null when `sfwName` is unset (the face is off). The covers are
 * read in one query for the whole page. The link uses the `.com` base, not the `.red` one every other
 * moderator link takes: the point is to show what civitai.com shows.
 */
export async function loadComFaces(models: ComFaceSource[]): Promise<Map<number, ComFace | null>> {
  const coverIds = [
    ...new Set(
      models.flatMap((m) =>
        m.sfwName != null && m.sfwCoverImageId != null ? [m.sfwCoverImageId] : []
      )
    ),
  ];
  const covers = new Map<number, ComFaceCover>();
  if (coverIds.length) {
    const found = await dbRead
      .selectFrom('Image')
      .select(['id', 'url', 'type', 'nsfwLevel'])
      .where('id', 'in', coverIds)
      .execute();
    for (const r of found)
      covers.set(r.id, { id: r.id, url: r.url, type: r.type as MediaType, nsfwLevel: r.nsfwLevel });
  }

  const base = civitaiAppUrl();
  return new Map(
    models.map((m) => [
      m.id,
      m.sfwName == null
        ? null
        : {
            name: m.sfwName,
            url: `${base}/models/${m.id}`,
            cover: (m.sfwCoverImageId != null && covers.get(m.sfwCoverImageId)) || null,
            coverPicked: m.sfwCoverImageId != null,
          },
    ])
  );
}
