import {
  Checkbox,
  Radio,
  Stack,
  Center,
  Loader,
  Alert,
  Card,
  Input,
  Group,
  Text,
  Badge,
  Button,
  Container,
  Title,
} from '@mantine/core';
import { closeModal, openConfirmModal } from '@mantine/modals';
import { IconExternalLink, IconPhoto } from '@tabler/icons-react';
import { uniqBy } from 'lodash-es';

import { useEffect, useMemo } from 'react';
import { z } from 'zod';
import { useCsamContext } from '~/components/Csam/CsamProvider';
import {
  useCsamImageSelectStore,
  useCsamModelVersionSelectStore,
} from '~/components/Csam/useCsamImageSelect.store';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { Stepper, useStepperContext } from '~/components/Stepper/Stepper';
import { Form, InputCheckboxGroup, InputRadioGroup, useForm } from '~/libs/form';
import {
  csamCapabilitiesDictionary,
  csamContentsDictionary,
  csamReportFormSchema,
} from '~/server/schema/csam.schema';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export function CsamDetailsForm() {
  const { userId, isInternal } = useCsamContext();
  const { next } = useStepperContext();
  const form = useForm({
    schema: csamReportFormSchema,
    defaultValues: { origin: isInternal ? 'testing' : 'user' },
    shouldUnregister: false,
  });

  const { mutate: createReport, isLoading } = trpc.csam.createReport.useMutation({
    onSuccess: () => {
      closeModal('csam-confirm');
      next();
    },
  });

  const handleSubmit = (data: z.infer<typeof csamReportFormSchema>) => {
    openConfirmModal({
      modalId: 'csam-confirm',
      centered: true,
      title: 'Confirm CSAM report',
      children: 'Are you sure you want to report this content as CSAM?',
      labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
      confirmProps: { loading: isLoading },
      onConfirm: () => {
        createReport({
          ...data,
          userId,
          modelVersionIds: useCsamModelVersionSelectStore.getState().getSelected(userId),
          images: useCsamImageSelectStore
            .getState()
            .getSelected(userId)
            .map((id) => ({ id })),
        });
      },
    });
  };

  return (
    <ScrollArea>
      <Container>
        <Title align="center" mb="md">
          CSAM Details Form
        </Title>
        <Card>
          <Form id="csamForm" form={form} onSubmit={handleSubmit}>
            <Stack spacing="xl">
              {!isInternal ? (
                <InputRadioGroup name="minorDepiction" label="Minor depiction">
                  <Radio value="real" label="Real" />
                  <Radio value="non-real" label="Non-real" />
                </InputRadioGroup>
              ) : (
                <InputCheckboxGroup
                  name="capabilities"
                  label="Model capabilities"
                  orientation="vertical"
                  spacing="xs"
                >
                  {Object.entries(csamCapabilitiesDictionary).map(([key, value]) => (
                    <Checkbox key={key} value={key} label={value} />
                  ))}
                </InputCheckboxGroup>
              )}

              <InputCheckboxGroup
                name="contents"
                label="The images/videos in this report may involve:"
                orientation="vertical"
                spacing="xs"
              >
                {Object.entries(csamContentsDictionary).map(([key, value]) => (
                  <Checkbox key={key} value={key} label={value} />
                ))}
              </InputCheckboxGroup>
              <Input.Wrapper label="Select the resources that you'd like to have referenced in this report">
                <ModelVersionSelectList userId={userId} />
              </Input.Wrapper>
              <Group position="right">
                <Stepper.PreviousButton>Previous</Stepper.PreviousButton>
                <Button type="submit" loading={isLoading}>
                  Submit
                </Button>
              </Group>
            </Stack>
          </Form>
        </Card>
      </Container>
    </ScrollArea>
  );
}

function ModelVersionSelectList({ userId }: { userId: number }) {
  // const imageIds = userId ? useCsamImageSelectStore.getState().getSelected(userId) : [];
  const imageIds = useCsamImageSelectStore((state) =>
    Object.keys(state.selected[userId] ?? {}).map(Number)
  );
  const canFetchResources = !!imageIds.length;
  const { data: imageResources, isLoading } = trpc.csam.getImageResources.useQuery(
    { ids: imageIds },
    { enabled: canFetchResources }
  );

  const resources = useMemo(() => uniqBy(imageResources ?? [], 'modelVersionId'), [imageResources]);

  useEffect(() => {
    if (!resources.length) return;
    const modelVersionIds = resources.map((x) => x.modelVersionId).filter(isDefined);
    useCsamModelVersionSelectStore.getState().setSelected(userId, modelVersionIds);
  }, [resources, userId]);

  if (!canFetchResources) return null;

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );

  if (!resources) return <Alert>No resources associated with the selected images</Alert>;

  return (
    <Stack spacing="xs" mt="xs">
      {resources.map((resource, i) => (
        <ModelVersionSelectItem key={i} userId={userId} {...(resource as any)} />
      ))}
    </Stack>
  );
}

function ModelVersionSelectItem({
  userId,
  modelId,
  modelName,
  modelVersionId,
  modelVersionName,
  imageId,
}: {
  userId: number;
  modelName: string;
  modelId: number;
  imageId: number;
  modelVersionId: number;
  modelVersionName: number;
}) {
  const checked = useCsamModelVersionSelectStore(
    (state) => state.selected[userId]?.[modelVersionId] ?? false
  );
  const associatedCount = useCsamImageSelectStore(
    (state) =>
      Object.keys(state.selected[userId] ?? {})
        .map(Number)
        .filter((id) => id === imageId).length
  );

  return (
    <Card p={0}>
      <Group align="center" spacing={4} noWrap>
        <Checkbox
          checked={checked}
          onChange={() => useCsamModelVersionSelectStore.getState().toggle(userId, modelVersionId)}
          label={`${modelName} - ${modelVersionName}`}
        />
        <Badge leftSection={<IconPhoto size={14} />}>{associatedCount}</Badge>
        <Text
          component="a"
          href={`/models/${modelId}/${modelName}?modelVersionId=${modelVersionId}`}
          target="_blank"
          variant="link"
          style={{ lineHeight: 1 }}
        >
          <IconExternalLink size={18} />
        </Text>
      </Group>
    </Card>
  );
}
