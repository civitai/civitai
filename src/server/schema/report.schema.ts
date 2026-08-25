import * as z from 'zod';
import { MAX_APPEAL_MESSAGE_LENGTH } from '~/server/common/constants';
import { ExternalModerationType } from '~/server/common/enums';
import { AppealStatus, EntityType, ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';

// #region [report reason detail schemas]
const baseDetailSchema = z.object({ comment: z.string().optional() });

export const reportNsfwDetailsSchema = baseDetailSchema.extend({
  tags: z.string().array().optional(),
});

export const reportOwnershipDetailsSchema = baseDetailSchema.extend({
  name: z.string(),
  email: z.string().email(),
  phone: z.string().optional(),
  images: z.string().array(),
  establishInterest: z.boolean().optional(),
});

/**
 * The violations the TOS report form offers, in display order.
 *
 * Here rather than in the form because the rule below keys on one of these strings: with the list in
 * the component, "require a comment on real-person reports" would be a literal duplicated across a
 * component and a schema, and renaming the option in one place would silently switch the rule off.
 */
export const TOS_VIOLATIONS = [
  'Depiction of real-person likeness',
  'Graphic violence',
  'False impersonation',
  'Deceptive content',
  'Sale of illegal substances',
  'Child abuse and exploitation',
  'Photorealistic depiction of a minor',
  'Prohibited concepts',
] as const;

export const REAL_PERSON_VIOLATION = TOS_VIOLATIONS[0];

export const reportTosViolationDetailsSchema = baseDetailSchema
  .extend({
    violation: z.string(),
  })
  // A real-person report with no comment names nobody, and a moderator cannot act on "this is someone
  // real" — they need who. Enforced here, not only in the form, because the form is not the only way
  // this shape arrives.
  .superRefine((details, ctx) => {
    if (details.violation === REAL_PERSON_VIOLATION && !details.comment?.trim())
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['comment'],
        message: 'Tell us who this depicts — a name, a profile, or how you recognise them.',
      });
  });

export const reportClaimDetailsSchema = baseDetailSchema.extend({
  email: z.string().email(),
});

export const reportAdminAttentionDetailsSchema = baseDetailSchema.extend({
  reason: z.string(),
});

export const reportSpamDetailsSchema = baseDetailSchema;

/**
 * A sticker someone paid to place on this image.
 *
 * `placementId` is required, not optional. An image can carry several
 * placements, and a report that does not say which one leaves a moderator
 * guessing — or removing the wrong person's sticker, which costs them money.
 */
export const reportStickerPlacementDetailsSchema = baseDetailSchema.extend({
  // Coerced, because a radio group hands back a string and there is nothing on
  // the form path that converts it. `z.number()` typechecks clean here — `Radio`
  // takes `string | number` — and then rejects at submit, so the report can be
  // filled in and never sent.
  // The message matters: with no placements on the image the field renders with
  // no options, and `z.coerce.number()` on an absent value is `Number(undefined)`
  // — NaN — so the default text reads "expected number, received NaN" at the one
  // moment a reporter needs to be told what to do.
  placementId: z.coerce
    .number({ error: 'Choose which sticker you are reporting.' })
    .int()
    .positive(),
  /**
   * Which half of the placement is being reported.
   *
   * A sticker and the note attached to it are separately objectionable — the
   * artwork can be fine and the note abusive, which is the griefing case Ellie
   * raised — and a moderator needs to know which one they are being sent to
   * look at, because the remedies differ: the owner can hide a note without the
   * sticker coming off.
   *
   * Carried in the details rather than as its own `ReportReason` so this needs
   * no enum migration, and so both reports still land on the image with the
   * same placement id a moderator acts on.
   */
  target: z.enum(['sticker', 'comment']).default('sticker'),
});

export const reportAutomatedDetailsSchema = baseDetailSchema.extend({
  /** The scanner's own job id. Absent when the flag came from a list we hold ourselves. */
  externalId: z.string().optional(),
  externalType: z.enum(ExternalModerationType),
  entityId: z.number(),
  tags: z.array(z.string()),
  // tags: z.array(
  //   z.object({
  //     tag: z.string(),
  //     confidence: z.number(),
  //     outcome: z.string(), // z.enum(Outcome), // but this causes errors
  //     message: z.string().optional(),
  //   })
  // ),
  userId: z.number(),
  value: z.string().optional(),
});
// #endregion

// #region [report reason schemas]
const baseSchema = z.object({
  type: z.enum(ReportEntity),
  id: z.number(),
  details: baseDetailSchema.default({}),
});

export const reportNsfwSchema = baseSchema.extend({
  reason: z.literal(ReportReason.NSFW),
  details: reportNsfwDetailsSchema,
});

export const reportTOSViolationSchema = baseSchema.extend({
  reason: z.literal(ReportReason.TOSViolation),
  details: reportTosViolationDetailsSchema,
});

export const reportOwnershipSchema = baseSchema.extend({
  reason: z.literal(ReportReason.Ownership),
  details: reportOwnershipDetailsSchema,
});

export const reportClaimSchema = baseSchema.extend({
  reason: z.literal(ReportReason.Claim),
  details: reportClaimDetailsSchema,
});

export const reportAdminAttentionSchema = baseSchema.extend({
  reason: z.literal(ReportReason.AdminAttention),
  details: reportAdminAttentionDetailsSchema,
});

export const reportCsamSchema = baseSchema.extend({
  reason: z.literal(ReportReason.CSAM),
});

export const reportSpamSchema = baseSchema.extend({
  reason: z.literal(ReportReason.Spam),
});

export const reportAutomatedSchema = baseSchema.extend({
  reason: z.literal(ReportReason.Automated),
  details: reportAutomatedDetailsSchema,
});

export const reportStickerPlacementSchema = baseSchema.extend({
  reason: z.literal(ReportReason.StickerPlacement),
  details: reportStickerPlacementDetailsSchema,
});

// #endregion

export type CreateReportInput = z.infer<typeof createReportInputSchema>;
export const createReportInputSchema = z.discriminatedUnion('reason', [
  reportNsfwSchema,
  reportTOSViolationSchema,
  reportOwnershipSchema,
  reportClaimSchema,
  reportAdminAttentionSchema,
  reportCsamSchema,
  reportAutomatedSchema,
  reportSpamSchema,
  reportStickerPlacementSchema,
]);

export type GetReportCountInput = z.infer<typeof getReportCount>;
export const getReportCount = z.object({
  type: z.enum(ReportEntity),
  statuses: z.enum(ReportStatus).array(),
});

export type CreateEntityAppealInput = z.output<typeof createEntityAppealSchema>;
export const createEntityAppealSchema = z.object({
  entityId: z.number(),
  entityType: z.enum(EntityType),
  message: z.string().trim().min(1).max(MAX_APPEAL_MESSAGE_LENGTH),
});

export type GetRecentAppealsInput = z.output<typeof getRecentAppealsSchema>;
export const getRecentAppealsSchema = z.object({
  userId: z.number().optional(),
  startDate: z.date().optional(),
});

export type GetAppealDetailsInput = z.output<typeof getAppealDetailsSchema>;
export const getAppealDetailsSchema = z.object({
  entityId: z.number(),
  entityType: z.enum(EntityType),
  userId: z.number(),
});

export type ResolveAppealInput = z.output<typeof resolveAppealSchema>;
export const resolveAppealSchema = z.object({
  ids: z.number().array().min(1),
  entityType: z.enum(EntityType),
  status: z.enum(AppealStatus),
  resolvedMessage: z.string().trim().max(MAX_APPEAL_MESSAGE_LENGTH).optional(),
  internalNotes: z.string().trim().optional(),
  refundBuzz: z.boolean().optional(),
});
