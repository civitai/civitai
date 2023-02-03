import { env } from '~/env/client.mjs';

export type CivitaiLinkInstance = {
  id: number;
  key: string;
  name: string | null;
  activated: boolean;
  origin: string | null;
  createdAt: Date;
};

const links = [
  {
    id: 2,
    activated: true,
    key: '327f5d153ddd160e95e97465ae0aaa4893f74e1477fa4a1215ab9e77aac2d51276385398b4e1c94bcaf9e4ab705e0b245f2d1ff05dda9fc6aed8b729072c1d52',
    origin: null,
    name: null,
    createdAt: '2023-02-01T18:50:51.760Z',
  },
  {
    id: 3,
    activated: true,
    key: '920ceef9e51f59ecaa5b790c32dea22a162188eab624929a2cccabd18d40c75c2987b9f92ffaef104b3d9425fd9b9b3794b0975a1ac433f9d7cf55310e7d3d9a',
    origin: null,
    name: null,
    createdAt: '2023-02-02T21:39:08.522Z',
  },
];

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
  // return links;
  return (await clFetch('/api/link')) as CivitaiLinkInstance[];
};

export const createLinkInstance = async () => {
  return (await clFetch(`/api/link`, {
    method: 'POST',
  })) as { id: number; key: string; instanceCount: number; instanceLimit: number };
};

export const updateLinkInstance = async (data: Partial<CivitaiLinkInstance>) => {
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
