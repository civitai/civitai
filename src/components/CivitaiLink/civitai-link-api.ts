import { env } from '~/env/client.mjs';

export type CivitaiLinkInstance = {
  id: number;
  key: string;
  name: string | null;
  activated: boolean;
  origin: string | null;
  createdAt: Date;
};

const clFetch = async (url: string, options: RequestInit = {}) => {
  if (!url.startsWith('/')) url = '/' + url;
  const response = await fetch(env.NEXT_PUBLIC_CIVITAI_LINK + url, {
    ...options,
    credentials: 'include',
  });
  if (!response.ok) {
    console.error(response);
    return {} as unknown;
  }
  return response.json() as unknown;
};

export const getLinkInstances = async () => {
  return (await clFetch('/api/link')) as CivitaiLinkInstance[];
};

export const createLinkInstance = async (id?: number) => {
  return (await clFetch(`/api/link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: id ? JSON.stringify({ id }) : undefined,
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
