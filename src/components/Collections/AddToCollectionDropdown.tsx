import {
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  createStyles,
  Popover,
  UnstyledButton,
  Box,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { CollectionContributorPermission, CollectionType } from '@prisma/client';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { AddCollectionItemInput } from '~/server/schema/collection.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { collectionReadPrivacyData } from './collection.utils';
import { openContext } from '~/providers/CustomModalsProvider';

type Props = Partial<AddCollectionItemInput>;

const useCollectionListStyles = createStyles((theme) => ({
  body: { alignItems: 'center', paddingTop: theme.spacing.xs, paddingBottom: theme.spacing.xs },
  labelWrapper: { flex: 1 },
}));

export function AddToCollectionDropdown({
  dropdownTrigger,
  ...props
}: Props & { onNewClick?: VoidFunction; dropdownTrigger: React.ReactNode }) {
  const [opened, setOpened] = useState(false);

  return (
    <Box onClick={(e) => e.stopPropagation()}>
      <Popover opened={opened} onChange={setOpened} withArrow withinPortal>
        <Popover.Target>
          <UnstyledButton
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpened((o) => !o);
            }}
          >
            {dropdownTrigger}
          </UnstyledButton>
        </Popover.Target>
        <Popover.Dropdown>
          <Dropdown {...props} onClose={() => setOpened(false)} />
        </Popover.Dropdown>
      </Popover>
    </Box>
  );
}
export function Dropdown({
  onNewClick,
  onClose,
  note,
  ...props
}: Props & { onNewClick?: VoidFunction; onClose: VoidFunction }) {
  const { classes } = useCollectionListStyles();
  const queryUtils = trpc.useContext();

  const { data: collections = [], isLoading: loadingCollections } =
    trpc.collection.getAllUser.useQuery({
      permissions: [
        CollectionContributorPermission.ADD,
        CollectionContributorPermission.ADD_REVIEW,
        CollectionContributorPermission.MANAGE,
      ],
      type: props.type,
    });

  const { data: collectionItems = [], isLoading: loadingStatus } =
    trpc.collection.getUserCollectionItemsByItem.useQuery({
      ...props,
    });

  // Ensures we don't present the user with a list of collections
  // before both things have loaded.
  const isLoading = loadingStatus || loadingCollections;

  const ownedCollections = collections.filter((collection) => collection.isOwner);
  const contributingCollections = collections.filter((collection) => !collection.isOwner);

  const addCollectionItemMutation = trpc.collection.saveItem.useMutation();
  const onToggle = (collectionId: number) => {
    const isOnCollection = collectionItems.find(
      (collectionItem) => collectionItem.collectionId === collectionId
    );

    addCollectionItemMutation.mutate(
      {
        ...props,
        collectionIds: isOnCollection ? [] : [collectionId],
        removeFromCollectionIds: isOnCollection ? [collectionId] : [],
      },
      {
        async onSuccess(_, { type }) {
          showNotification({
            title: 'Item added',
            message: isOnCollection
              ? 'Your item has been removed from the selected collection.'
              : 'Your item has been added to the selected collection.',
          });

          await queryUtils.collection.getUserCollectionItemsByItem.invalidate();
        },
        onError(error) {
          showErrorNotification({
            title: 'Unable to toggle item',
            error: new Error(error.message),
          });
        },
      }
    );
  };

  return (
    <Stack spacing="xl">
      <Stack spacing={4}>
        <Group spacing="xs" position="apart" noWrap>
          <Text size="sm" weight="bold">
            Your collections
          </Text>
          <Button
            variant="subtle"
            size="xs"
            leftIcon={<IconPlus size={16} />}
            onClick={() => {
              openContext('addToCollection', {
                ...props,
                createNew: true,
              });

              onClose();
            }}
            compact
          >
            New collection
          </Button>
        </Group>
        {isLoading ? (
          <Center py="xl">
            <Loader variant="bars" />
          </Center>
        ) : (
          <>
            <ScrollArea.Autosize maxHeight={200}>
              {ownedCollections.length > 0 ? (
                <>
                  {ownedCollections.map((collection) => {
                    const Icon = collectionReadPrivacyData[collection.read].icon;
                    const isOnCollection = collectionItems.find(
                      (ci) => ci.collectionId === collection.id
                    );

                    return (
                      <Checkbox
                        key={collection.id}
                        classNames={classes}
                        value={collection.id.toString()}
                        disabled={addCollectionItemMutation.isLoading}
                        checked={!!isOnCollection}
                        onChange={(e) => {
                          e.preventDefault();
                          onToggle(collection.id);
                        }}
                        label={
                          <Group spacing="xs" position="apart" w="100%" noWrap>
                            <Text lineClamp={1} inherit>
                              {collection.name}
                            </Text>
                            <Icon size={18} />
                          </Group>
                        }
                      />
                    );
                  })}
                </>
              ) : (
                <Center py="xl">
                  <Text color="dimmed">{`You don't have any ${
                    props.type?.toLowerCase() || ''
                  } collections yet.`}</Text>
                </Center>
              )}
            </ScrollArea.Autosize>
            {contributingCollections.length > 0 && (
              <Stack>
                <Text size="sm" weight="bold">
                  Collections you contribute in
                </Text>
                <ScrollArea.Autosize maxHeight={200}>
                  <Stack>
                    {contributingCollections.map((collection) => {
                      const collectionItem = collectionItems.find(
                        (item) => item.collectionId === collection.id
                      );
                      const Icon = collectionReadPrivacyData[collection.read].icon;

                      return (
                        <Checkbox
                          key={collection.id}
                          classNames={classes}
                          checked={!!collectionItem}
                          onChange={(e) => {
                            e.preventDefault();
                            onToggle(collection.id);
                          }}
                          disabled={
                            (collectionItem && !collectionItem.canRemoveItem) ||
                            addCollectionItemMutation.isLoading
                          }
                          label={
                            <Group spacing="xs" position="apart" w="100%" noWrap>
                              <Text lineClamp={1} inherit>
                                {collection.name}
                              </Text>
                              <Icon size={18} />
                            </Group>
                          }
                        />
                      );
                    })}
                  </Stack>
                </ScrollArea.Autosize>
                {addCollectionItemMutation.isLoading && <Text>Saving&hellip;</Text>}
              </Stack>
            )}
          </>
        )}
      </Stack>
    </Stack>
  );
}
