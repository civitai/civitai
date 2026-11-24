import { useDomainColor } from '~/hooks/useDomainColor';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

/** The Buzz a service is paid in on this site: green on civitai.com, yellow everywhere else. */
export function useServiceBuzzType(): BuzzSpendType {
  return useDomainColor() === 'green' ? 'green' : 'yellow';
}
