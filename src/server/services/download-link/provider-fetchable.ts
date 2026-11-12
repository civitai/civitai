import { ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * Statuses a provider may fetch, on both the model and the version. Anything else is refused.
 * Shared by `checkGenerationFetch` and the hash URLs' candidate query, which must not offer a
 * provider a copy the gate would refuse.
 */
export const PROVIDER_FETCHABLE_STATUSES: readonly string[] = [
  ModelStatus.Published,
  ModelStatus.Unpublished,
  ModelStatus.Draft,
  ModelStatus.Scheduled,
];
