import * as z from 'zod';
import {
  SERVICE_DELIVERY_DAYS_MAX,
  SERVICE_DELIVERY_DAYS_MIN,
  SERVICE_DESCRIPTION_MAX,
  SERVICE_OPEN_DEALS_MAX,
  SERVICE_OPEN_DEALS_MIN,
  SERVICE_PRICE_MAX,
  SERVICE_PRICE_MIN,
  SERVICE_REVISIONS_MAX,
  SERVICE_TITLE_MAX,
  SERVICE_TITLE_MIN,
} from '~/shared/constants/creator-service.constants';
import { ServicePreviewKind } from '~/shared/utils/prisma/enums';

export type UpsertServiceOfferingInput = z.infer<typeof upsertServiceOfferingSchema>;
export const upsertServiceOfferingSchema = z.object({
  id: z.number().int().positive().optional(),
  title: z.string().trim().min(SERVICE_TITLE_MIN).max(SERVICE_TITLE_MAX),
  description: z.string().trim().min(1).max(SERVICE_DESCRIPTION_MAX),
  price: z.number().int().min(SERVICE_PRICE_MIN).max(SERVICE_PRICE_MAX),
  deliveryDays: z.number().int().min(SERVICE_DELIVERY_DAYS_MIN).max(SERVICE_DELIVERY_DAYS_MAX),
  revisionsIncluded: z.number().int().min(0).max(SERVICE_REVISIONS_MAX),
  maxOpenDeals: z.number().int().min(SERVICE_OPEN_DEALS_MIN).max(SERVICE_OPEN_DEALS_MAX),
  previewKind: z.enum(ServicePreviewKind),
  // Saves as a draft unless set; publishing goes through the same sell gate as activating.
  publish: z.boolean().default(false),
});

// Removed is a separate verb (`removeOffering`); Draft is never re-entered.
export const serviceOfferingSettableStatuses = ['Active', 'Paused'] as const;
export type SetServiceOfferingStatusInput = z.infer<typeof setServiceOfferingStatusSchema>;
export const setServiceOfferingStatusSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(serviceOfferingSettableStatuses),
});

export type GetShopServiceOfferingsInput = z.infer<typeof getShopServiceOfferingsSchema>;
export const getShopServiceOfferingsSchema = z.object({ userId: z.number().int().positive() });
