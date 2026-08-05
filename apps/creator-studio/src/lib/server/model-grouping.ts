import type { Cookies } from '@sveltejs/kit';
import { MODEL_GROUPING_COOKIE, parseModelGrouping } from '$lib/model-grouping';

export function readModelGrouping(cookies: Cookies) {
  return parseModelGrouping(cookies.get(MODEL_GROUPING_COOKIE));
}
