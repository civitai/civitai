import { z } from 'zod';
import { TipaltiStatus } from '~/server/common/enums';

export namespace Tipalti {
  export type CreatePayeeInput = z.infer<typeof createPayeeInput>;
  export const createPayeeInput = z.object({
    refCode: z.string(),
    preferredPayerEntityId: z.string().optional(),
    entityType: z.enum(['INDIVIDUAL', 'COMPANY']),
    contactInformation: z
      .object({
        // They support a bunch of other fields, but we only need email
        email: z.string(),
      })
      .optional(),
    customFieldValues: z
      .array(
        z.object({ customFieldId: z.string(), valuesIds: z.array(z.string()), value: z.string() })
      )
      .optional(),
  });

  export const createPayeeResponseSchema = z.object({
    id: z.string(),
    refCode: z.string().optional(),
    status: z.nativeEnum(TipaltiStatus),
    statusChangeDateTimeUTC: z.string().optional(),
    statusReason: z.string().optional(),
    isAccountClosed: z.boolean().optional(),
    isPayable: z.boolean().optional(),
    lastChangeDateTimeUTC: z.string().optional(),
  });

  export const createPayeeInvitationResponseSchema = z.object({
    payeeId: z.string(),
    sentTime: z.string(),
    status: z.string(),
  });
}
