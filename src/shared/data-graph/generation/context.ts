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
};
