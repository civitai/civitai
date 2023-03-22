import { Anchor, Button, Container, Group, Stack, Stepper, Text, Title } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { IconArrowLeft } from '@tabler/icons';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { PostEditWrapper } from '~/components/Post/Edit/PostEditLayout';
import { Files } from '~/components/Resource/Files';
import { BaseModel } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';
import { ModelById } from '~/types/router';
import { PostUpsertForm } from '../Forms/PostUpsertForm';

export function ModelVersionWizard({ data }: Props) {
  const router = useRouter();

  const { id, versionId, step = '1' } = router.query;
  const parsedStep = Array.isArray(step) ? Number(step[0]) : Number(step);

  const [activeStep, setActiveStep] = useState<number>(parsedStep);

  const { data: model } = trpc.model.getById.useQuery(
    { id: Number(id) },
    { enabled: !!id, initialData: data }
  );
  const { tagsOnModels, ...modelWithoutTags } = model as ModelById;
  const modelVersion = modelWithoutTags?.modelVersions?.find((v) => v.id === Number(versionId));

  const goNext = () => {
    if (activeStep < 3) {
      setActiveStep((current) => current + 1);
    }
  };

  const goBack = () => {
    if (activeStep > 1) {
      setActiveStep((current) => current - 1);
    }
  };

  useDidUpdate(() => {
    if (modelVersion)
      router.push(
        `/models/v2/${id}/model-versions/${modelVersion.id}/wizard?step=${activeStep}`,
        undefined,
        { shallow: true }
      );
  }, [id, activeStep, modelVersion]);

  const editing = !!modelVersion;

  return (
    <Container size="sm">
      <Stack spacing="xl" py="xl">
        <Link href={`/models/v2/${id}`} passHref>
          <Anchor size="xs">
            <Group spacing={4}>
              <IconArrowLeft size={12} />
              <Text inherit>Back to {model?.name} page</Text>
            </Group>
          </Anchor>
        </Link>
        <Stepper
          active={activeStep - 1}
          onStepClick={(step) => setActiveStep(step + 1)}
          allowNextStepsSelect={false}
          size="sm"
        >
          <Stepper.Step label={editing ? 'Edit version' : 'Add version'}>
            <Stack>
              <Title order={3}>{editing ? 'Edit version' : 'Add version'}</Title>
              <ModelVersionUpsertForm
                model={modelWithoutTags}
                version={{ ...modelVersion, baseModel: modelVersion?.baseModel as BaseModel }}
                onSubmit={(result) => {
                  if (editing) return goNext();
                  router.replace(
                    `/models/v2/${id}/model-versions/${result?.id}/wizard?step=2`,
                    undefined,
                    {
                      shallow: true,
                    }
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
              <Files model={modelWithoutTags} version={modelVersion} />
              <Group position="right">
                <Button variant="default" onClick={goBack}>
                  Back
                </Button>
                <Button onClick={goNext}>Next</Button>
              </Group>
            </Stack>
          </Stepper.Step>
          <Stepper.Step label="Create a post">
            <Stack spacing="xl">
              <Title order={3}>Create your post</Title>
              {model && modelVersion && (
                <PostEditWrapper postId={modelVersion.posts[0]?.id}>
                  <PostUpsertForm modelVersionId={modelVersion.id} modelId={model.id} />
                </PostEditWrapper>
              )}
              <Group position="right">
                <Button variant="default" onClick={goBack}>
                  Back
                </Button>
              </Group>
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
