import { env } from '~/env/server';

const HF_API = 'https://huggingface.co/api';
const HF_HOST = 'https://huggingface.co';

export type HuggingFaceFile = {
  path: string;
  size: number;
  /** Content sha256, present for LFS files — which is every weight file. Small non-LFS files carry a
   *  git blob sha1 instead, which is not comparable to a `ModelFileHash`, so they report null. */
  sha256: string | null;
};

export type HuggingFaceRepo = {
  repo: string;
  revision: string;
  license: string | null;
  gated: string | false;
  files: HuggingFaceFile[];
};

export class HuggingFaceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'HuggingFaceError';
  }
}

const WEIGHT_EXTENSIONS = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;
/** Per part, not per file — the run's budget is only checked BETWEEN parts, so one stalled read
 *  otherwise defers that check indefinitely and the next tick starts a second run. */
const RANGE_READ_TIMEOUT_MS = 90_000;

export function isWeightFile(path: string) {
  return WEIGHT_EXTENSIONS.test(path);
}

/**
 * A `ModelFile.type` guess from the file's path, or null when the path doesn't say.
 *
 * 🔴 Advisory only — the attach call takes the type explicitly. Naming conventions are the whole
 * evidence here, and a wrong guess on the *primary* weights is the expensive one: it decides whether
 * a version is loadable at all. So the primary case is exactly the one this refuses to infer.
 */
export function suggestFileType(path: string): 'VAE' | 'Text Encoder' | 'Config' | null {
  const name = path.toLowerCase();
  const base = name.split('/').pop() ?? name;
  const stem = base.replace(/\.[^.]+$/, '');

  if (/\.(json|yaml|yml|txt|md)$/.test(base)) return 'Config';
  // A containing directory is decisive; otherwise the WHOLE basename must be the accessory.
  // `flux1-dev-vae-baked.safetensors` is the primary weights and merely names its bundled VAE —
  // claiming it is the one mistake that produces a version nothing can load.
  if (/(^|\/)text_encoder/.test(name)) return 'Text Encoder';
  if (/^(t5|umt5|clip|clip_[lgh]|open_?clip)[\w.-]*$/.test(stem)) return 'Text Encoder';
  if (/(^|\/)vae(\/|$)/.test(name)) return 'VAE';
  if (/^(ae|vae)([_.-][\w.-]*)?$/.test(stem)) return 'VAE';
  return null;
}

/** Accepts a repo URL, a `/tree/<rev>` or `/blob/<rev>/<file>` URL, or a bare `owner/name`. */
export function parseHuggingFaceRepo(input: string): { repo: string; revision?: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withoutHost = trimmed
    .replace(/^https?:\/\/(www\.)?huggingface\.co\//i, '')
    .replace(/^\/+/, '');
  const segments = withoutHost.split('?')[0].split('#')[0].split('/').filter(Boolean);
  // A copied URL sometimes carries a `models/` prefix; datasets and spaces are a different API.
  const parts = segments[0] === 'models' ? segments.slice(1) : segments;
  if (parts.length < 2) return null;

  const repo = `${parts[0]}/${parts[1]}`;
  const marker = parts[2];
  const revision = marker === 'tree' || marker === 'blob' ? parts[3] : undefined;
  return revision ? { repo, revision } : { repo };
}

function authHeaders(): Record<string, string> {
  const token = env.HUGGING_FACE_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function hfFetch(url: string) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new HuggingFaceError(
      res.status === 401 || res.status === 403
        ? `Hugging Face refused the request (${res.status}). The repo is gated or private; importing it needs a HUGGING_FACE_TOKEN whose account has accepted its terms.`
        : `Hugging Face returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      res.status
    );
  }
  return res.json();
}

type TreeEntry = {
  type: string;
  path: string;
  size?: number;
  oid?: string;
  lfs?: { oid?: string; size?: number };
};

/**
 * Lists a repo's files at a pinned revision, resolving a branch to its commit sha — an import records
 * which bytes it took, and `main` moves.
 */
export async function getRepoFiles(input: {
  repo: string;
  revision?: string;
}): Promise<HuggingFaceRepo> {
  const { repo } = input;
  const infoUrl = input.revision
    ? `${HF_API}/models/${repo}/revision/${encodeURIComponent(input.revision)}`
    : `${HF_API}/models/${repo}`;
  const info = (await hfFetch(infoUrl)) as {
    id?: string;
    sha?: string;
    gated?: string | false;
    cardData?: { license?: string | string[] };
  };

  // 🔴 The repo id comes from HF's response, not from what was pasted. It is the group every import
  // is filed under, and a URL typed with different casing would otherwise file the same repo under
  // two groups that nothing could merge.
  const canonicalRepo = info.id ?? repo;

  const revision = info.sha ?? input.revision;
  if (!revision) throw new HuggingFaceError(`Could not resolve a commit sha for ${repo}`);

  const tree = (await hfFetch(
    `${HF_API}/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=true`
  )) as TreeEntry[];

  const license = Array.isArray(info.cardData?.license)
    ? info.cardData?.license[0] ?? null
    : info.cardData?.license ?? null;

  return {
    repo: canonicalRepo,
    revision,
    license,
    gated: info.gated ?? false,
    files: tree
      .filter((entry) => entry.type === 'file')
      .map((entry) => ({
        path: entry.path,
        size: entry.lfs?.size ?? entry.size ?? 0,
        sha256: entry.lfs?.oid ?? null,
      }))
      .sort((a, b) => b.size - a.size),
  };
}

/** The name a batch gets unless a moderator types a different one: the repo's own name, without the owner. */
export function defaultGroupName(repo: string) {
  return repo.split('/').pop() ?? repo;
}

export function huggingFaceResolveUrl(repo: string, revision: string, path: string) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${HF_HOST}/${repo}/resolve/${encodeURIComponent(revision)}/${encodedPath}`;
}

/**
 * Reads one byte range of a file.
 *
 * A server that ignores `Range` answers 200 with the WHOLE file, so only a 206 is accepted.
 */
export async function readHuggingFaceRange({
  url,
  start,
  end,
  signal,
  timeoutMs = RANGE_READ_TIMEOUT_MS,
}: {
  url: string;
  start: number;
  /** Inclusive, as HTTP ranges are. */
  end: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    headers: { ...authHeaders(), Range: `bytes=${start}-${end}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status !== 206) {
    throw new HuggingFaceError(
      `Expected 206 for range ${start}-${end} of ${url}, got ${res.status}`,
      res.status
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function headHuggingFaceFile(url: string) {
  const res = await fetch(url, { method: 'HEAD', headers: authHeaders(), redirect: 'follow' });
  if (!res.ok) throw new HuggingFaceError(`HEAD failed with ${res.status} for ${url}`, res.status);
  const length = Number(res.headers.get('content-length') ?? '0');
  return Number.isFinite(length) && length > 0 ? length : null;
}
