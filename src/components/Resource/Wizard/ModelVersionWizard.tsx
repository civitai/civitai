import { Anchor, Button, Container, Group, Stack, Stepper, Text } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { IconArrowLeft } from '@tabler/icons';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { PostEditComposite } from '~/components/Post/Edit/PostEditComposite';
import { PostEditWrapper } from '~/components/Post/Edit/PostEditLayout';
import { Files } from '~/components/Resource/Files';
import { trpc } from '~/utils/trpc';
import { ModelById } from '~/types/router';

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
          <Stepper.Step label="Add version">
            <ModelVersionUpsertForm
              model={modelWithoutTags}
              version={modelVersion}
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
          </Stepper.Step>
          <Stepper.Step label="Upload files">
            <Files model={modelWithoutTags} version={modelVersion} onStartUploadClick={goNext} />
            <Group mt="xl" position="right">
              <Button variant="default" onClick={goBack}>
                Back
              </Button>
              <Button onClick={goNext}>Next</Button>
            </Group>
          </Stepper.Step>
          <Stepper.Step label="Create a post">
            <PostEditWrapper postId={modelVersion?.posts[0]?.id}>
              <PostEditComposite />
            </PostEditWrapper>
            <Group mt="xl" position="right">
              <Button variant="default" onClick={goBack}>
                Back
              </Button>
            </Group>
          </Stepper.Step>
        </Stepper>
      </Stack>
    </Container>
  );
}

type Props = {
  data?: ModelById;
};
