import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { pluralize } from '~/shared/utils/pluralize';
import type { RouterOutput } from '~/types/router';

export type ServiceOffering = RouterOutput['creatorService']['getMine']['items'][number];

export { pluralize };

export function serviceTermsLine(
  offering: Pick<ServiceOffering, 'deliveryDays' | 'revisionsIncluded'>
) {
  return `Delivered in ~${pluralize(offering.deliveryDays, 'day')} · ${pluralize(
    offering.revisionsIncluded,
    'revision'
  )} included`;
}

export function useQueryShopServices(userId: number, enabled: boolean) {
  const { data, isLoading } = trpc.creatorService.getForShop.useQuery({ userId }, { enabled });
  return { offerings: data ?? [], isLoading };
}

export function useQueryMyServices(enabled: boolean) {
  const eligibility = trpc.creatorService.getSellEligibility.useQuery(undefined, { enabled });
  const mine = trpc.creatorService.getMine.useQuery(undefined, { enabled });
  return {
    eligibility: eligibility.data,
    offerings: mine.data?.items ?? [],
    hiddenOffDomain: mine.data?.hiddenOffDomain ?? 0,
    isLoading: eligibility.isLoading || mine.isLoading,
  };
}

export function useMutateMyServices() {
  const utils = trpc.useUtils();
  const onSuccess = () => utils.creatorService.invalidate();
  const onError = (error: { message: string }) =>
    showErrorNotification({ title: 'Could not update service', error });

  const upsert = trpc.creatorService.upsert.useMutation({
    onSuccess: async (_, input) => {
      await onSuccess();
      showSuccessNotification({ message: input.publish ? 'Service published' : 'Draft saved' });
    },
    onError,
  });
  const setStatus = trpc.creatorService.setStatus.useMutation({ onSuccess, onError });
  const remove = trpc.creatorService.remove.useMutation({ onSuccess, onError });

  return { upsert, setStatus, remove };
}
