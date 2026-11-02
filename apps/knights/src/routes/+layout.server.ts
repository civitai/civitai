import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => ({
  civitaiUrl: (env.CIVITAI_APP_URL || 'https://civitai.com').replace(/\/+$/, ''),
});
