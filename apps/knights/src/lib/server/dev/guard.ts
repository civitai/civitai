import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';

export function assertDevOnly(): void {
  if (!dev) error(404, 'Not found');
}
