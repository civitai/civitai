import { OffDomainNotice } from '~/components/OffDomain/OffDomainNotice';

/** A training dataset this domain refuses for its rating: say so, and link to it on civitai.red. */
export function OffDomainTrainingDataNotice({
  stub,
  href,
}: {
  stub?: { offDomain: true } | null;
  href: string;
}) {
  if (!stub) return null;
  return <OffDomainNotice noun="training data" href={href} testId="off-domain-training-data" />;
}
