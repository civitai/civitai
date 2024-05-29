import {
  Alert,
  Button,
  Card,
  Center,
  Input,
  NumberInputProps,
  Paper,
  SliderProps,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { ModelType } from '@prisma/client';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { TypeOf, z } from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { DailyBoostRewardClaim } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import InputQuantity from '~/components/ImageGeneration/GenerationForm/InputQuantity';
import InputResourceSelect from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form } from '~/libs/form';
import { Watch } from '~/libs/form/components/Watch';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { BaseModel, draftMode, generation, getGenerationConfig } from '~/server/common/constants';
import { GetGenerationDataInput } from '~/server/schema/generation.schema';
import { imageSchema } from '~/server/schema/image.schema';
import {
  textToImageParamsSchema,
  textToImageResourceSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import { userTierSchema } from '~/server/schema/user.schema';
import { GenerationData } from '~/server/services/generation/generation.service';
import { getBaseModelSetType, getIsSdxl } from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

// #region [schemas]
const extendedTextToImageResourceSchema = textToImageResourceSchema.extend({
  name: z.string(),
  trainedWords: z.string().array().default([]),
  modelId: z.number(),
  modelName: z.string(),
  modelType: z.nativeEnum(ModelType),
  minStrength: z.number().default(-1),
  maxStrength: z.number().default(2),

  // navigation props
  image: imageSchema.pick({ url: true }).optional(),
  covered: z.boolean().optional(),
  baseModel: z.string(),
});

type PartialFormData = Partial<TypeOf<typeof formSchema>>;
const formSchema = textToImageParamsSchema.extend({
  tier: userTierSchema,
  model: extendedTextToImageResourceSchema,
  resources: extendedTextToImageResourceSchema.array().min(0).max(9),
  vae: extendedTextToImageResourceSchema.optional(),
});

// #endregion

// #region [data formatter]
function formatGenerationData({
  formData,
  data,
  versionId,
  type,
}: {
  formData: PartialFormData;
  data: GenerationData;
  /** pass the versionId to specify the resource to use when deriving the baseModel */
  versionId?: number;
  type: 'default' | 'run' | 'remix';
}): PartialFormData {
  // check for new model in resources, otherwise use stored model
  let checkpoint = data.resources.find((x) => x.modelType === 'Checkpoint') ?? formData.model;
  let vae = data.resources.find((x) => x.modelType === 'VAE') ?? formData.vae;

  // use versionId to set the resource we want to use to derive the baseModel
  // (ie, a lora is used to derive the baseModel instead of the checkpoint)
  const baseResource = versionId ? data.resources.find((x) => x.id === versionId) : checkpoint;
  const baseModel = getBaseModelSetType(baseResource?.baseModel);

  const config = getGenerationConfig(baseModel);

  // if current checkpoint doesn't match baseModel, set checkpoint based on baseModel config
  if (getBaseModelSetType(checkpoint?.modelType) !== baseModel) checkpoint = config.checkpoint;
  // if current vae doesn't match baseModel, set vae to undefined
  if (getBaseModelSetType(vae?.modelType) !== baseModel) vae = undefined;
  // filter out any additional resources that don't belong
  const resources = (
    type === 'remix' ? data.resources : [...(formData.resources ?? []), ...data.resources]
  )
    .filter((resource) => {
      if (resource.modelType === 'Checkpoint' || resource.modelType === 'VAE') return false;
      const baseModelSetKey = getBaseModelSetType(resource.baseModel);
      return config.additionalResourceTypes.some((x) => {
        const modelTypeMatches = x.type === resource.modelType;
        const baseModelSetMatches = x.baseModelSet === baseModelSetKey;
        const baseModelIncluded = x.baseModels?.includes(resource.baseModel as BaseModel);
        return modelTypeMatches && (baseModelSetMatches || baseModelIncluded);
      });
    })
    .slice(0, 9);

  const sampler =
    data.params.sampler && generation.samplers.includes(data.params.sampler as any)
      ? data.params.sampler
      : formData.sampler;

  const returnData: PartialFormData = {
    ...formData,
    ...data.params,
    baseModel,
    model: checkpoint,
    resources,
    vae,
    sampler,
  };

  const maxValueKeys = Object.keys(generation.maxValues);
  for (const item of maxValueKeys) {
    const key = item as keyof typeof generation.maxValues;
    if (returnData[key])
      returnData[key] = Math.min(returnData[key] ?? 0, generation.maxValues[key]);
  }

  const isSDXL = getIsSdxl(baseModel);
  if (isSDXL) returnData.clipSkip = 2;

  // Look through data for Draft resource.
  // If we find them, toggle draft and remove the resource.
  const draftResourceId = draftMode[isSDXL ? 'sdxl' : 'sd1'].resourceId;
  const draftResourceIndex = returnData.resources?.findIndex((x) => x.id === draftResourceId) ?? -1;
  if (draftResourceIndex !== -1) {
    returnData.draft = true;
    returnData.resources?.splice(draftResourceIndex, 1);
  }

  return type === 'run' ? removeEmpty(returnData) : returnData;
}
// #endregion

// #region [form component]
const defaultValues = generation.defaultValues;
export function GenerationForm2({ input }: { input?: GetGenerationDataInput }) {
  const { classes, cx } = useStyles();
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const status = useGenerationStatus();
  const response = trpc.generation.getGenerationData.useQuery(input!, {
    enabled: input !== undefined,
  });

  const form = usePersistForm('generation-form-2', {
    schema: formSchema,
    version: 0,
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    values: (storageValues) =>
      handleUserLimits({
        ...defaultValues,
        nsfw: storageValues.nsfw ?? false,
        quantity: storageValues.quantity ?? defaultValues.quantity,
        tier: currentUser?.tier ?? 'free',
      }),
  });

  useEffect(() => {
    const runType = !input ? 'default' : input.type === 'modelVersion' ? 'run' : 'remix';
    const formData = handleUserLimits(
      runType === 'default'
        ? form.getValues()
        : formatGenerationData({
            formData: form.getValues(),
            data: response.data ?? { resources: [], params: {} },
            versionId: input?.type === 'modelVersion' ? input?.id : undefined,
            type: runType,
          })
    );
    for (const [key, value] of Object.entries(formData)) form.setValue(key as any, value);
  }, [response.data, status, currentUser]);

  function handleUserLimits(data: PartialFormData): PartialFormData {
    if (!status) return data;
    if (data.steps) data.steps = Math.min(data.steps, status.limits.steps);
    if (data.quantity) data.quantity = Math.min(data.quantity, status.limits.quantity);
    return data;
  }

  const [promptWarning, setPromptWarning] = useState<string | null>(null);
  const [reviewed, setReviewed] = useLocalStorage({
    key: 'review-generation-terms',
    defaultValue: window?.localStorage?.getItem('review-generation-terms') === 'true',
  });

  const canGenerate = useGenerationContext((state) => state.canGenerate);
  // const disableGenerateButton = !canGenerate || isCalculatingCost || isLoading;

  function clearWarning() {
    setPromptWarning(null);
  }

  function handleReset() {
    form.reset();
    clearWarning();
  }

  return (
    <Form form={form} className="relative flex h-full flex-1 flex-col overflow-hidden">
      <ScrollArea
        scrollRestore={{ key: 'generation-form' }}
        pt={0}
        className="flex flex-col gap-2 px-3"
      >
        <div className="mb-1 flex gap-1">
          <Input.Label style={{ fontWeight: 590 }} required>
            Model
          </Input.Label>
          <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
            <Text weight={400}>
              Models are the resources you&apos;re generating with. Using a different base model can
              drastically alter the style and composition of images, while adding additional
              resource can change the characters, concepts and objects
            </Text>
          </InfoPopover>
        </div>
        <Card
          className={cx(`p-2 rounded`, { [classes.formError]: form.formState.errors.resources })}
          withBorder
        >
          <Watch {...form} fields={['baseModel', 'resources', 'vae']}>
            {({ baseModel, resources, vae }) => (
              <InputResourceSelect
                name="model"
                buttonLabel="Add Model"
                allowRemove={false}
                options={{
                  canGenerate: true,
                  resources: [
                    {
                      type: ModelType.Checkpoint,
                      baseModelSet: !!resources?.length || !!vae ? baseModel : undefined,
                    },
                  ],
                }}
              />
            )}
          </Watch>
        </Card>
      </ScrollArea>
      <div className="shadow-topper flex flex-col gap-2 rounded-xl p-2">
        <DailyBoostRewardClaim />
        {promptWarning ? (
          <div>
            <Alert color="red" title="Prohibited Prompt">
              <Text>{promptWarning}</Text>
              <Button
                color="red"
                variant="light"
                onClick={() => setPromptWarning(null)}
                style={{ marginTop: 10 }}
                leftIcon={<IconCheck />}
                fullWidth
              >
                I Understand, Continue Generating
              </Button>
            </Alert>
            <Text size="xs" color="dimmed" mt={4}>
              Is this a mistake?{' '}
              <Text
                component="a"
                td="underline"
                href={`https://forms.clickup.com/8459928/f/825mr-9671/KRFFR2BFKJCROV3B8Q?Civitai Username=${currentUser?.username}`}
                target="_blank"
              >
                Submit your prompt for review
              </Text>{' '}
              so we can refine our system.
            </Text>
          </div>
        ) : !status.available ? (
          <AlertWithIcon
            color="yellow"
            title="Image Generation Status Alert"
            icon={<IconAlertTriangle size={20} />}
            iconColor="yellow"
          >
            {status.message}
          </AlertWithIcon>
        ) : (
          <>
            {!reviewed && (
              <Alert color="yellow" title="Image Generation Terms">
                <Text size="xs">
                  By using the image generator you confirm that you have read and agree to our{' '}
                  <Text component={NextLink} href="/content/tos" td="underline">
                    Terms of Service
                  </Text>{' '}
                  presented during onboarding. Failure to abide by{' '}
                  <Text component={NextLink} href="/content/tos" td="underline">
                    our content policies
                  </Text>{' '}
                  will result in the loss of your access to the image generator.
                </Text>
                <Button
                  color="yellow"
                  variant="light"
                  onClick={() => setReviewed(true)}
                  style={{ marginTop: 10 }}
                  leftIcon={<IconCheck />}
                  fullWidth
                >
                  I Confirm, Start Generating
                </Button>
              </Alert>
            )}
            <QueueSnackbar />
            <div className="flex gap-2">
              <Card withBorder className="flex max-w-24 flex-1 flex-col p-0">
                <Text className="pr-6 text-center text-xs font-semibold" color="dimmed">
                  Quantity
                </Text>
                <InputQuantity name="quantity" className={classes.generateButtonQuantityInput} />
              </Card>
              {!status.charge ? (
                <Button
                  type="submit"
                  size="lg"
                  className="flex-1"
                  // loading={isLoading}
                  disabled={!canGenerate}
                >
                  <Text ta="center">Generate</Text>
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="lg"
                  className="flex-1"
                  // loading={isLoading}
                  disabled={!canGenerate}
                >
                  <Text ta="center">Generate</Text>
                </Button>
                // <BuzzTransactionButton
                //   type="submit"
                //   size="lg"
                //   label="Generate"
                //   loading={isCalculatingCost || isLoading}
                //   className={classes.generateButtonButton}
                //   disabled={disableGenerateButton}
                //   buzzAmount={totalCost}
                //   showPurchaseModal={false}
                //   error={
                //     costEstimateError
                //       ? 'Error calculating cost. Please try updating your values'
                //       : undefined
                //   }
                // />
              )}
              <Button onClick={handleReset} variant="default" className="h-auto px-3">
                Reset
              </Button>
            </div>
          </>
        )}
      </div>
    </Form>
  );
}
// #endregion

// #region [styles]
const useStyles = createStyles((theme) => ({
  generateButtonQuantityInput: {
    marginTop: -16,
    input: {
      background: 'transparent',
      border: 'none',
      borderTopRightRadius: 0,
      borderBottomRightRadius: 0,
      borderTopLeftRadius: 0,
      textAlign: 'center',
      paddingRight: 25 + 12,
      paddingTop: 22,
      paddingBottom: 6,
      lineHeight: 1,
      fontWeight: 500,
      height: 'auto',
    },
  },

  promptInputLabel: {
    display: 'inline-flex',
    gap: 4,
    marginBottom: 5,
    alignItems: 'center',
  },
  accordionItem: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : '#fff',

    '&:first-of-type': {
      borderTopLeftRadius: '8px',
      borderTopRightRadius: '8px',
    },

    '&:last-of-type': {
      borderBottomLeftRadius: '8px',
      borderBottomRightRadius: '8px',
    },

    '&[data-active]': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : `#fff`,
    },
  },
  accordionControl: {
    padding: '8px 8px 8px 12px',

    '&:hover': {
      background: 'transparent',
    },

    '&[data-active]': {
      borderRadius: '0 !important',
      borderBottom: `1px solid ${
        theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
      }`,
    },
  },
  accordionContent: {
    padding: '8px 12px 12px 12px',
  },
  formError: {
    borderColor: theme.colors.red[theme.fn.primaryShade()],
    color: theme.colors.red[theme.fn.primaryShade()],
  },
}));
// #endregion

// #region [misc]
const sharedSliderProps: SliderProps = {
  size: 'sm',
};

const sharedNumberProps: NumberInputProps = {
  size: 'sm',
};

const getAspectRatioControls = (baseModel?: string) => {
  const aspectRatios = getGenerationConfig(baseModel).aspectRatios;
  return aspectRatios.map(({ label, width, height }, index) => ({
    label: (
      <Stack spacing={2}>
        <Center>
          <Paper
            withBorder
            sx={{ borderWidth: 2, aspectRatio: `${width}/${height}`, height: 20 }}
          />
        </Center>
        <Stack spacing={0}>
          <Text size="xs">{label}</Text>
          <Text size={10} color="dimmed">{`${width}x${height}`}</Text>
        </Stack>
      </Stack>
    ),
    value: `${index}`,
  }));
};

const clipSkipMarks = Array(10)
  .fill(0)
  .map((_, index) => ({ value: index + 1 }));
// #endregion
