import { useRouter } from 'next/router';
import { trpc } from '~/utils/trpc';
import { CreateBuzzSessionInput } from '~/server/schema/stripe.schema';
import { getClientStripe } from '~/utils/get-client-stripe';
import { showErrorNotification } from '~/utils/notifications';

export const useQueryBuzzPackages = () => {
  const router = useRouter();

  const { data: packages = [], isLoading } = trpc.stripe.getBuzzPackages.useQuery();
  const createBuzzSessionMutation = trpc.stripe.createBuzzSession.useMutation({
    onSuccess: async ({ url, sessionId }) => {
      if (url) await router.push(url);
      else {
        const stripe = await getClientStripe();
        await stripe.redirectToCheckout({ sessionId });
      }
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Could not process purchase',
        error: new Error(error.message),
      });
    },
  });

  const createBuyingSession = (data: CreateBuzzSessionInput) => {
    return createBuzzSessionMutation.mutateAsync(data);
  };

  return {
    packages,
    isLoading,
    createBuyingSession,
    creatingSession: createBuzzSessionMutation.isLoading,
  };
};
