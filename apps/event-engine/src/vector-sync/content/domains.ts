import { articleDomain } from '../articles/domain';
import type { Domain } from '../domain/sync';

/** Every content search domain the content consumer can run; each index's PR adds its own. */
export const CONTENT_DOMAINS: Domain<any>[] = [articleDomain];
