import { Button } from '@mantine/core';
import { IconFolders, IconPlus } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NoContent } from '~/components/NoContent/NoContent';

const CollectionEditModal = dynamic(() => import('~/components/Collections/CollectionEditModal'));

const WHAT_ARE_COLLECTIONS =
  'Collections let you save models, images, posts and articles into lists you can organize and share with others.';

export function CollectionsLanding({
  signedIn,
  hasCollections,
}: {
  signedIn: boolean;
  hasCollections: boolean;
}) {
  const isMobile = useContainerSmallerThan('sm');

  const props = !signedIn
    ? { title: 'Collections', message: WHAT_ARE_COLLECTIONS }
    : hasCollections
    ? {
        title: 'Pick a collection',
        message: isMobile
          ? 'Tap the Collections button above to choose one.'
          : 'Choose one from the list on the left to view it.',
      }
    : { title: 'No collections yet', message: WHAT_ARE_COLLECTIONS };

  return (
    <NoContent
      {...props}
      icon={<IconFolders size={80} />}
      iconSize={128}
      py="xl"
      maw={500}
      mx="auto"
    >
      {signedIn ? (
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => dialogStore.trigger({ component: CollectionEditModal })}
        >
          Create collection
        </Button>
      ) : (
        <LoginRedirect reason="perform-action" returnUrl="/collections">
          <Button>Sign in</Button>
        </LoginRedirect>
      )}
    </NoContent>
  );
}
