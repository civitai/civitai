import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import * as zkp2pService from '~/server/services/zkp2p.service';

export type CreateBuzzChargeZkp2p = z.infer<typeof createBuzzChargeZkp2pSchema>;

const createBuzzChargeZkp2pSchema = z.object({
  buzzAmount: z.number().min(1),
  unitAmount: z.number().min(1),
  userId: z.number(),
});

export const createBuzzOrderZkp2pHandler = async (input: CreateBuzzChargeZkp2p) => {
  try {
    return await zkp2pService.createBuzzOrderOnramp(input);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Failed to create ZKP2P buzz order: ${errorMessage}`,
    });
  }
};

export const getTransactionStatusByKeyHandler = async ({
  userId,
  key,
}: {
  userId: number;
  key: string;
}) => {
  try {
    return await zkp2pService.getTransactionStatusByKey({ userId, key });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Failed to get transaction status: ${errorMessage}`,
    });
  }
};
