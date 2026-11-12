import type { ReactNode } from 'react';
import { Alert, Button } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';

/**
 * Terms the user must confirm before the generator's controls appear. It takes over the footer
 * slot where the Generate button goes, so it can't be scrolled past or dismissed.
 */
export function FooterTermsGate({
  title,
  children,
  confirmLabel,
  onConfirm,
  loading,
  tourId,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  loading?: boolean;
  tourId?: string;
}) {
  return (
    <Alert
      data-strip-full
      color="yellow"
      title={title}
      data-tour={tourId}
      className="-m-2 rounded-none rounded-t-xl"
    >
      {children}
      <Button
        color="yellow"
        variant="light"
        onClick={onConfirm}
        loading={loading}
        style={{ marginTop: 10 }}
        leftSection={<IconCheck />}
        fullWidth
      >
        {confirmLabel}
      </Button>
    </Alert>
  );
}

export type FooterTakeover =
  | 'unavailable'
  | 'selfHostedBlocked'
  | 'generationTerms'
  | 'generationLicense'
  | 'membershipUpsell';

/** The one panel that owns the footer, highest priority first; none means the form controls show. */
export function pickFooterTakeover({
  available,
  selfHostedBlocked,
  termsReviewed,
  licenseBlocked,
  membershipNeedsAcknowledgment,
}: {
  available: boolean;
  selfHostedBlocked: boolean;
  termsReviewed: boolean;
  licenseBlocked: boolean;
  membershipNeedsAcknowledgment: boolean;
}): FooterTakeover | undefined {
  if (!available) return 'unavailable';
  if (selfHostedBlocked) return 'selfHostedBlocked';
  if (!termsReviewed) return 'generationTerms';
  if (licenseBlocked) return 'generationLicense';
  if (membershipNeedsAcknowledgment) return 'membershipUpsell';
  return undefined;
}
