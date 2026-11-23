import { pluralize } from '~/shared/utils/pluralize';
import {
  SERVICE_DEAL_ACCEPT_WINDOW_MS,
  SERVICE_DEAL_AUTO_COMPLETE_MS,
  SERVICE_DEAL_CANCELLATION_RESPONSE_MS,
  SERVICE_DEAL_DISPUTE_WINDOW_MS,
} from '~/shared/constants/creator-services.constants';

/** Bump with any wording change below; records keep the text that was actually agreed to. */
export const SERVICES_TERMS_VERSION = 'services-terms-2026-11-20';

export const SELLER_AFFIRMATION_INTRO = 'I confirm that:';
export const SELLER_AFFIRMATION_ITEMS = [
  "Everything I deliver is my own work or I have the rights to it, and to my knowledge it doesn't infringe anyone else's rights.",
  "This service doesn't depict or imitate a real person.",
  "I'll follow Civitai's Terms of Service and content rules, and I'll take payment only through Civitai.",
  "I'm responsible for any taxes on what I earn.",
] as const;

/** What the server records verbatim next to the seller's agreement. */
export const SELLER_AFFIRMATION_STATEMENT = [
  SELLER_AFFIRMATION_INTRO,
  ...SELLER_AFFIRMATION_ITEMS.map((item) => `- ${item}`),
].join('\n');

const hours = (ms: number) => ms / 3_600_000;

export const BUYER_DISCLOSURE_INTRO = 'Before you request:';

/**
 * The buyer disclosure's own version, apart from the seller's terms (`SERVICES_TERMS_VERSION`), so a
 * wording change here does not ask sellers to affirm again. Bump with any change to
 * `buyerDisclosureItems`; a deal stores the version and the lines its buyer was shown.
 */
export const BUYER_DISCLOSURE_VERSION = 'buyer-disclosure-2026-11-23';

/** One disclosure line: a bold lead sentence, then the rest. */
export type BuyerDisclosureItem = { lead: string; text: string };

/**
 * What a buyer agrees to before the hold. `reviewEnabled` is the value that sets the deal's
 * `reviewEnabledAt`: with reviews, a happy review pays the seller at once and ends the dispute window.
 */
export function buyerDisclosureItems({
  price,
  revisionsIncluded,
  deliveryDays,
  reviewEnabled,
}: {
  price: number;
  revisionsIncluded: number;
  deliveryDays: number;
  reviewEnabled: boolean;
}): BuyerDisclosureItem[] {
  const accept = hours(SERVICE_DEAL_ACCEPT_WINDOW_MS);
  const auto = hours(SERVICE_DEAL_AUTO_COMPLETE_MS);
  const cancelResponse = hours(SERVICE_DEAL_CANCELLATION_RESPONSE_MS);
  const dispute = hours(SERVICE_DEAL_DISPUTE_WINDOW_MS);
  return [
    {
      lead: `${price.toLocaleString()} Buzz is held now.`,
      text: `Refunded if the seller declines, doesn't accept within ${accept} hours, or you withdraw before they accept.`,
    },
    {
      lead: `Delivery within ${pluralize(deliveryDays, 'day')} of acceptance.`,
      text:
        revisionsIncluded === 0
          ? 'No revisions included.'
          : `${pluralize(revisionsIncluded, 'revision')} included.`,
    },
    {
      lead: 'Accept or request an included revision.',
      text: `You can't reject a delivery, but you can ask to cancel. If you do nothing, it completes ${auto} hours after the latest delivery.`,
    },
    {
      lead: 'Either side can ask to cancel before completion.',
      text: `You're refunded if the other side agrees or doesn't answer within ${cancelResponse} hours. If they decline, a Civitai moderator decides.`,
    },
    {
      lead: `You have ${dispute} hours after completion to dispute.`,
      text: reviewEnabled
        ? 'Then the seller is paid. If you review the work as Happy, the seller is paid right away and you can no longer dispute. Moderator decisions on disputes and cancellations are final on Civitai.'
        : 'Then the seller is paid. Moderator decisions on disputes and cancellations are final on Civitai.',
    },
    {
      lead: "Civitai isn't a party to this deal.",
      text: "Don't pay or share payment details outside Civitai.",
    },
  ];
}

/** The lines a deal stores: each item as the buyer read it, lead then text. */
export const buyerDisclosureLines = (items: BuyerDisclosureItem[]) =>
  items.map(({ lead, text }) => `${lead} ${text}`);

export const buyerHoldButtonLabel = (price: number) =>
  `Hold ${price.toLocaleString()} Buzz and send request`;
