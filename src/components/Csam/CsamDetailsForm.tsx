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
import type { CsamReportType } from '~/shared/utils/prisma/enums';
import { IconExternalLink, IconPhoto } from '@tabler/icons-react';
import { uniqBy } from 'lodash-es';

import { useEffect, useMemo } from 'react';
import * as z from 'zod';
import { useCsamImageSelectStore } from '~/components/Csam/useCsamImageSelect.store';
import { settleShown } from '~/components/Csam/csam-shown';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { Form, InputCheckboxGroup, InputRadioGroup, useForm } from '~/libs/form';
import { withController } from '~/libs/form/hoc/withController';
import type { CsamReportFormInput } from '~/server/schema/csam.schema';
import {
  csamCapabilitiesDictionary,
  csamContentsDictionary,
  csamReportDetails,
} from '~/server/schema/csam.schema';
import { getModelUrl } from '~/utils/string-helpers';
import type { RouterOutput } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const schema = csamReportDetails.extend({ minorDepiction: z.enum(['real', 'non-real']) });

export function CsamDetailsForm({
  onPrevious,
  onSuccess,
  userId,
  type,
  defaultValues,
  supplementalOf,
}: {
  onPrevious?: () => void;
  onSuccess?: () => void;
  userId: number;
  type: CsamReportType;
  defaultValues?: CsamReportFormInput;
  /** The sent report this one supplements. */
  supplementalOf?: number;
}) {
  const form = useForm({
    schema,
    shouldUnregister: false,
    defaultValues,
  });

  const imageIds = useCsamImageSelectStore.getState().getSelected(userId);
  const supplemental = trpc.csam.getSupplementalPreview.useQuery(
    { userId, imageIds, supplementalOf: supplementalOf ?? 0 },
    { enabled: !!supplementalOf, retry: false, refetchOnMount: 'always' }
  );

  const { mutate: createReport, isPending: isLoading } = trpc.csam.createReport.useMutation({
    onSuccess: () => {
      closeModal('csam-confirm');
      onSuccess?.();
    },
    onError: (error) => {
      closeModal('csam-confirm');
      showErrorNotification({ error, title: 'The report was not filed', autoClose: false });
      // Views recorded at submit can change what a supplemental report may attach.
      if (supplementalOf) supplemental.refetch();
    },
  });

  const handleSubmit = (data: z.infer<typeof schema>) => {
    openConfirmModal({
      modalId: 'csam-confirm',
      centered: true,
      title: 'Confirm CSAM report',
      children: 'Are you sure you want to report this content as CSAM?',
      labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
      confirmProps: { loading: isLoading },
      onConfirm: async () => {
        // The records of what was opened and selected land before the report they describe.
        await settleShown();
        createReport({
          type,
          imageIds: type === 'Image' ? useCsamImageSelectStore.getState().getSelected(userId) : [],
          userId,
          details: data,
          supplementalOf,
        });
      },
    });
  };

  return (
    <ScrollArea>
      <Container>
        <Title className="text-center" mb="md">
          CSAM Details Form
        </Title>
        <Card>
          <Form id="csamForm" form={form} onSubmit={handleSubmit}>
            <Stack gap="xl">
              {supplementalOf && (
                <SupplementalPreview
                  data={supplemental.data}
                  isLoading={supplemental.isLoading}
                  error={supplemental.error}
                  onRetry={() => supplemental.refetch()}
                />
              )}
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
              >
                <Stack gap="xs">
                  {Object.entries(csamContentsDictionary).map(([key, value]) => (
                    <Checkbox key={key} value={key} label={value} />
                  ))}
                </Stack>
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
                <Button
                  type="submit"
                  loading={isLoading}
                  disabled={!!supplementalOf && !supplemental.data}
                >
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
                href={modelId ? getModelUrl({ modelId, modelName, modelVersionId }) : '#'}
                target="_blank"
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

function SupplementalPreview({
  data,
  isLoading,
  error,
  onRetry,
}: {
  data?: RouterOutput['csam']['getSupplementalPreview'];
  isLoading: boolean;
  error?: { message: string } | null;
  onRetry: () => void;
}) {
  if (isLoading)
    return (
      <Center>
        <Loader size="sm" />
      </Center>
    );
  if (!data)
    return (
      <Alert color="red" title="This supplemental report cannot be filed">
        <Stack gap="xs" align="flex-start">
          <Text size="sm">{error?.message}</Text>
          <Button size="xs" variant="default" onClick={onRetry}>
            Check again
          </Button>
        </Stack>
      </Alert>
    );
  const { priorReportNumbers, text } = data;
  return (
    <Alert color="blue" title="Supplemental report">
      <Stack gap="xs">
        <Text size="sm">
          Refers to CyberTip {priorReportNumbers.map((n) => `#${n}`).join(', ')}. NCMEC receives:
        </Text>
        <Text size="sm" fs="italic">
          {text}
        </Text>
      </Stack>
    </Alert>
  );
}
