import { Anchor, Button, Container, Group, Stack, Stepper, Text, Title } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconAlertTriangle, IconArrowLeft } from '@tabler/icons';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

import { PostEditWrapper } from '~/components/Post/Edit/PostEditLayout';
import { Files } from '~/components/Resource/Files';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { ModelById } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

import { PostUpsertForm } from '../Forms/PostUpsertForm';

export function ModelVersionWizard({ data }: Props) {
  const router = useRouter();

  const { id, versionId, step = '1' } = router.query;
  const isNew = router.pathname.includes('/create');
  const parsedStep = Array.isArray(step) ? Number(step[0]) : Number(step);

  const [activeStep, setActiveStep] = useState<number>(parsedStep);

  const { data: modelVersion } = trpc.modelVersion.getById.useQuery(
    { id: Number(versionId), withFiles: true },
    {
      enabled: !!versionId,
      placeholderData: {
        model: { ...data },
      },
    }
  );

  const goNext = () => {
    if (activeStep < 3)
      router.replace(
        `/models/${id}/model-versions/${versionId}/wizard?step=${activeStep + 1}`,
        undefined,
        { shallow: true }
      );
  };

  const goBack = () => {
    if (activeStep > 1)
      router.replace(
        `/models/${id}/model-versions/${versionId}/wizard?step=${activeStep - 1}`,
        undefined,
        { shallow: true }
      );
  };

  const hasFiles = modelVersion && !!modelVersion.files?.length;

  useEffect(() => {
    // redirect to correct step if missing values
    if (!isNew) {
      if (!hasFiles)
        router.replace(`/models/${id}/model-versions/${versionId}/wizard?step=2`, undefined, {
          shallow: true,
        });
      else
        router.replace(`/models/${id}/model-versions/${versionId}/wizard?step=3`, undefined, {
          shallow: true,
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFiles, id, isNew, versionId]);

  useEffect(() => {
    // set current step based on query param
    if (activeStep.toString() !== router.query.step) {
      const rawStep = router.query.step;
      const step = Number(rawStep);
      const validStep = isNumber(step) && step >= 1 && step <= 3;

      setActiveStep(validStep ? step : 1);
    }
  }, [router.query, activeStep]);

  const editing = !!modelVersion?.id;
  const postId = modelVersion?.posts?.[0]?.id;

  return (
    <Container size="sm">
      <Stack spacing="xl" py="xl">
        <Link href={`/models/${modelVersion?.model.id}`} passHref legacyBehavior>
          <Anchor size="xs">
            <Group spacing={4} noWrap>
              <IconArrowLeft size={12} />
              <Text inherit>Back to {modelVersion?.model.name} page</Text>
            </Group>
          </Anchor>
        </Link>
        <Stepper
          active={activeStep - 1}
          onStepClick={(step) =>
            router.replace(
              `/models/${modelVersion?.model.id}/model-versions/${versionId}/wizard?step=${
                step + 1
              }`
            )
          }
          allowNextStepsSelect={false}
          size="sm"
        >
          <Stepper.Step label={editing ? 'Edit version' : 'Add version'}>
            <Stack>
              <Title order={3}>{editing ? 'Edit version' : 'Add version'}</Title>
              <ModelVersionUpsertForm
                model={modelVersion?.model}
                version={modelVersion}
                onSubmit={(result) => {
                  if (editing) return goNext();
                  router.replace(
                    `/models/${result?.modelId}/model-versions/${result?.id}/wizard?step=2`
                  );
                }}
              >
                {({ loading }) => (
                  <Group mt="xl" position="right">
                    <Button type="submit" loading={loading}>
                      Next
                    </Button>
                  </Group>
                )}
              </ModelVersionUpsertForm>
            </Stack>
          </Stepper.Step>
          <Stepper.Step label="Upload files">
            <Stack spacing="xl">
              <Title order={3}>Upload files</Title>
              <Files model={modelVersion?.model} version={modelVersion} />
              <Group position="right">
                <Button variant="default" onClick={goBack}>
                  Back
                </Button>
                <Button
                  onClick={() => {
                    const { uploading = 0, success = 0 } = useS3UploadStore
                      .getState()
                      .getStatus((item) => item.meta?.versionId === modelVersion?.id);

                    const showConfirmModal =
                      (uploading > 0 && success === 0) || !modelVersion?.files.length;

                    if (showConfirmModal) {
                      return openConfirmModal({
                        title: (
                          <Group spacing="xs">
                            <IconAlertTriangle color="gold" />
                            <Text size="lg">Missing files</Text>
                          </Group>
                        ),
                        children:
                          'You have not uploaded any files. You can continue without files, but you will not be able to publish your model. Are you sure you want to continue?',
                        labels: { cancel: 'Cancel', confirm: 'Continue' },
                        onConfirm: goNext,
                      });
                    }

                    return goNext();
                  }}
                >
                  Next
                </Button>
              </Group>
            </Stack>
          </Stepper.Step>
          <Stepper.Step label={postId ? 'Edit post' : 'Create a post'}>
            <Stack spacing="xl">
              <Title order={3}>{postId ? 'Edit post' : 'Create your post'}</Title>
              {modelVersion && (
                <PostEditWrapper postId={postId}>
                  <PostUpsertForm
                    modelVersionId={modelVersion.id}
                    modelId={modelVersion.model.id}
                  />
                </PostEditWrapper>
              )}
            </Stack>
          </Stepper.Step>
        </Stepper>
      </Stack>
    </Container>
  );
}

type Props = {
  data?: ModelById;
};
