/**
 * The reasons a moderator may take down a Creator Services OFFERING, worded for its seller. An
 * offering is a listing of work for hire, so these describe what is being offered, not an upload.
 *
 * Shared because two places take an offering down: the main app's `creatorService.takedown` and the
 * moderator app's report queue. Both store the key in `ServiceOffering.removedReason` and send the
 * same notification, whose copy the main app renders from this map.
 */
export const serviceOfferingTakedownReasons = {
  'prohibited-content': {
    optionLabel: 'Offers content our guidelines prohibit',
    notificationMessage:
      'Services offering to create content that is prohibited under our content guidelines are not allowed.',
    type: 'policy',
  },
  'real-person-likeness': {
    optionLabel: 'Offers real-person likeness',
    notificationMessage:
      'Services offering to depict real people are prohibited under our content guidelines.',
    type: 'policy',
  },
  'hate-speech': {
    optionLabel: 'Promotion of hate-speech or targeted attack',
    notificationMessage:
      'Content that attacks, harasses, or discriminates against an individual or group based on their race, ethnicity, nationality, religion, gender, sexual orientation, disability, or any other characteristic is prohibited under our content guidelines.',
    type: 'policy',
  },
  'off-platform': {
    optionLabel: 'Moves payment or contact off Civitai',
    notificationMessage:
      'Services must be requested, paid for and delivered on Civitai. Directing buyers to pay or deal elsewhere is not allowed.',
    type: 'policy',
  },
  misleading: {
    optionLabel: 'Misleading or fraudulent listing',
    notificationMessage:
      'Services must describe honestly what the buyer will receive. Misleading or fraudulent listings are prohibited under our Terms of Service.',
    type: 'policy',
  },
  spam: {
    optionLabel: 'Spam or advertorial content',
    notificationMessage:
      'Spam and advertisements are strictly prohibited under our Terms of Service.',
    type: 'policy',
  },
  other: {
    optionLabel: 'Other',
    notificationMessage: '',
    type: 'policy',
  },
} as const satisfies Record<
  string,
  { optionLabel: string; notificationMessage: string; type: 'policy' | 'quality' }
>;

export type ServiceOfferingTakedownReason = keyof typeof serviceOfferingTakedownReasons;

export const isServiceOfferingTakedownReason = (
  reason: unknown
): reason is ServiceOfferingTakedownReason =>
  typeof reason === 'string' && Object.hasOwn(serviceOfferingTakedownReasons, reason);

/** The notification a takedown sends its seller, once per offering (the key is the dedupe). */
export const SERVICE_OFFERING_TAKEN_DOWN = 'service-offering-taken-down';
export const serviceOfferingTakenDownKey = (offeringId: number) =>
  `${SERVICE_OFFERING_TAKEN_DOWN}:${offeringId}`;

/**
 * The details the seller's notification carries. Only `other` has no copy of its own, so only its
 * details are written for the seller; for every other reason they are a moderator's note and stay
 * on the offering row, out of the notification payload.
 */
export const sellerFacingTakedownDetails = (
  reason: ServiceOfferingTakedownReason,
  details: string | null | undefined
) => (reason === 'other' ? details ?? null : null);
