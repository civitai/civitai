import {
  SERVICE_DEAL_ACCEPT_WINDOW_MS,
  SERVICE_DEAL_AUTO_COMPLETE_MS,
  SERVICE_DEAL_DISPUTE_WINDOW_MS,
} from '~/shared/constants/creator-services.constants';

/** Bump with any wording change below; records keep the text that was actually agreed to. */
export const SERVICES_TERMS_VERSION = 'services-terms-2026-10-24';

export const SELLER_AFFIRMATION_INTRO = 'I confirm that:';
export const SELLER_AFFIRMATION_ITEMS = [
  "I own or have the rights to everything I deliver, and it doesn't infringe anyone else's rights.",
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
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export const BUYER_DISCLOSURE_INTRO = 'Before you request:';

export function buyerDisclosureItems({
  price,
  revisionsIncluded,
  deliveryDays,
}: {
  price: number;
  revisionsIncluded: number;
  deliveryDays: number;
}) {
  const accept = hours(SERVICE_DEAL_ACCEPT_WINDOW_MS);
  const auto = hours(SERVICE_DEAL_AUTO_COMPLETE_MS);
  const dispute = hours(SERVICE_DEAL_DISPUTE_WINDOW_MS);
  return [
    `${price.toLocaleString()} Buzz is held now. It's refunded if the seller declines, doesn't accept within ${accept} hours, or you withdraw before they accept.`,
    `Includes ${plural(revisionsIncluded, 'revision')}. Delivery within ${plural(
      deliveryDays,
      'day'
    )} of acceptance.`,
    `After delivery you can accept or request a revision. There's no reject. If you do nothing, the order completes after ${auto} hours.`,
    `After completion, the Buzz goes to the seller after a ${dispute}-hour dispute window. Either side can request cancellation; if you can't agree, a Civitai moderator decides, and that decision is final.`,
    "Civitai isn't a party to this deal. Don't pay or share payment details outside Civitai.",
  ];
}

export const buyerHoldButtonLabel = (price: number) =>
  `Hold ${price.toLocaleString()} Buzz and send request`;
