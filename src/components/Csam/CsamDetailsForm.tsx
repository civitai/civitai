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
import { CsamReportType } from '~/shared/utils/prisma/enums';
import { IconExternalLink, IconPhoto } from '@tabler/icons-react';
import { uniqBy } from 'lodash-es';

import { useEffect, useMemo } from 'react';
import { z } from 'zod';
import { useCsamImageSelectStore } from '~/components/Csam/useCsamImageSelect.store';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { Form, InputCheckboxGroup, InputRadioGroup, useForm } from '~/libs/form';
import { withController } from '~/libs/form/hoc/withController';
import {
  CsamReportFormInput,
  csamCapabilitiesDictionary,
  csamContentsDictionary,
  csamReportDetails,
} from '~/server/schema/csam.schema';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const schema = csamReportDetails.extend({ minorDepiction: z.enum(['real', 'non-real']) });

export function CsamDetailsForm({
  onPrevious,
  onSuccess,
  userId,
  type,
  defaultValues,
}: {
  onPrevious?: () => void;
  onSuccess?: () => void;
  userId: number;
  type: CsamReportType;
  defaultValues?: CsamReportFormInput;
}) {
  const form = useForm({
    schema,
    shouldUnregister: false,
    defaultValues,
  });

  const { mutate: createReport, isLoading } = trpc.csam.createReport.useMutation({
    onSuccess: () => {
      closeModal('csam-confirm');
      onSuccess?.();
    },
  });

  const imageIds = useCsamImageSelectStore.getState().getSelected(userId);

  const handleSubmit = (data: z.infer<typeof schema>) => {
    openConfirmModal({
      modalId: 'csam-confirm',
      centered: true,
      title: 'Confirm CSAM report',
      children: 'Are you sure you want to report this content as CSAM?',
      labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
      confirmProps: { loading: isLoading },
      onConfirm: () => {
        createReport({
          type,
          imageIds: type === 'Image' ? useCsamImageSelectStore.getState().getSelected(userId) : [],
          userId,
          details: data,
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
            <Stack gap="xl">
              <InputRadioGroup name="minorDepiction" label="Minor depiction">
                <Radio value="real" label="Real" />
                <Radio value="non-real" label="Non-real" />
              </InputRadioGroup>
              {/* {!isInternal ? (
                <InputRadioGroup name="minorDepiction" label="Minor depiction">
                  <Radio value="real" label="Real" />
                  <Radio value="non-real" label="Non-real" />
                </InputRadioGroup>
              ) : (
                <InputCheckboxGroup
                  name="capabilities"
                  label="Model capabilities"
                  orientation="vertical"
                  gap="xs"
                >
                  {Object.entries(csamCapabilitiesDictionary).map(([key, value]) => (
                    <Checkbox key={key} value={key} label={value} />
                  ))}
                </InputCheckboxGroup>
              )} */}

              <InputCheckboxGroup
                name="contents"
                label="The images/videos in this report may involve:"
                orientation="vertical"
                gap="xs"
              >
                {Object.entries(csamContentsDictionary).map(([key, value]) => (
                  <Checkbox key={key} value={key} label={value} />
                ))}
              </InputCheckboxGroup>
              {type === 'Image' && (
                <Input.Wrapper label="Select the resources that you'd like to have referenced in this report">
                  <InputModelVersionSelect name="modelVersionIds" imageIds={imageIds} />
                </Input.Wrapper>
              )}
              <Group justify="flex-end">
                {onPrevious && (
                  <Button variant="default" onClick={onPrevious} disabled={isLoading}>
                    Previous
                  </Button>
                )}
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

function ModelVersionSelectList({
  value,
  onChange,
  imageIds,
}: {
  value?: number[];
  onChange?: (value: number[]) => void;
  imageIds: number[];
}) {
  // const imageIds = userId ? useCsamImageSelectStore.getState().getSelected(userId) : [];
  // const imageIds = useCsamImageSelectStore((state) =>
  //   Object.keys(state.selected[userId] ?? {}).map(Number)
  // );
  const canFetchResources = !!imageIds.length;
  const { data: imageResources, isLoading } = trpc.csam.getImageResources.useQuery(
    { ids: imageIds },
    { enabled: canFetchResources }
  );

  const resources = useMemo(() => uniqBy(imageResources ?? [], 'modelVersionId'), [imageResources]);

  useEffect(() => {
    if (!resources.length) return;
    onChange?.(resources.map((x) => x.modelVersionId).filter(isDefined));
  }, [resources]);

  if (!canFetchResources) return <></>;

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );

  if (!resources) return <Alert>No resources associated with the selected images</Alert>;

  return (
    <Stack gap="xs" mt="xs">
      {resources.map(({ modelName, modelId, modelVersionName, modelVersionId, imageId }, i) => {
        const associatedCount = 0;
        const checked = !!modelVersionId && value?.includes(modelVersionId);
        function handleChange(checked: boolean) {
          if (!modelVersionId) return;
          if (checked) {
            if (!value) onChange?.([modelVersionId]);
            else if (!value.includes(modelVersionId)) onChange?.([...value, modelVersionId]);
          } else onChange?.((value ?? []).filter((id) => id !== modelVersionId));
        }
        return (
          <Card p={0} key={i}>
            <Group align="center" gap={4} wrap="nowrap">
              <Checkbox
                checked={checked}
                onChange={(e) => handleChange(e.target.checked)}
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
      })}
    </Stack>
  );
}

const InputModelVersionSelect = withController(ModelVersionSelectList);
