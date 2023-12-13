import React, { useEffect } from 'react';
import { trpc } from '~/utils/trpc';
import {
  Box,
  Button,
  Center,
  Divider,
  Loader,
  Modal,
  Paper,
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
import { IconTrash } from '@tabler/icons-react';
import { GenericImageCard } from '~/components/Cards/GenericImageCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import { ArticleSearchIndexRecord } from '~/server/search-index/articles.search-index';
import { constants } from '~/server/common/constants';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { ModelCard } from '~/components/Cards/ModelCard';

const schema = upsertClubResourceInput;

export const AddResourceToClubModal = () => {
  const utils = trpc.useContext();
  const { upsertClubResource, upsertingResource } = useMutateClub();
  const [resource, setResource] = React.useState<
    ModelSearchIndexRecord | ArticleSearchIndexRecord | null
  >(null);
  const currentUser = useCurrentUser();

  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const handleSuccess = () => {
    utils.club.getPaginatedClubResources.invalidate();
    showSuccessNotification({
      title: 'Resource has been updated',
      message: 'Your resource has been updated correctly.',
    });
    handleClose();
  };

  const form = useForm({
    schema: schema,
  });

  const [entityId, entityType] = form.watch(['entityId', 'entityType']);

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

  const { data: coverImages = [], isLoading: isLoadingCoverImages } =
    trpc.image.getEntitiesCoverImage.useQuery(
      {
        entities: [{ entityId, entityType }],
      },
      {
        enabled: !!entityId && !!entityType,
      }
    );
  const [coverImage] = coverImages;

  const handleSubmit = async (data: z.infer<typeof schema>) => {
    await upsertClubResource({ ...data });
    handleSuccess();
  };

  const renderResourceCoverImage = () => {
    const removeBtn = (
      <Button
        onClick={() => {
          form.reset();
        }}
        style={{
          position: 'absolute',
          top: '-10px',
          left: '-10px',
          width: '30px',
          height: '30px',
          borderRadius: '50%',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        color="red"
        variant="filled"
        radius="xl"
      >
        <IconTrash size={15} />
      </Button>
    );

    if (entityType === 'Article') {
      // Attempt to render it:
      return (
        <Box pos="relative" maw="100%" w={250} m="auto">
          <ArticleCard data={resource as ArticleSearchIndexRecord} />{' '}
        </Box>
      );
    }

    if (entityType === 'ModelVersion') {
      return (
        <Box pos="relative" maw="100%" w={250} m="auto">
          <ModelCard
            // @ts-ignore  ModelSearchIndex should be assignable with no issues.
            data={resource as ModelSearchIndexRecord}
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
        const model = resource as ModelSearchIndexRecord;
        return (
          <Stack spacing="xs">
            <Select
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
            />
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
                  const modelData = data as ModelSearchIndexRecord;
                  setResource(modelData);
                  form.setValue('entityId', modelData.versions[0].id);
                  form.setValue('entityType', 'ModelVersion');
                } else {
                  setResource(data as ArticleSearchIndexRecord);
                  form.setValue('entityId', item.entityId);
                  form.setValue('entityType', item.entityType as SupportedClubEntities);
                }
              }}
              filters={`user.username='${'theally' ?? currentUser.username}'`}
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
          <Button type="submit" loading={upsertingResource}>
            Save
          </Button>
        </Stack>
      </Form>
    </Modal>
  );
};
