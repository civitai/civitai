import {
  Form,
  InputMultiSelect,
  InputRTE,
  InputSelect,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { SupportedClubEntities, upsertClubEntitySchema } from '~/server/schema/club.schema';
import React, { useEffect } from 'react';
import { z } from 'zod';
import { Box, Button, Center, Group, Input, Loader, Paper, Stack, Text } from '@mantine/core';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { GenericImageCard } from '~/components/Cards/GenericImageCard';
import { Availability } from '@prisma/client';

const schema = upsertClubEntitySchema;

export type ClubPostManageFormProps = {
  entityId?: number;
  entityType?: SupportedClubEntities;
  clubId?: number;
  title?: string;
  onSave: () => void;
  onCancel?: () => void;
};
export const ClubPostManageForm = ({
  entityType: _entityType,
  entityId: _entityId,
  clubId: _clubId,
  title: _title,
}: ClubPostManageFormProps) => {
  const form = useForm({
    schema,
    shouldUnregister: false,
    defaultValues: {
      clubId: _clubId,
      entityId: _entityId,
      entityType: _entityType,
      title: _title,
    },
  });
  const currentUser = useCurrentUser();

  const [entityId, entityType, clubId, privatizeEntity] = form.watch([
    'entityId',
    'entityType',
    'clubId',
    'privatizeEntity',
  ]);
  const { data: userContributingClubs = [], isLoading: isLoadingUserContributingClubs } =
    trpc.club.userContributingClubs.useQuery();
  const { data: tiers = [] } = trpc.club.getTiers.useQuery(
    {
      clubId: clubId as number,
      joinableOnly: false,
      listedOnly: false,
    },
    {
      enabled: !!clubId && !!userContributingClubs?.find((club) => club.id === clubId),
    }
  );
  const { data: clubEntity, isFetching: isFetchingClubEntity } = trpc.club.getClubEntity.useQuery(
    {
      entityType: _entityType as SupportedClubEntities,
      entityId: _entityId as number,
      clubId: clubId as number,
    },
    {
      enabled:
        !!clubId &&
        !!entityType &&
        !!entityType &&
        !!userContributingClubs?.find((club) => club.id === clubId),
    }
  );

  const { data: coverImages = [], isLoading: isLoadingCoverImage } =
    trpc.image.getEntitiesCoverImage.useQuery(
      {
        entities: [
          { entityType: entityType as SupportedClubEntities, entityId: entityId as number },
        ],
      },
      {
        enabled: !!entityId && !!entityType,
      }
    );

  useEffect(() => {
    if (clubEntity && clubEntity.type === 'hasAccess') {
      form.reset({
        ...clubEntity,
        privatizeEntity: clubEntity.availability === Availability.Private,
      });
    }
  }, [clubEntity]);

  const [coverImage] = coverImages;

  const handleSubmit = (data: z.infer<typeof schema>) => {
    console.log(data);
  };

  if (isLoadingUserContributingClubs) {
    return (
      <Center>
        <Loader />
      </Center>
    );
  }

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing="md">
        <Text size="lg" weight={700}>
          {clubEntity ? 'Edit club post' : 'Create club post'}
        </Text>

        <Input.Wrapper label="Resource" labelProps={{ w: '100%' }} withAsterisk>
          {(!_entityId || !_entityType) && (
            <QuickSearchDropdown
              supportedIndexes={['models', 'articles']}
              onItemSelected={(item) => {
                form.setValue('entityId', item.entityId);
                form.setValue('entityType', item.entityType as SupportedClubEntities);
              }}
              filters={`user.username='${currentUser?.username ?? 'lykon'}'`}
              dropdownItemLimit={25}
            />
          )}
          {entityId && entityType && (
            <Box maw={250} m="auto">
              {coverImage ? (
                <GenericImageCard
                  entityType={entityType}
                  entityId={entityId}
                  image={coverImage}
                  disabled
                />
              ) : (
                <Paper withBorder radius="md" p="md" pos="relative">
                  <Stack w="100%" h="100%">
                    <Center>
                      {isLoadingCoverImage ? (
                        <Loader />
                      ) : (
                        <Text align="center">
                          There was a problem loading the cover image. If no cover image on the
                          resource, the post will not have one either.
                        </Text>
                      )}
                    </Center>
                  </Stack>
                </Paper>
              )}
            </Box>
          )}
        </Input.Wrapper>
        <InputSelect
          name="clubId"
          placeholder="Select club to add this resource to"
          label="Select a club"
          nothingFound="No clubs found. Create a club first."
          data={
            userContributingClubs.map((club) => ({
              label: club.name,
              value: club.id,
            })) ?? []
          }
          disabled={isLoadingUserContributingClubs}
          withAsterisk
        />
        {clubId && !isFetchingClubEntity ? (
          <>
            <InputText name="title" label="Title" placeholder="Title" withAsterisk />
            <InputRTE
              name="description"
              label="Short description"
              editorSize="xl"
              includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
              withAsterisk
              stickyToolbar
            />

            <InputSwitch
              name="membersOnly"
              label={
                <Stack spacing={4}>
                  <Group spacing={4}>
                    <Text inline>Members only</Text>
                  </Group>
                  <Text size="xs" color="dimmed">
                    Make this post only available to members of the club. This will not affect the
                    resource itself unless it is private.
                  </Text>
                </Stack>
              }
            />
            <InputSwitch
              name="privatizeEntity"
              label={
                <Stack spacing={4}>
                  <Group spacing={4}>
                    <Text inline>Make resource private</Text>
                  </Group>
                  <Text size="xs" color="dimmed">
                    By making this resource private, only people with access to the club and its
                    tiers will have access to it. The resource will still be visible on your profile
                    and on general feed, but will redirect members to your clubs page.
                  </Text>
                </Stack>
              }
            />

            {privatizeEntity && tiers.length > 0 && (
              <InputMultiSelect
                data={tiers.map((tier) => ({
                  label: tier.name,
                  value: tier.id,
                }))}
                name="tierIds"
                label="Select tiers to add this resource to"
                placeholder="e.g.: Gold silver"
                description="Leave this empty to make resource available to all tiers"
                clearable
                searchable
              />
            )}
          </>
        ) : isFetchingClubEntity ? (
          <Center>
            <Loader />
          </Center>
        ) : null}

        <Button type="submit" fullWidth>
          Save
        </Button>
      </Stack>
    </Form>
  );
};
