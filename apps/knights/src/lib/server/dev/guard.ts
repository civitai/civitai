import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';

/** `dev` is fixed at build time, so a production build answers 404 whatever the request says. */
export function assertDevOnly(): void {
  if (!dev) error(404, 'Not found');
}
