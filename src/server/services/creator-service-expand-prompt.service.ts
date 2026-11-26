import { dbWrite } from '~/server/db/client';
import { orchestratorChatCompletion } from '~/server/services/comics/orchestrator-chat';
import { classifyPromptServer } from '~/server/services/orchestrator/promptAuditing';
import {
  throwBadRequestError,
  throwInternalServerError,
  throwNotFoundError,
  throwServiceUnavailableError,
} from '~/server/utils/errorHandling';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { ServiceDealStatus } from '~/shared/utils/prisma/enums';

export const SERVICE_PROMPT_MODEL = 'civitai/qwen3.8';

const EXPANDABLE_STATUSES: ServiceDealStatus[] = [
  ServiceDealStatus.Requested,
  ServiceDealStatus.Accepted,
];

export const SERVICE_PROMPT_REFUSED = 'The request text did not pass the prompt check.';

/**
 * Turns a deal's request text into a generation prompt with the seller's own instructions, on the
 * seller's token and Buzz. The request text is read here, never taken from the caller, so a seller
 * cannot use this as a general prompt tool and an agent fulfilling the deal never has to read it.
 *
 * The buyer's text is classified without recording a block against the seller: a buyer must not be
 * able to mute a seller by requesting something refused. The returned prompt is audited again, as
 * usual, when the seller generates from it.
 */
export async function expandServiceDealPrompt(
  {
    dealId,
    sellerId,
    instructions,
    token,
    isGreen,
    currencies,
  }: {
    dealId: number;
    sellerId: number;
    instructions: string;
    token: string;
    isGreen: boolean;
    currencies: BuzzSpendType[];
  },
  { classify = classifyPromptServer, complete = orchestratorChatCompletion } = {}
) {
  // primary: the deal is usually seconds old when its seller expands it.
  const deal = await dbWrite.serviceDeal.findUnique({
    where: { id: dealId },
    select: { sellerId: true, status: true, heldAt: true, requestText: true },
  });
  if (!deal || deal.sellerId !== sellerId) throw throwNotFoundError('Deal not found.');
  if (!deal.heldAt || !EXPANDABLE_STATUSES.includes(deal.status))
    throw throwBadRequestError('Only a paid deal that is requested or accepted can be expanded.');

  const verdict = await classify({ prompt: deal.requestText, isGreen });
  // The external check fails open inside classify; here an unchecked text must not reach the model.
  if (verdict.externalError)
    throw throwServiceUnavailableError(
      'The prompt check is unavailable. Try again later.',
      verdict.externalError
    );
  if (verdict.outcome !== 'pass') throw throwBadRequestError(SERVICE_PROMPT_REFUSED);

  const { content } = await complete({
    token,
    model: SERVICE_PROMPT_MODEL,
    messages: [
      { role: 'system', content: instructions },
      { role: 'user', content: deal.requestText },
    ],
    maxTokens: 400,
    currencies,
  });
  if (!content) throw throwInternalServerError(new Error('The prompt model returned no text.'));

  return { prompt: content };
}
