import dynamic from 'next/dynamic';
import type { RegionInfo } from '~/server/utils/region-blocking';
import { isConsentRequired, type ConsentDecision } from './consent.utils';

// Only loaded for visitors in regions that require a consent prompt (currently
// CA only). Non-CA users never download this chunk. ssr is left at its default
// (true) so the script-gating context is correct on the first server render —
// otherwise SSR would emit GA / Snigel <script> tags for CA visitors before
// hydration could block them.
const CAConsentManager = dynamic(() =>
  import('./CAConsentManager').then((m) => m.CAConsentManager)
);

type Props = {
  children: React.ReactNode;
  region: RegionInfo | null | undefined;
  initialConsent: ConsentDecision | null;
};

export function ThirdPartyConsentProvider({ children, region, initialConsent }: Props) {
  if (!isConsentRequired(region)) return <>{children}</>;
  return <CAConsentManager initialConsent={initialConsent}>{children}</CAConsentManager>;
}
