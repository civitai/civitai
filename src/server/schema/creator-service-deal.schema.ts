import { z } from 'zod';
import { NO_SERVICE_LICENSE } from '~/shared/constants/creator-service-license.constants';
import { ServiceLicensePreset } from '~/shared/utils/prisma/enums';
import {
  SERVICE_DEAL_CANCELLATION_REASON_CODES,
  SERVICE_DEAL_DECLINE_REASON_CODES,
  SERVICE_DEAL_DISPUTE_REASON_CODES,
} from '~/shared/constants/creator-services.constants';

const dealId = z.object({ id: z.number().int().positive() });
const text = (max: number) => z.string().trim().min(1).max(max);

/** A reason is free text, a code from the action's list, or both. */
const reasonGiven = (input: { reason?: string; reasonCode?: string }) =>
  !!input.reason || !!input.reasonCode;
const REASON_REQUIRED = { message: 'Give a reason', path: ['reason'] };

export const requestServiceDealSchema = z.object({
  offeringId: z.number().int().positive(),
  /** The terms the buyer was shown; a request on any other terms is refused. */
  expectedPrice: z.number().int().positive(),
  expectedRevisionsIncluded: z.number().int().min(0),
  expectedDeliveryDays: z.number().int().positive(),
  /** The license the buyer was shown; a null preset when the offering had none. */
  expectedLicense: z
    .object({
      licensePreset: z.enum(ServiceLicensePreset).nullable(),
      licenseCustomText: z.string().nullable(),
      licenseAllowResale: z.boolean(),
    })
    .default(NO_SERVICE_LICENSE),
  /** The license checkbox; required when the offering has a license. */
  licenseAgreed: z.boolean().default(false),
  requestText: text(5000),
  /** The buyer-disclosure version the buyer was shown; the service refuses a request without the current one. */
  disclosureVersion: z.string(),
  /**
   * Which disclosure the buyer was shown: with reviews or without. Must match the deal's. Optional so
   * an old page that sends none gets the service's terms refusal, not a validation error.
   */
  disclosureReviewEnabled: z.boolean().optional(),
});

export const getServiceDealSchema = dealId;

export const listMyServiceDealsSchema = z.object({
  role: z.enum(['buyer', 'seller']),
  status: z.enum(['open', 'closed']).optional(),
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const serviceDealActionSchema = dealId;
export const reviewServiceDealSchema = dealId.extend({
  verdict: z.enum(['Happy', 'NotQuite']),
  comment: text(2000).optional(),
});
export const editServiceDealReviewSchema = dealId.extend({ comment: text(2000).optional() });
export const replyServiceDealReviewSchema = dealId.extend({ reply: text(2000) });
export const attachServiceDealReviewImageSchema = dealId.extend({
  fileId: z.number().int().positive(),
});
export const hideServiceDealReviewSchema = z.object({
  reviewId: z.number().int().positive(),
  hidden: z.boolean(),
});
export const declineServiceDealSchema = dealId.extend({
  reason: text(1000).optional(),
  reasonCode: z.enum(SERVICE_DEAL_DECLINE_REASON_CODES).optional(),
});
export const requestServiceDealRevisionSchema = dealId.extend({ comment: text(2000) });
export const requestServiceDealCancellationSchema = dealId
  .extend({
    reason: text(1000).optional(),
    reasonCode: z.enum(SERVICE_DEAL_CANCELLATION_REASON_CODES).optional(),
  })
  .refine(reasonGiven, REASON_REQUIRED);
export const respondServiceDealCancellationSchema = dealId.extend({
  agree: z.boolean(),
  comment: text(1000).optional(),
});
export const openServiceDealDisputeSchema = dealId
  .extend({
    reason: text(2000).optional(),
    reasonCode: z.enum(SERVICE_DEAL_DISPUTE_REASON_CODES).optional(),
  })
  .refine(reasonGiven, REASON_REQUIRED);

const dealFileDealId = z.object({ dealId: z.number().int().positive() });
export const requestServiceDealUploadSchema = dealFileDealId.extend({
  kind: z.enum(['Preview', 'Final']),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
});
/** Both attestations must be given in the attach step; the server refuses an upload without them. */
export const requestServiceDealAttachmentSchema = dealFileDealId.extend({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
  rightsAttested: z.literal(true),
  likenessAttested: z.literal(true),
});
export const serviceDealFilesSchema = dealFileDealId;
export const serviceDealFileActionSchema = z.object({ fileId: z.number().int().positive() });
