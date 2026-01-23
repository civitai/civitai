import { vi } from 'vitest';

// Mock buzz service
export const mockCreateBuzzTransaction = vi.fn().mockResolvedValue({ success: true });
export const mockCreateBuzzTransactionMany = vi.fn().mockResolvedValue({ success: true });

// Mock cosmetics service
export const mockDeliverMonthlyCosmetics = vi.fn().mockResolvedValue(undefined);

// Reset all mocks between tests
export const resetAllServiceMocks = () => {
  mockCreateBuzzTransaction.mockClear();
  mockCreateBuzzTransactionMany.mockClear();
  mockDeliverMonthlyCosmetics.mockClear();
};
