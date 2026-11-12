import { articleDomain } from '../articles/domain';
import { comicDomain } from '../comics/domain';
import type { Domain } from '../domain/sync';

/** Every content search domain the content consumer can run. */
export const CONTENT_DOMAINS: Domain<any>[] = [articleDomain, comicDomain];
