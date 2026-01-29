import { ResourceData } from '~/components/generation_v2/inputs/ResourceDataProvider';

export type GenerationCtx = {
  /** User's generation limits based on their tier */
  limits: {
    maxQuantity: number;
    maxResources: number;
  };
  /** User information */
  user: {
    isMember: boolean;
    tier: 'free' | 'founder' | 'bronze' | 'silver' | 'gold';
  };
  /** All fetched resources from ResourceDataProvider */
  resources?: ResourceData[];
};
