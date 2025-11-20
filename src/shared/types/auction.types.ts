import type { AuctionType } from '~/shared/utils/prisma/enums';

// Minimal auction base interface for shared utilities
export interface AuctionBaseInfo {
  ecosystem: string | null;
  type?: AuctionType;
}
