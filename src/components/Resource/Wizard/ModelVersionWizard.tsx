import { Anchor, Button, Container, Group, Stack, Stepper, Text, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

import { PostEditWrapper } from '~/components/Post/Edit/PostEditLayout';
import { Files, UploadStepActions } from '~/components/Resource/Files';
import { FilesProvider } from '~/components/Resource/FilesProvider';
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

  const { getStatus: getUploadStatus } = useS3UploadStore();
  const { uploading, error, aborted } = getUploadStatus(
    (file) => file.meta?.versionId === modelVersion?.id
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
    <FilesProvider model={modelVersion?.model} version={modelVersion}>
      <Container size="sm">
        <Stack spacing="xl" py="xl">
          <Link href={`/models/${modelVersion?.model.id}`} passHref>
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
            <Stepper.Step
              label="Upload files"
              loading={uploading > 0}
              color={error + aborted > 0 ? 'red' : undefined}
            >
              <Stack spacing="xl">
                <Title order={3}>Upload files</Title>
                <Files />
                <UploadStepActions onBackClick={goBack} onNextClick={goNext} />
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
    </FilesProvider>
  );
}

type Props = {
  data?: ModelById;
};
