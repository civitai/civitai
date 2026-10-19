import { throwBadRequestError } from '~/server/utils/errorHandling';

/** A bounty is listed from creation, but takes entries and Buzz only once `startsAt` has passed. */
export function assertBountyStarted({ startsAt }: { startsAt: Date }) {
  if (startsAt > new Date())
    throw throwBadRequestError(
      `This bounty has not started yet. It starts ${startsAt
        .toISOString()
        .slice(0, 16)
        .replace('T', ' ')} UTC.`
    );
}
