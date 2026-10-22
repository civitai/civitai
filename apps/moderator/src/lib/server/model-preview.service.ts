import { sql } from 'kysely';
import { dbRead } from './db';
import { cappedText } from './html-to-text';
import { getModel, getReports, getTags, getVersions } from './model-lookup.service';

/**
 * Enough of a reported model to judge the report from the reports panel: what the model page shows
 * a visitor first — its showcase images and description — the files it ships, who uploaded it, and
 * what earlier reports on it decided. Opening the site in a second tab was the only way to see any of
 * this. Where the model stands NOW is not here but in the page load (`getReportedModelStates`), which
 * an action reloads.
 *
 * Fetched per report on selection, not joined into the queue: images, files and description are
 * per-model reads that would make every 20-row page 20x the work for the one row on screen.
 */

/** Twelve, plus one more read to know whether to say "more on the model page". */
const IMAGE_LIMIT = 12;
/** Characters of description text. Enough to read the pitch and spot a stub; the rest is on the page. */
const DESCRIPTION_LIMIT = 1500;

export type ModelPreviewImage = {
  id: number;
  /** A Cloudflare-images key, straight from `Image.url` — never a URL, so `Lightbox` may render it. */
  url: string;
  type: 'image' | 'video';
  nsfwLevel: number;
  /** Already removed by moderation. Shown, and said, so a moderator does not act twice on one image. */
  blocked: boolean;
  /** Tagged as depicting a minor, or as a minor in an acceptable context: the evidence a minor flag
   *  is judged on. */
  minor: boolean;
  acceptableMinor: boolean;
};

export type ModelPreviewFile = {
  id: number;
  name: string;
  /** `Model`, `Training Data`, `Pruned Model`, `Config`, … — what the file is FOR. */
  type: string;
  sizeKB: number;
  /** `SafeTensor`, `PickleTensor`, `GGUF`, … from the file metadata, when the uploader gave one. */
  format: string | null;
  /** `Pending` / `Success` / `Danger` / `Error` — the two scanners, kept apart. */
  pickleScan: string;
  virusScan: string;
  visibility: string;
};

export type ModelPreviewVersion = {
  id: number;
  name: string;
  baseModel: string;
  status: string;
  publishedAt: Date | null;
  files: ModelPreviewFile[];
};

export type ModelPreview = {
  id: number;
  name: string;
  type: string;
  userId: number;
  username: string | null;
  userBanned: boolean;
  createdAt: Date;
  description: { text: string; truncated: boolean } | null;
  versions: ModelPreviewVersion[];
  tags: string[];
  images: ModelPreviewImage[];
  moreImages: boolean;
  /** Every other report filed on this model, by status — "actioned twice before" changes the call. */
  otherReports: { total: number; byStatus: Record<string, number> };
};

const metaString = (meta: unknown, key: string): string | null => {
  const v = meta && typeof meta === 'object' ? (meta as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v ? v : null;
};

export async function getModelPreview(
  modelId: number,
  reportId: number | null
): Promise<ModelPreview | null> {
  const model = await getModel(modelId);
  if (!model) return null;

  const [descriptionRow, versions, tags, reports, imageRows, fileRows] = await Promise.all([
    dbRead.selectFrom('Model').select('description').where('id', '=', modelId).executeTakeFirst(),
    getVersions(modelId),
    getTags(modelId),
    getReports(modelId),
    // The showcase: images the OWNER posted to the model's versions, in version then post order —
    // what the model page leads with. Other users' posts are reviews of the model, not the model.
    dbRead
      .selectFrom('Image as i')
      .innerJoin('Post as p', 'p.id', 'i.postId')
      .innerJoin('ModelVersion as mv', 'mv.id', 'p.modelVersionId')
      .select([
        'i.id',
        'i.url',
        'i.type',
        'i.nsfwLevel',
        'i.ingestion',
        'i.minor',
        'i.acceptableMinor',
      ])
      .where('mv.modelId', '=', modelId)
      .where('p.userId', '=', model.userId)
      .where('i.type', 'in', ['image', 'video'])
      .orderBy(sql`mv.index asc nulls last`)
      .orderBy('p.id', 'asc')
      .orderBy(sql`i.index asc nulls last`)
      .limit(IMAGE_LIMIT + 1)
      .execute(),
    // Current files only: a replaced file is history, and listing it beside its replacement reads as
    // the version shipping both. Same filter as `getVersions`' counts.
    dbRead
      .selectFrom('ModelFile as mf')
      .innerJoin('ModelVersion as mv', 'mv.id', 'mf.modelVersionId')
      .select([
        'mf.id',
        'mf.modelVersionId',
        'mf.name',
        'mf.type',
        'mf.sizeKB',
        'mf.metadata',
        'mf.pickleScanResult',
        'mf.virusScanResult',
        'mf.visibility',
      ])
      .where('mv.modelId', '=', modelId)
      .where('mf.replacedAt', 'is', null)
      .orderBy('mf.id', 'asc')
      .execute(),
  ]);

  const others = reports.rows.filter((r) => r.id !== reportId);
  const byStatus: Record<string, number> = {};
  for (const r of others) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  const filesByVersion = new Map<number, ModelPreviewFile[]>();
  for (const f of fileRows) {
    const list = filesByVersion.get(f.modelVersionId) ?? [];
    list.push({
      id: f.id,
      name: f.name,
      type: f.type,
      sizeKB: Number(f.sizeKB ?? 0),
      format: metaString(f.metadata, 'format'),
      pickleScan: f.pickleScanResult,
      virusScan: f.virusScanResult,
      visibility: f.visibility,
    });
    filesByVersion.set(f.modelVersionId, list);
  }

  return {
    id: model.id,
    name: model.name,
    type: model.type,
    userId: model.userId,
    username: model.username,
    userBanned: model.userBannedAt != null,
    createdAt: model.createdAt,
    description: cappedText(descriptionRow?.description, DESCRIPTION_LIMIT, { ellipsis: true }),
    versions: versions.map((v) => ({
      id: v.id,
      name: v.name,
      baseModel: v.baseModel,
      status: v.status,
      publishedAt: v.publishedAt,
      files: filesByVersion.get(v.id) ?? [],
    })),
    tags: tags.map((t) => t.name),
    images: imageRows.slice(0, IMAGE_LIMIT).map((i) => ({
      id: i.id,
      url: i.url,
      type: i.type as 'image' | 'video',
      nsfwLevel: i.nsfwLevel,
      blocked: i.ingestion === 'Blocked',
      minor: i.minor,
      acceptableMinor: i.acceptableMinor,
    })),
    moreImages: imageRows.length > IMAGE_LIMIT,
    // `getReports` caps its rows, so the total comes from its count, less this report.
    otherReports: {
      total: Math.max(0, reports.total - (reports.rows.some((r) => r.id === reportId) ? 1 : 0)),
      byStatus,
    },
  };
}
