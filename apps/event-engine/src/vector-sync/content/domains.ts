import { articleDomain } from '../articles/domain';
import { challengeDomain } from '../challenges/domain';
import { comicDomain } from '../comics/domain';
import { crucibleDomain } from '../crucibles/domain';
import type { Domain } from '../domain/sync';
import { storylineDomain } from '../storylines/domain';
import { model3dDomain } from '../models3d/domain';

/** Every content search domain the content consumer can run. */
export const CONTENT_DOMAINS: Domain<any>[] = [
  articleDomain,
  comicDomain,
  crucibleDomain,
  challengeDomain,
  storylineDomain,
  model3dDomain,
];
