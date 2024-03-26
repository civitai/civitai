import React, { useEffect } from 'react';
import { trpc } from '~/utils/trpc';
import {
  Box,
  Button,
  Center,
  Checkbox,
  Divider,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { Form, InputClubResourceManagementInput, useForm } from '~/libs/form';
import { SupportedClubEntities, upsertClubResourceInput } from '~/server/schema/club.schema';
import { z } from 'zod';
import { useMutateClub } from '~/components/Club/club.utils';
import { showSuccessNotification } from '~/utils/notifications';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { ClubPostUpsertFormModal } from './ClubPost/ClubPostUpsertForm';
import { dialogStore } from '../Dialog/dialogStore';
import { SearchIndexDataMap } from '~/components/Search/search.utils2';

const schema = upsertClubResourceInput;

type Props = {
  resource?: SearchIndexDataMap['models'] | SearchIndexDataMap['articles'];
  entityType?: SupportedClubEntities;
  entityId?: number;
  clubId?: number;
};

export const AddResourceToClubModal = ({ clubId, ...props }: Props) => {
  const utils = trpc.useContext();
  const { upsertClubResource, upsertingResource } = useMutateClub();
  const [resource, setResource] = React.useState<
    SearchIndexDataMap['models'] | SearchIndexDataMap['articles'] | null
  >(props?.resource ?? null);
  const currentUser = useCurrentUser();
  const [createClubPost, setCreateClubPost] = React.useState<boolean>(true);

  const dialog = useDialogContext();
  const handleClose = dialog.onClose;

  const form = useForm({
    schema: schema,
  });

  const [entityId, entityType] = form.watch(['entityId', 'entityType']);

  const handleSuccess = () => {
    utils.club.getPaginatedClubResources.invalidate();
    showSuccessNotification({
      title: 'Resource has been updated',
      message: 'Your resource has been updated correctly.',
    });

    handleClose();

    if (createClubPost && clubId) {
      dialogStore.trigger({
        component: ClubPostUpsertFormModal,
        props: {
          clubId,
          resource: {
            entityType,
            entityId,
          },
        },
      });
    }
  };

  const { data: resourceDetails, isLoading: isLoadingResourceDetails } =
    trpc.club.resourceDetails.useQuery(
      {
        entityId: entityId as number,
        entityType: entityType as SupportedClubEntities,
      },
      {
        enabled: !!entityId && !!entityType,
      }
    );

  const handleSubmit = async (data: z.infer<typeof schema>) => {
    await upsertClubResource({ ...data });
    handleSuccess();
  };

  const renderResourceCoverImage = () => {
    if (entityType === 'Article') {
      // Attempt to render it:
      return (
        <Box pos="relative" maw="100%" w={250} m="auto" style={{ pointerEvents: 'none' }}>
          <ArticleCard data={resource as any} />{' '}
        </Box>
      );
    }

    if (entityType === 'ModelVersion') {
      const data = resource as any;
      return (
        <Box pos="relative" maw="100%" w={250} m="auto" style={{ pointerEvents: 'none' }}>
          <ModelCard
            // @ts-ignore This works for the search view so no reason it won't work here.
            data={data}
          />
        </Box>
      );
    }
  };

  const renderResourceDetails = () => {
    if (!resource) {
      return null;
    }

    switch (entityType) {
      case 'ModelVersion': {
        const model = resource as any;
        if (!entityId) {
          return null;
        }

        return (
          <Stack spacing="xs">
            {/* <Select
              label="Select model version"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              value={entityId.toString()}
              data={model.versions.map((version) => ({
                label: version.name,
                value: version.id.toString(),
              }))}
              onChange={(id) => {
                if (!id) {
                  form.reset();
                  return;
                }
                form.setValue('entityId', parseInt(id, 10));
              }}
            /> */}
          </Stack>
        );
      }
      default: {
        return null;
      }
    }
  };

  useEffect(() => {
    if (resourceDetails) {
      form.setValue('clubs', resourceDetails.clubs ?? []);
    }
  }, [resourceDetails]);

  useEffect(() => {
    if (props.entityType && props.entityId) {
      form.setValue('entityId', props.entityId);
      form.setValue('entityType', props.entityType);
    }
  }, [props]);

  return (
    <Modal {...dialog} size="md" withCloseButton title="Add resource to a club">
      <Divider mx="-lg" mb="md" />
      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          {currentUser?.username && (
            <QuickSearchDropdown
              // Match SupportedClubEntities here.
              supportedIndexes={['models', 'articles']}
              onItemSelected={(item, data) => {
                if (item.entityType === 'Model') {
                  const modelData = data as any;
                  setResource(modelData);
                  form.setValue('entityId', modelData.versions[0].id);
                  form.setValue('entityType', 'ModelVersion');
                } else {
                  setResource(data as any);
                  form.setValue('entityId', item.entityId);
                  form.setValue('entityType', item.entityType as SupportedClubEntities);
                }
              }}
              filters={`user.username='${currentUser.username}'`}
              dropdownItemLimit={25}
            />
          )}

          {entityId && entityType && <>{renderResourceCoverImage()}</>}
          {resource && <>{renderResourceDetails()}</>}

          {entityId && entityType && isLoadingResourceDetails && (
            <Center>
              <Loader variant="bars" />
            </Center>
          )}

          {entityId && entityType && !isLoadingResourceDetails && (
            <InputClubResourceManagementInput name="clubs" />
          )}
          {clubId && (
            <Stack spacing="sm">
              <Divider mx="-lg" mb="md" />
              <Checkbox
                checked={createClubPost}
                onChange={() => {
                  setCreateClubPost(!createClubPost);
                }}
                label={<Text>Also create Club Feed post</Text>}
              />
            </Stack>
          )}
          <Button type="submit" loading={upsertingResource} disabled={!resource}>
            Save
          </Button>
        </Stack>
      </Form>
    </Modal>
  );
};
