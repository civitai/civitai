import type { PageServerLoad } from './$types';
import { getImagesPendingIngestion } from '$lib/server/ingestion.service';

export const load: PageServerLoad = async () => {
  return { images: await getImagesPendingIngestion() };
};
