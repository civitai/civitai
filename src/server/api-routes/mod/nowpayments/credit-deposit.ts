import * as z from 'zod';
import { creditDeposit, previewDepositCredit } from '~/server/services/nowpayments-credit.service';
import { handleEndpointError, ModEndpoint } from '~/server/utils/endpoint-helpers';
import { throwBadRequestError } from '~/server/utils/errorHandling';

const acknowledgeSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) =>
    (Array.isArray(value) ? value : value?.split(',') ?? []).map((s) => s.trim()).filter(Boolean)
  );

const previewSchema = z.object({
  paymentId: z.coerce.number().int().positive(),
  acknowledge: acknowledgeSchema,
});

const creditSchema = previewSchema.extend({
  ticketId: z.coerce.string().trim().min(1).max(32).optional(),
});

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw throwBadRequestError('paymentId is required; acknowledge is a list of refs');
  return parsed.data;
}

/**
 * Credit a crypto deposit by its NowPayments payment id. GET is always a dry run; POST credits,
 * through the same deposit flow as the webhook, only what the dry run would.
 */
export default ModEndpoint(
  async (req, res, user) => {
    try {
      if (req.method === 'GET') {
        const { paymentId, acknowledge } = parse(previewSchema, req.query);
        return res
          .status(200)
          .json(await previewDepositCredit({ paymentId, acknowledge, modUserId: user.id }));
      }

      const { paymentId, acknowledge, ticketId } = parse(creditSchema, req.body);
      const result = await creditDeposit({ paymentId, acknowledge, ticketId, modUserId: user.id });
      return res.status(result.credited ? 200 : 409).json(result);
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['GET', 'POST']
);
