import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import * as z from 'zod/v4';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useMutateCollection } from '~/components/Collections/collection.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { Redirect } from '~/components/Redirect/Redirect';
import { useDebouncer } from '~/utils/debouncer';

const collectionQueryParamSchema = z.object({
  state: z.preprocess((x) => {
    return x ? (JSON.parse(x as string) as { collectionId: number }) : undefined;
  }, z.object({ collectionId: z.number() })),
  code: z.string(),
});

export default function YoutubeAuthentication() {
  const { query } = useRouter();
  const [success, setSuccess] = useState(false);
  const parsedQuery = collectionQueryParamSchema.safeParse(query);
  const { enableYoutubeSupport, enableYoutubeSupportLoading } = useMutateCollection();
  const debouncer = useDebouncer(1000);

  const enableYoutubeSupportHandler = async () => {
    const data = parsedQuery.data;
    if (!data || enableYoutubeSupportLoading) {
      return;
    }

    try {
      await enableYoutubeSupport({
        collectionId: data.state.collectionId,
        authenticationCode: data.code,
      });

      showSuccessNotification({
        title: 'Success',
        message: 'YouTube support enabled. You can now go back to your collection.',
      });

      setSuccess(true);
    } catch (error) {
      showErrorNotification({
        title: 'There was an error while trying to enable YouTube support',
        error: new Error((error as { message: string })?.message),
      });
    }
  };

  useEffect(() => {
    if (parsedQuery.success && parsedQuery.data) {
      debouncer(() => enableYoutubeSupportHandler());
    }
  }, []);

  if (!parsedQuery.success) {
    return <NotFound />;
  }

  if (success) {
    return <Redirect url={`/collections/${parsedQuery.data.state.collectionId}`} />;
  }

  return <PageLoader />;
}
