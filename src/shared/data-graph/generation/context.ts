export type GenerationCtx = {
  /** User's generation limits based on their tier */
  limits: {
    maxSteps: number;
    maxQuantity: number;
    maxResolution: number;
    maxResources: number;
  };
  /** User information */
  user: {
    isMember: boolean;
    tier: 'free' | 'basic' | 'pro' | 'enterprise';
  };
  resources: { id: number; baseModel: string; modelType: string }[];
  /** Recent ecosystem keys from localStorage (limit 3) */
  recentEcosystems?: string[];
};
