import type { NextApiRequest, NextApiResponse } from 'next';

export type CacheSettings = {
  browserTTL?: number;
  edgeTTL?: number;
  staleWhileRevalidate?: number;
  tags?: string[];
  canCache?: boolean;
  skip: boolean;
};

// Use 'any' to avoid circular dependencies while allowing actual types at runtime
// The concrete types will be provided by the actual implementation in createContext.ts
export type Context = {
  user?: any; // SessionUser from next-auth
  acceptableOrigin: boolean;
  features: any; // FeatureAccess from feature-flags.service
  track: any; // Tracker from clickhouse/client
  ip: string;
  cache: CacheSettings | null;
  fingerprint: any; // Fingerprint from utils/fingerprint
  res: NextApiResponse;
  req: NextApiRequest;
  domain: 'green' | 'blue' | 'red';
};
