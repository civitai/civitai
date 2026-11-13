import type { CatalogResult } from '$lib/box-design';

export async function fetchCatalog(
  boxId: number,
  params: URLSearchParams | string
): Promise<CatalogResult> {
  const response = await fetch(`/items/boxes/${boxId}/catalog?${params}`);
  if (!response.ok) throw new Error(`The catalog answered ${response.status}.`);
  return (await response.json()) as CatalogResult;
}
