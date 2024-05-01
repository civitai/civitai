import { Anchor, Button, Group, Stepper, Text, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { Files, UploadStepActions } from '~/components/Resource/Files';
import { FilesProvider } from '~/components/Resource/FilesProvider';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { ModelById } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';
import { PostUpsertForm2 } from '~/components/Resource/Forms/PostUpsertForm2';

const MAX_STEPS = 3;

export function ModelVersionWizard({ data }: Props) {
  const router = useRouter();

  const { id, versionId } = router.query;
  const isNew = router.pathname.includes('/create');
  const parsedStep = router.query.step ? Number(router.query.step) : 1;
  const step = isNumber(parsedStep) ? parsedStep : 1;

  const { data: modelVersion } = trpc.modelVersion.getById.useQuery(
    { id: Number(versionId), withFiles: true },
    { enabled: !!versionId }
  );

  const modelData = modelVersion?.model ?? data;

  const { getStatus: getUploadStatus } = useS3UploadStore();
  const { uploading, error, aborted } = getUploadStatus(
    (file) => file.meta?.versionId === modelVersion?.id
  );

  const goNext = () => {
    if (step < MAX_STEPS)
      router.replace(
        `/models/${id}/model-versions/${versionId}/wizard?step=${step + 1}`,
        undefined,
        { shallow: !isNew }
      );
  };

  const goBack = () => {
    if (step > 1)
      router.replace(
        `/models/${id}/model-versions/${versionId}/wizard?step=${step - 1}`,
        undefined,
        { shallow: !isNew }
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

  const editing = !!modelVersion?.id;
  const postId = modelVersion?.posts?.[0]?.id;

  return (
    <FilesProvider model={modelData} version={modelVersion}>
      <div className="container max-w-sm pb-4">
        <Link href={`/models/${modelData?.id}`} passHref>
          <Anchor size="xs">
            <Group spacing={4} noWrap>
              <IconArrowLeft size={12} />
              <Text inherit>Back to {modelData?.name} page</Text>
            </Group>
          </Anchor>
        </Link>
      </div>
      <Stepper
        active={step - 1}
        onStepClick={(step) =>
          router.replace(
            `/models/${modelData?.id}/model-versions/${versionId}/wizard?step=${step + 1}`
          )
        }
        allowNextStepsSelect={false}
        size="sm"
        classNames={{ steps: 'container max-w-sm' }}
      >
        <Stepper.Step label={editing ? 'Edit version' : 'Add version'}>
          <div className="container max-w-sm flex flex-col gap-3">
            <Title order={3}>{editing ? 'Edit version' : 'Add version'}</Title>
            <ModelVersionUpsertForm
              model={modelData}
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
          </div>
        </Stepper.Step>
        <Stepper.Step
          label="Upload files"
          loading={uploading > 0}
          color={error + aborted > 0 ? 'red' : undefined}
        >
          <div className="container max-w-sm flex flex-col gap-3">
            <Title order={3}>Upload files</Title>
            <Files />
            <UploadStepActions onBackClick={goBack} onNextClick={goNext} />
          </div>
        </Stepper.Step>
        <Stepper.Step label={postId ? 'Edit post' : 'Create a post'}>
          {modelVersion && modelData && (
            <PostUpsertForm2
              postId={postId}
              modelVersionId={modelVersion.id}
              modelId={modelData.id}
            />
          )}
        </Stepper.Step>
      </Stepper>
    </FilesProvider>
  );
}

type Props = {
  data?: ModelById;
};
