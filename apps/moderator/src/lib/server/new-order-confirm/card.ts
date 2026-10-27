import type { ConfirmCard } from './confirm.service';

/**
 * What the rating page may hold: the claim token stands in for every internal id, and neither the
 * level the first moderator set nor the image's current level is ever part of it.
 */
export function pageCard({ token, url, type, name, width, height, leaseExpiresAt }: ConfirmCard) {
  return { token, url, type, name, width, height, leaseExpiresAt };
}
