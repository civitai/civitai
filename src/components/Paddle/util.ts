import { GetByIdStringInput } from '~/server/schema/base.schema';
import { trpc } from '~/utils/trpc';

export const useMutatePaddle = () => {
  const processCompleteBuzzTransactionMutation =
    trpc.paddle.processCompleteBuzzTransaction.useMutation();

  const handleProcessCompleteBuzzTransaction = (data: GetByIdStringInput) => {
    return processCompleteBuzzTransactionMutation.mutateAsync(data);
  };

  return {
    processCompleteBuzzTransaction: handleProcessCompleteBuzzTransaction,
    processingCompleteBuzzTransaction: processCompleteBuzzTransactionMutation.isLoading,
  };
};
