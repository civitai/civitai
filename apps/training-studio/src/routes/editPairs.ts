import JSZip from 'jszip';
import { mediaOfExt, mimeOfExt } from '$lib/media';
import { abortableDelay } from '$lib/pool';
import { trainingBlobKey, type TrainingItem } from '$lib/train-core';
import {
  compareFileNames,
  isFailed,
  isTrainable,
  nextImgId,
  type Img,
  type SamplePrompt,
} from './trainingFlow';

/** Where a pair came from — the list filters and each card's source tag read it. */
export type PairSource = 'upload' | 'zip' | 'gen';

/** One edit-LoRA example: the image the edit starts from, its result, and the instruction that turns
 *  one into the other. Owned by the flow so it survives Back/Continue. */
export interface EditPair {
  id: number;
  before: Img;
  after?: Img;
  instruction: string;
  source: PairSource;
  /** The imported zip's file name, for the source tag and filter. */
  sourceName?: string;
}

/** Below this the Data step says how many more pairs it recommends. */
export const RECOMMENDED_PAIRS = 15;

let pairSeq = 0;
export const nextPairId = () => ++pairSeq;

/** A fresh, not-yet-uploaded tile for a local file. */
export function localImg(file: File, name = file.name): Img {
  return {
    id: nextImgId(),
    file,
    name,
    previewUrl: URL.createObjectURL(file),
    mediaType: 'image',
    status: 'uploading',
    progress: 0,
    tags: [],
    caption: '',
  };
}

/** A tile for an image that is already an orchestrator blob (a generation, a created after image):
 *  scanned, so nothing to upload. */
export function blobImg(
  fields: Pick<Img, 'name' | 'previewUrl' | 'blobId' | 'blobUrl'> &
    Partial<Pick<Img, 'nsfwLevel' | 'sourceWorkflowId'>>
): Img {
  return {
    id: nextImgId(),
    mediaType: 'image',
    status: 'uploaded',
    progress: 1,
    tags: [],
    caption: '',
    ...fields,
  };
}

/** The pair's images: its start, then its result when it has one. */
export const pairImgs = (pair: EditPair): Img[] =>
  pair.after ? [pair.before, pair.after] : [pair.before];

export type PairProblem = 'uploading' | 'failed' | 'no-after' | 'no-instruction';

/** What keeps a pair out of training, or null when it is ready. Upload problems come first: an
 *  instruction is worth nothing on a pair whose images never arrived. */
export function pairProblem(pair: EditPair): PairProblem | null {
  const images = pairImgs(pair);
  if (images.some(isFailed)) return 'failed';
  if (images.some((img) => !isTrainable(img))) return 'uploading';
  if (!pair.after) return 'no-after';
  if (!pair.instruction.trim()) return 'no-instruction';
  return null;
}

export const isPairReady = (pair: EditPair) => pairProblem(pair) === null;

/** Identity of a pair's starting image: identical files share it, whichever pair they arrived in. A
 *  local file is known by its bytes before upload; a blob-backed one by its orchestrator key. */
export function startKey(pair: EditPair): string | undefined {
  if (pair.before.hash) return `sha:${pair.before.hash}`;
  return pair.before.blobId ? `blob:${trainingBlobKey(pair.before.blobId)}` : undefined;
}

/** The pairs grouped by starting image: `groups` holds every starting image used more than once, in
 *  first-seen order; `singles` the pairs whose starting image is theirs alone. */
export function groupByStart(pairs: EditPair[]): {
  groups: { key: string; pairs: EditPair[] }[];
  singles: EditPair[];
} {
  const byKey = new Map<string, EditPair[]>();
  const singles: EditPair[] = [];
  for (const pair of pairs) {
    const key = startKey(pair);
    if (!key) {
      singles.push(pair);
      continue;
    }
    const group = byKey.get(key);
    if (group) group.push(pair);
    else byKey.set(key, [pair]);
  }
  const groups: { key: string; pairs: EditPair[] }[] = [];
  for (const [key, group] of byKey) {
    if (group.length > 1) groups.push({ key, pairs: group });
    else singles.push(group[0]!);
  }
  // `singles` collected keyless pairs first; restore the list order.
  const order = new Map(pairs.map((p, i) => [p.id, i]));
  singles.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { groups, singles };
}

/** Undefined where the browser offers no SubtleCrypto (a non-https origin) — those pairs group by
 *  their uploaded blob instead. */
export async function hashFile(file: Blob): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Folder names a dataset zip may use for each side, lower-cased. `control_1`/`main` is AI-Toolkit's own
// layout; the rest are what people name the folders when they make one by hand.
const BEFORE_DIRS = new Set(['control_1', 'control', 'before', 'input', 'source', 'start']);
const AFTER_DIRS = new Set(['main', 'target', 'after', 'output', 'result']);

export interface ZipPairMatch {
  /** In file-browser order of the starting image. */
  pairs: { base: string; beforePath: string; afterPath?: string; captionPath?: string }[];
  /** After images with no starting image of the same name. */
  orphanAfters: string[];
  /** Image files in a folder that is neither side (e.g. `control_2/`, which a single-start pair
   *  can't use). */
  ignored: string[];
}

const splitPath = (path: string) => {
  const parts = path.split('/');
  const name = parts.pop() ?? path;
  const dot = name.lastIndexOf('.');
  return {
    dir: (parts.pop() ?? '').toLowerCase(),
    name,
    base: (dot > 0 ? name.slice(0, dot) : name).toLowerCase(),
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
};

/** Pair a dataset zip's files by name across its before and after folders. Null when the zip has
 *  neither folder — it is not an edit dataset. A `.txt` beside an after image (or its starting image)
 *  is that pair's instruction. */
export function matchZipPairs(paths: string[]): ZipPairMatch | null {
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  const captions = new Map<string, { path: string; afterSide: boolean }>();
  const ignored: string[] = [];
  let sawSide = false;
  for (const path of [...paths].sort(compareFileNames)) {
    const { dir, name, base, ext } = splitPath(path);
    if (!name || name.startsWith('.') || path.includes('__MACOSX/')) continue;
    const side = BEFORE_DIRS.has(dir) ? 'before' : AFTER_DIRS.has(dir) ? 'after' : null;
    if (side) sawSide = true;
    if (ext === 'txt') {
      const existing = captions.get(base);
      // The after side's caption wins: it is where AI-Toolkit reads it from.
      if (!existing || (side === 'after' && !existing.afterSide))
        captions.set(base, { path, afterSide: side === 'after' });
      continue;
    }
    if (mediaOfExt(ext) !== 'image') continue;
    if (side === 'before' && !before.has(base)) before.set(base, path);
    else if (side === 'after' && !after.has(base)) after.set(base, path);
    else if (!side) ignored.push(path);
  }
  if (!sawSide) return null;
  const pairs = [...before].map(([base, beforePath]) => ({
    base,
    beforePath,
    afterPath: after.get(base),
    captionPath: captions.get(base)?.path,
  }));
  const orphanAfters = [...after].filter(([base]) => !before.has(base)).map(([, path]) => path);
  return { pairs, orphanAfters, ignored };
}

export interface ImportedPair {
  before: File;
  after?: File;
  /** The pair's `.txt`, verbatim but trimmed; absent when the zip has none for it. */
  instruction?: string;
  beforeHash?: string;
}

export interface ReadEditZip {
  pairs: ImportedPair[];
  orphanAfters: string[];
  ignored: string[];
}

/** Read a dataset zip as pairs (`matchZipPairs`), hashing each starting image so pairs that share one
 *  are known before anything uploads. Null when the zip has no before/after folders. */
export async function readEditZip(file: Blob): Promise<ReadEditZip | null> {
  const zip = await JSZip.loadAsync(file);
  const match = matchZipPairs(Object.keys(zip.files).filter((n) => !zip.files[n]!.dir));
  if (!match) return null;
  const toFile = async (path: string) => {
    const name = path.split('/').pop() ?? path;
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    return new File([await zip.files[path]!.async('blob')], name, {
      type: mimeOfExt(ext) ?? `image/${ext}`,
    });
  };
  const pairs = await Promise.all(
    match.pairs.map(async (p): Promise<ImportedPair> => {
      const before = await toFile(p.beforePath);
      const caption = p.captionPath ? (await zip.files[p.captionPath]!.async('string')).trim() : '';
      return {
        before,
        after: p.afterPath ? await toFile(p.afterPath) : undefined,
        instruction: caption || undefined,
        beforeHash: await hashFile(before),
      };
    })
  );
  return { pairs, orphanAfters: match.orphanAfters, ignored: match.ignored };
}

/** The file extension to place an image under: its name's, else its blob's, else png. */
export function imgExt(img: Img): string {
  for (const source of [img.name, img.blobId, img.blobUrl?.split('?')[0]]) {
    if (!source) continue;
    const dot = source.lastIndexOf('.');
    const ext = dot > 0 ? source.slice(dot + 1).toLowerCase() : '';
    if (mediaOfExt(ext) === 'image') return ext;
  }
  return 'png';
}

/** The training items for ready pairs, in the layout AI-Toolkit's edit training reads: each pair's
 *  starting image at `control_1/<name>` and its result at `main/<name>` — the same name, which is what
 *  pairs them — captioned with the instruction. Every pair names its own starting image, so a start
 *  shared by several pairs is placed once per pair. */
export function pairItems(pairs: EditPair[]): TrainingItem[] {
  const ready = pairs.filter(isPairReady);
  const width = Math.max(4, String(ready.length).length);
  return ready.flatMap((pair, i) => {
    const name = `pair_${String(i + 1).padStart(width, '0')}`;
    return [
      { air: pair.before.blobId!, caption: '', path: `control_1/${name}.${imgExt(pair.before)}` },
      {
        air: pair.after!.blobId!,
        caption: pair.instruction.trim(),
        path: `main/${name}.${imgExt(pair.after!)}`,
      },
    ];
  });
}

/** Sample prompts for an edit run: up to three ready pairs at random, each rendered from its own
 *  starting image with its own instruction — so every sample shows the LoRA doing an edit it was taught. */
export function seedEditPrompts(pairs: EditPair[]): SamplePrompt[] {
  const pool = pairs.filter((p) => isPairReady(p) && p.before.blobUrl?.startsWith('http'));
  const picks: EditPair[] = [];
  while (picks.length < 3 && pool.length > 0)
    picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!);
  return picks.map((p, id) => ({
    id,
    text: p.instruction.trim(),
    image: { url: p.before.blobUrl!, name: p.before.name },
  }));
}

/** Poll a helper run until it reports `done`, then return its last answer. Rejects on `signal`'s
 *  abort, and after `timeoutMs` — a stuck run must not hold a spinner forever. */
export async function pollUntilDone<T extends { done: boolean }>(
  poll: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  { intervalMs = 2000, timeoutMs = 240_000 }: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    const answer = await poll(signal);
    if (answer.done) return answer;
    if (Date.now() > deadline) throw new Error('This is taking too long — try again.');
    await abortableDelay(intervalMs, signal);
  }
}
