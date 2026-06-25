import { env } from '~/env/client';

export type CivitaiLinkInstance = {
  id: number;
  key: string;
  name: string | null;
  activated: boolean;
  origin: string | null;
  createdAt: Date;
};

/**
 * Resolve the Civitai Link service base URL for the current host.
 *
 * `NEXT_PUBLIC_CIVITAI_LINK` (e.g. https://link.civitai.com) is baked at build
 * time and identical for the .com and .red builds. But the Link service
 * authenticates via the civitai session cookie, which after the .com/.red
 * split is domain-scoped to the host the user logged in on. A .red user's
 * cookie never reaches link.civitai.com, so the request 401s and key
 * generation hangs forever (ClickUp 868k49796). Target the same-registrable-
 * domain link.civitai.red instead so the .civitai.red cookie is sent.
 *
 * Runs in both window and SharedWorker contexts (`globalThis.location`).
 */
export const getCivitaiLinkBaseUrl = (): string | undefined => {
  const base = env.NEXT_PUBLIC_CIVITAI_LINK;
  if (!base) return base;
  const host = (globalThis as { location?: { hostname?: string } }).location?.hostname?.toLowerCase();
  const isRed = host === 'civitai.red' || (host?.endsWith('.civitai.red') ?? false);
  return isRed ? base.replace('.civitai.com', '.civitai.red') : base;
};

const clFetch = async (url: string, options: RequestInit = {}) => {
  const base = getCivitaiLinkBaseUrl();
  if (!base) throw new Error('Civitai Link URL not set');

  if (!url.startsWith('/')) url = '/' + url;
  const response = await fetch(base + url, {
    ...options,
    credentials: 'include',
  });
  // Surface failures instead of returning {}: a non-array body silently became
  // `instances` and downstream `.find` threw "a.find is not a function" while
  // the UI spun forever. Throwing lets the worker's catch emit a real error.
  if (!response.ok) {
    throw new Error(`Civitai Link request failed (${response.status} ${response.statusText})`);
  }
  return response.json() as unknown;
};

export const getLinkInstances = async () => {
  const result = await clFetch('/api/link');
  return (Array.isArray(result) ? result : []) as CivitaiLinkInstance[];
};

export const createLinkInstance = async (id?: number) => {
  return (await clFetch(`/api/link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: id ? JSON.stringify({ id }) : JSON.stringify({}),
  })) as { id: number; key: string; instanceCount: number; instanceLimit: number; name: string };
};

export const updateLinkInstance = async (data: { id: number; name: string }) => {
  if (!data.id) throw new Error('Missing id');

  return (await clFetch(`/api/link`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })) as { id: number; name: string };
};

export const deleteLinkInstance = async (id: number) => {
  return (await clFetch(`/api/link?id=${id}`, {
    method: 'DELETE',
  })) as { success: boolean };
};
