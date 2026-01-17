import {
  ActionIcon,
  Button,
  Container,
  Grid,
  Group,
  Input,
  Loader,
  Paper,
  Progress,
  SimpleGrid,
  Slider,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowBackUp,
  IconArrowLeft,
  IconCalendar,
  IconCheck,
  IconClock,
  IconCoin,
  IconInfoCircle,
  IconPencil,
  IconPhoto,
  IconPlus,
  IconTicket,
  IconTrash,
  IconTrophy,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import type * as z from 'zod';

import { BackButton, NavigateBack } from '~/components/BackButton/BackButton';
import { BrowsingLevelsInput } from '~/components/BrowsingLevel/BrowsingLevelInput';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useStepper } from '~/hooks/useStepper';
import { Form, InputNumber, InputSelect, InputText, InputTextArea, useForm } from '~/libs/form';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { Currency } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * ==============================================================================
 * DESIGN DECISION: WIZARD vs SINGLE-PAGE LAYOUT
 * ==============================================================================
 *
 * The mockup at docs/features/crucible/mockups/creation.html shows a single-page
 * form where all sections (Basic Info, Entry Settings, Prize Distribution) are
 * visible simultaneously.
 *
 * The live implementation intentionally differs by using a WIZARD (multi-step)
 * approach. This design decision was made for the following reasons:
 *
 * 1. **Progressive Disclosure**: Each step focuses the user's attention on one
 *    category of settings, reducing cognitive load and preventing overwhelm.
 *
 * 2. **Mobile Experience**: On smaller screens, a single-page form with all
 *    options would require extensive scrolling. The wizard provides a better
 *    mobile UX by showing one manageable section at a time.
 *
 * 3. **Validation Flow**: Step-by-step validation ensures users complete required
 *    fields before moving forward, preventing form submission errors.
 *
 * 4. **Preview Context**: The persistent sidebar preview card and cost breakdown
 *    remain visible at each step, giving context without cluttering the form.
 *
 * 5. **Guided Experience**: New users benefit from the guided flow, especially
 *    for complex features like prize distribution customization.
 *
 * The core functionality and all form fields remain identical to the mockup;
 * only the navigation pattern differs.
 *
 * ==============================================================================
 */

// Duration options with pricing
const durationOptions = [
  { value: '8', label: '8 hours', cost: 0, isFree: true },
  { value: '24', label: '24 hours', cost: 500, isFree: false, disabled: true },
  { value: '72', label: '3 days', cost: 1000, isFree: false, disabled: true },
  { value: '168', label: '7 days', cost: 2000, isFree: false, disabled: true },
];

// Default prize distribution
const defaultPrizePositions: Record<string, number> = {
  '1': 50,
  '2': 30,
  '3': 20,
};

// Form data type
type FormData = {
  // Step 1: Basic Info
  name: string;
  description: string;
  coverImageId: string;
  duration: string; // in hours as string
  nsfwLevel: number;

  // Step 2: Entry Rules
  entryFee: number;
  entryLimit: number;
  maxTotalEntries?: number;

  // Step 3: Prizes
  prizePositions: Record<string, number>;
};

// Form schema (client-side validation matching server schema)
const formSchema: FormData = {
  // Step 1: Basic Info
  name: '',
  description: '',
  coverImageId: '',
  duration: '8', // in hours as string
  nsfwLevel: 1, // Default to PG

  // Step 2: Entry Rules
  entryFee: 100,
  entryLimit: 1,
  maxTotalEntries: undefined,

  // Step 3: Prizes
  prizePositions: { ...defaultPrizePositions },
};

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx, features }) => {
    if (!features?.crucible) return { notFound: true };

    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'create-crucible' }),
          permanent: false,
        },
      };
    if (session.user?.muted) return { notFound: true };
  },
});

export default function CrucibleCreate() {
  const router = useRouter();
  const [currentStep, { goToNextStep, goToPrevStep, setStep }] = useStepper(4);

  // Form state
  const [formData, setFormData] = useState<FormData>(formSchema);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // tRPC mutation for creating crucible
  const createCrucibleMutation = trpc.crucible.create.useMutation({
    onSuccess: (data) => {
      showSuccessNotification({
        title: 'Crucible Created!',
        message: 'Your crucible has been created successfully. Redirecting...',
      });
      // Redirect to crucible detail page
      router.push(`/crucibles/${data.id}`);
    },
    onError: (error) => {
      setIsSubmitting(false);
      showErrorNotification({
        title: 'Failed to create crucible',
        error: { message: error.message },
      });
    },
  });

  // Prize distribution edit mode
  const [prizeEditMode, setPrizeEditMode] = useState(false);
  const [prizeCustomized, setPrizeCustomized] = useState(false);

  // Image upload
  const { files: imageFiles, uploadToCF, removeImage, resetFiles } = useCFImageUpload();
  const imageFile = imageFiles[0];

  const handleDropImages = async (droppedFiles: File[]) => {
    resetFiles();
    for (const file of droppedFiles) {
      uploadToCF(file);
    }
  };

  // Update form data helper
  const updateFormData = (updates: Partial<FormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  };

  // Step validation
  const isStep1Valid = () => {
    return (
      formData.name.trim().length > 0 && (imageFile?.status === 'success' || formData.coverImageId)
    );
  };

  const isStep2Valid = () => {
    return formData.entryLimit >= 1 && formData.entryLimit <= 10;
  };

  const isStep3Valid = () => {
    const totalPercentage = Object.values(formData.prizePositions).reduce(
      (sum, val) => sum + val,
      0
    );
    return totalPercentage <= 100;
  };

  // Calculate costs
  const getDurationCost = () => {
    const option = durationOptions.find((d) => d.value === formData.duration);
    return option?.cost ?? 0;
  };

  const getPrizeCustomizationCost = () => {
    return prizeCustomized ? 1000 : 0;
  };

  const getTotalCost = () => {
    return getDurationCost() + getPrizeCustomizationCost();
  };

  // Add a new prize position
  const addPrizePosition = () => {
    const positions = Object.keys(formData.prizePositions);
    const nextPosition = positions.length + 1;
    updateFormData({
      prizePositions: {
        ...formData.prizePositions,
        [nextPosition.toString()]: 0,
      },
    });
  };

  // Remove a prize position
  const removePrizePosition = (position: string) => {
    const newPositions = { ...formData.prizePositions };
    delete newPositions[position];
    // Renumber positions
    const renumbered: Record<string, number> = {};
    Object.entries(newPositions)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .forEach(([, value], index) => {
        renumbered[(index + 1).toString()] = value;
      });
    updateFormData({ prizePositions: renumbered });
  };

  // Reset prize distribution to default
  const resetPrizeDistribution = () => {
    updateFormData({ prizePositions: defaultPrizePositions });
    setPrizeCustomized(false);
    setPrizeEditMode(false);
  };

  // Enter prize edit mode
  const enterPrizeEditMode = () => {
    setPrizeEditMode(true);
    setPrizeCustomized(true);
  };

  const handleNext = () => {
    if (currentStep === 1 && !isStep1Valid()) return;
    if (currentStep === 2 && !isStep2Valid()) return;
    if (currentStep === 3 && !isStep3Valid()) return;
    goToNextStep();
  };

  // Submit the crucible creation form
  const handleSubmit = async () => {
    if (isSubmitting) return;

    // Validate image upload is complete
    if (!imageFile || imageFile.status !== 'success') {
      showErrorNotification({
        title: 'Missing Cover Image',
        error: { message: 'Please upload a cover image for your crucible.' },
      });
      return;
    }

    setIsSubmitting(true);

    createCrucibleMutation.mutate({
      name: formData.name.trim(),
      description: formData.description.trim() || 'No description provided',
      coverImage: {
        url: imageFile.url,
        width: imageFile.width,
        height: imageFile.height,
        hash: imageFile.hash,
      },
      nsfwLevel: formData.nsfwLevel,
      entryFee: formData.entryFee,
      entryLimit: formData.entryLimit,
      maxTotalEntries: formData.maxTotalEntries,
      prizePositions: formData.prizePositions,
      prizeCustomized, // Pass whether prize distribution was customized
      duration: parseInt(formData.duration),
    });
  };

  // Step content components
  const renderStep1 = () => (
    <Stack gap="xl">
      {/* Cover Image Upload */}
      <div>
        <Input.Wrapper
          label="Cover Image"
          description="This image appears on discovery cards (16:9 aspect ratio recommended)"
          withAsterisk
        >
          {imageFile && imageFile.progress < 100 ? (
            <Paper
              style={{ position: 'relative', marginTop: 5, width: '100%', height: 200 }}
              withBorder
            >
              <div className="flex h-full items-center justify-center">
                <Progress.Root size="xl" w="80%">
                  <Progress.Section
                    striped
                    animated
                    value={imageFile.progress}
                    color={imageFile.progress < 100 ? 'blue' : 'green'}
                  >
                    <Progress.Label>{Math.floor(imageFile.progress)}%</Progress.Label>
                  </Progress.Section>
                </Progress.Root>
              </div>
            </Paper>
          ) : imageFile?.status === 'success' ? (
            <div style={{ position: 'relative', width: '100%', marginTop: 8 }}>
              <Tooltip label="Remove image">
                <LegacyActionIcon
                  size="sm"
                  variant="filled"
                  color="red"
                  onClick={() => {
                    removeImage(imageFile.url);
                    updateFormData({ coverImageId: '' });
                  }}
                  className="absolute right-2 top-2 z-10"
                >
                  <IconTrash size={14} />
                </LegacyActionIcon>
              </Tooltip>
              <div className="overflow-hidden rounded-lg" style={{ aspectRatio: '16 / 9' }}>
                <EdgeMedia
                  src={imageFile.objectUrl ?? imageFile.url}
                  width={800}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </div>
            </div>
          ) : (
            <ImageDropzone
              mt={8}
              onDrop={handleDropImages}
              count={imageFiles.length}
              accept={IMAGE_MIME_TYPE}
              label="Drag & drop cover image here or click to browse"
            />
          )}
        </Input.Wrapper>
      </div>

      {/* Name */}
      <Input.Wrapper label="Crucible Name" description="Maximum 100 characters" withAsterisk>
        <Input
          mt={4}
          placeholder="e.g., Anime Character Design Challenge"
          value={formData.name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            updateFormData({ name: e.target.value.slice(0, 100) })
          }
          maxLength={100}
        />
      </Input.Wrapper>

      {/* Description */}
      <Input.Wrapper
        label="Description"
        description="Describe the theme, rules, or inspiration. Maximum 500 characters. (Optional)"
      >
        <Input
          mt={4}
          component="textarea"
          rows={4}
          placeholder="Describe the theme, rules, or inspiration for this crucible..."
          value={formData.description}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
            updateFormData({ description: e.target.value.slice(0, 500) })
          }
          maxLength={500}
          styles={{ input: { resize: 'vertical' } }}
        />
      </Input.Wrapper>

      {/* Duration */}
      <Input.Wrapper
        label="Duration"
        description="Duration determines how long the crucible accepts entries"
        withAsterisk
      >
        <SimpleGrid cols={{ base: 2, sm: 4 }} mt={8}>
          {durationOptions.map((option) => (
            <Tooltip key={option.value} label="Coming Soon" disabled={!option.disabled} withArrow>
              <Paper
                className={`cursor-pointer border p-3 text-center transition-all ${
                  formData.duration === option.value
                    ? 'border-blue-500 bg-blue-500/20'
                    : 'border-dark-4 hover:border-blue-500'
                } ${option.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                onClick={() => {
                  if (!option.disabled) {
                    updateFormData({ duration: option.value });
                  }
                }}
              >
                <Text size="sm" fw={500}>
                  {option.label}
                </Text>
                <div className="mt-1">
                  {option.isFree ? (
                    <Text size="xs" c="green" fw={700}>
                      FREE
                    </Text>
                  ) : (
                    <Group gap={4} justify="center">
                      <CurrencyIcon currency={Currency.BUZZ} size={12} />
                      <Text size="xs" c="yellow" fw={700}>
                        +{option.cost.toLocaleString()}
                      </Text>
                    </Group>
                  )}
                </div>
              </Paper>
            </Tooltip>
          ))}
        </SimpleGrid>
      </Input.Wrapper>

      {/* NSFW Level */}
      <BrowsingLevelsInput
        label="Allowed Content Levels"
        description="Users can only submit content matching these levels"
        value={formData.nsfwLevel}
        onChange={(value) => updateFormData({ nsfwLevel: value })}
      />
    </Stack>
  );

  const renderStep2 = () => (
    <Stack gap="xl">
      {/* Entry Fee */}
      <Input.Wrapper
        label="Entry Fee per User"
        description="How much Buzz users pay to enter their image"
      >
        <Group gap={8} mt={8}>
          <Input
            type="number"
            min={0}
            value={formData.entryFee}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              updateFormData({ entryFee: Math.max(0, parseInt(e.target.value) || 0) })
            }
            style={{ flex: 1 }}
            leftSection={<CurrencyIcon currency={Currency.BUZZ} size={16} />}
          />
          <Text fw={600} c="yellow">
            Buzz
          </Text>
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          {formData.entryFee === 0 ? (
            <Text span c="green">
              Free Entry (No Prize Pool)
            </Text>
          ) : (
            `${formData.entryFee} Buzz entry fee`
          )}
        </Text>
      </Input.Wrapper>

      {/* Entry Limit */}
      <Input.Wrapper
        label="Entry Limit per User"
        description="How many times can one user enter?"
        withAsterisk
      >
        <Input
          mt={8}
          component="select"
          value={formData.entryLimit}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
            updateFormData({ entryLimit: parseInt(e.target.value) })
          }
        >
          <option value="1">1 entry</option>
          <option value="2">2 entries</option>
          <option value="3">3 entries</option>
          <option value="5">5 entries</option>
          <option value="10">10 entries</option>
        </Input>
      </Input.Wrapper>

      {/* Max Total Entries */}
      <Input.Wrapper
        label="Maximum Total Entries"
        description="Optional limit on total entries across all users"
      >
        <Input
          mt={8}
          type="number"
          min={1}
          placeholder="No limit"
          value={formData.maxTotalEntries ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            updateFormData({
              maxTotalEntries: e.target.value ? parseInt(e.target.value) : undefined,
            })
          }
        />
      </Input.Wrapper>

      {/* Resource Requirements - Coming Soon */}
      <Tooltip label="Coming Soon - Premium feature" withArrow>
        <Input.Wrapper
          label="Resource Requirements"
          description="Models/LoRAs required for submissions"
          className="cursor-not-allowed opacity-50"
        >
          <Paper p="md" mt={8} className="border border-dark-4">
            <Group gap={8} mb="sm">
              <Input placeholder="Search models, LoRAs..." disabled style={{ flex: 1 }} />
              <ActionIcon variant="light" disabled>
                <IconPlus size={16} />
              </ActionIcon>
            </Group>
            <Text size="xs" c="dimmed">
              Require specific models or LoRAs for entries (Premium feature)
            </Text>
          </Paper>
        </Input.Wrapper>
      </Tooltip>
    </Stack>
  );

  const renderStep3 = () => {
    const totalPercentage = Object.values(formData.prizePositions).reduce(
      (sum, val) => sum + val,
      0
    );
    const sortedPositions = Object.entries(formData.prizePositions).sort(
      ([a], [b]) => parseInt(a) - parseInt(b)
    );
    const positionColors = [
      { bg: 'from-blue-500 to-blue-600', text: 'text-blue-4' },
      { bg: 'from-green-500 to-green-600', text: 'text-green-4' },
      { bg: 'from-yellow-500 to-yellow-600', text: 'text-yellow-4' },
    ];

    // Display Mode - Default view with "Customize" button
    if (!prizeEditMode) {
      return (
        <Stack gap="lg">
          {/* Visual Progress Bar */}
          <div>
            <Text size="xs" c="dimmed" fw={600} mb={8}>
              {prizeCustomized ? 'Custom Distribution' : 'Default Distribution'}
            </Text>
            <div className="mb-3 flex h-8 overflow-hidden rounded border border-dark-4">
              {sortedPositions.map(([position, percentage], index) => {
                const colorClass = positionColors[index]?.bg || 'from-gray-500 to-gray-600';
                return (
                  <div
                    key={position}
                    className={`flex items-center justify-center bg-gradient-to-r text-xs font-bold text-white ${colorClass}`}
                    style={{ flex: percentage || 0.1 }}
                  >
                    {percentage > 10 &&
                      `${position}${getOrdinalSuffix(parseInt(position))}: ${percentage}%`}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Distribution Summary Cards */}
          <SimpleGrid cols={{ base: 2, sm: 3 }}>
            {sortedPositions.slice(0, 3).map(([position, percentage]) => (
              <Paper key={position} p="md" className="border border-dark-4 text-center" bg="dark.7">
                <Text size="xs" c="dimmed" mb={6}>
                  {position}
                  {getOrdinalSuffix(parseInt(position))} Place
                </Text>
                <Text size="xl" fw={700}>
                  {percentage}%
                </Text>
              </Paper>
            ))}
          </SimpleGrid>

          {/* Additional positions if more than 3 */}
          {sortedPositions.length > 3 && (
            <Paper p="md" className="border border-dark-4">
              <Stack gap="xs">
                {sortedPositions.slice(3).map(([position, percentage]) => (
                  <Group key={position} justify="space-between">
                    <Text size="sm" c="dimmed">
                      {position}
                      {getOrdinalSuffix(parseInt(position))} Place
                    </Text>
                    <Text size="sm" fw={600}>
                      {percentage}%
                    </Text>
                  </Group>
                ))}
              </Stack>
            </Paper>
          )}

          {/* Customize Distribution Button */}
          <Button
            variant="filled"
            color="blue"
            onClick={enterPrizeEditMode}
            leftSection={<IconPencil size={16} />}
            rightSection={
              !prizeCustomized && (
                <span className="ml-2 rounded bg-yellow-500/20 px-2 py-0.5 text-xs font-bold text-yellow-4">
                  +1,000 Buzz
                </span>
              )
            }
          >
            {prizeCustomized ? 'Edit Distribution' : 'Customize Distribution'}
          </Button>
        </Stack>
      );
    }

    // Edit Mode - Sliders and add/remove functionality
    return (
      <Stack gap="lg">
        {/* Editing Header */}
        <Group gap="xs">
          <IconPencil size={16} className="text-blue-5" />
          <Text size="sm" c="blue" fw={600}>
            Editing Prize Distribution
          </Text>
        </Group>

        {/* Prize Rows with Sliders */}
        {sortedPositions.map(([position, percentage], index) => (
          <Paper key={position} p="md" className="border border-dark-4">
            <Group justify="space-between" align="center" gap="md">
              <Text size="sm" fw={600} style={{ width: 90 }}>
                {position}
                {getOrdinalSuffix(parseInt(position))} Place
              </Text>
              <Slider
                value={percentage}
                onChange={(value) => {
                  updateFormData({
                    prizePositions: {
                      ...formData.prizePositions,
                      [position]: value,
                    },
                  });
                }}
                min={0}
                max={100}
                step={1}
                style={{ flex: 1 }}
                color={
                  index === 0 ? 'blue' : index === 1 ? 'green' : index === 2 ? 'yellow' : 'gray'
                }
                styles={{
                  track: { height: 6 },
                  thumb: { borderWidth: 2 },
                }}
              />
              <Text size="sm" fw={700} style={{ width: 50, textAlign: 'right' }}>
                {percentage}%
              </Text>
              {/* Only show remove button for positions beyond top 3 */}
              {parseInt(position) > 3 && (
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size="sm"
                  onClick={() => removePrizePosition(position)}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              )}
            </Group>
          </Paper>
        ))}

        {/* Add Prize Position Button */}
        <Button
          variant="light"
          color="blue"
          onClick={addPrizePosition}
          leftSection={<IconPlus size={16} />}
        >
          Add Prize Position
        </Button>

        {/* Total Distribution Indicator */}
        <Paper p="md" className="border border-dark-4" bg="dark.7">
          <Group justify="space-between">
            <Text c="dimmed">Total Distribution</Text>
            <Group gap={4}>
              <Text size="lg" fw={700} c={totalPercentage <= 100 ? 'green' : 'red'}>
                {totalPercentage}
              </Text>
              <Text size="lg" fw={700} c={totalPercentage <= 100 ? 'green' : 'red'}>
                %
              </Text>
            </Group>
          </Group>
          {totalPercentage > 100 && (
            <Text size="xs" c="red" mt={4}>
              Prize percentages cannot exceed 100%
            </Text>
          )}
        </Paper>

        {/* Action Buttons */}
        <Group gap="md">
          <Button
            variant="light"
            color="gray"
            onClick={resetPrizeDistribution}
            leftSection={<IconArrowBackUp size={16} />}
            style={{ flex: 1 }}
          >
            Reset to Default
          </Button>
          <Button
            variant="filled"
            color="blue"
            onClick={() => setPrizeEditMode(false)}
            leftSection={<IconCheck size={16} />}
            style={{ flex: 1 }}
          >
            Done Editing
          </Button>
        </Group>
      </Stack>
    );
  };

  const renderStep4 = () => {
    // Calculate estimated start and end times
    const now = new Date();
    const estimatedStartAt = now;
    const durationHours = parseInt(formData.duration) || 8;
    const estimatedEndAt = new Date(now.getTime() + durationHours * 60 * 60 * 1000);

    // Format dates for display
    const formatDateTime = (date: Date) => {
      return date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    };

    return (
      <Stack gap="xl">
        <Title order={3}>Review Your Crucible</Title>

        {/* Timing Estimate */}
        <Paper p="lg" className="border border-blue-500/30 bg-blue-500/5">
          <Group gap="xs" mb="md">
            <IconCalendar size={20} className="text-blue-5" />
            <Text fw={600}>Estimated Schedule</Text>
          </Group>
          <Stack gap="sm">
            <Group justify="space-between">
              <Group gap="xs">
                <IconClock size={16} className="text-green-5" />
                <Text c="dimmed">Starts</Text>
              </Group>
              <Text fw={500} c="green">
                {formatDateTime(estimatedStartAt)} (Immediately)
              </Text>
            </Group>
            <Group justify="space-between">
              <Group gap="xs">
                <IconClock size={16} className="text-orange-5" />
                <Text c="dimmed">Ends</Text>
              </Group>
              <Text fw={500} c="orange">
                {formatDateTime(estimatedEndAt)}
              </Text>
            </Group>
          </Stack>
        </Paper>

        {/* Basic Info Summary */}
        <Paper p="lg" className="border border-dark-4">
          <Group gap="xs" mb="md">
            <IconInfoCircle size={20} className="text-blue-5" />
            <Text fw={600}>Basic Information</Text>
          </Group>
          <Stack gap="sm">
            <Group justify="space-between">
              <Text c="dimmed">Name</Text>
              <Text fw={500}>{formData.name || 'Not set'}</Text>
            </Group>
            <Group justify="space-between">
              <Text c="dimmed">Duration</Text>
              <Text fw={500}>
                {durationOptions.find((d) => d.value === formData.duration)?.label || '8 hours'}
              </Text>
            </Group>
            <Group justify="space-between">
              <Text c="dimmed">Description</Text>
              <Text fw={500} lineClamp={2} style={{ maxWidth: 300, textAlign: 'right' }}>
                {formData.description || 'None'}
              </Text>
            </Group>
          </Stack>
        </Paper>

        {/* Entry Rules Summary */}
        <Paper p="lg" className="border border-dark-4">
          <Group gap="xs" mb="md">
            <IconTicket size={20} className="text-blue-5" />
            <Text fw={600}>Entry Settings</Text>
          </Group>
          <Stack gap="sm">
            <Group justify="space-between">
              <Text c="dimmed">Entry Fee</Text>
              <CurrencyBadge unitAmount={formData.entryFee} currency={Currency.BUZZ} />
            </Group>
            <Group justify="space-between">
              <Text c="dimmed">Entry Limit per User</Text>
              <Text fw={500}>{formData.entryLimit} entries</Text>
            </Group>
            <Group justify="space-between">
              <Text c="dimmed">Max Total Entries</Text>
              <Text fw={500}>{formData.maxTotalEntries || 'Unlimited'}</Text>
            </Group>
          </Stack>
        </Paper>

        {/* Prize Distribution Summary */}
        <Paper p="lg" className="border border-dark-4">
          <Group gap="xs" mb="md">
            <IconTrophy size={20} className="text-blue-5" />
            <Text fw={600}>Prize Distribution</Text>
          </Group>
          <Stack gap="sm">
            {Object.entries(formData.prizePositions)
              .sort(([a], [b]) => parseInt(a) - parseInt(b))
              .map(([position, percentage]) => (
                <Group key={position} justify="space-between">
                  <Text c="dimmed">
                    {position}
                    {getOrdinalSuffix(parseInt(position))} Place
                  </Text>
                  <Text fw={500}>{percentage}%</Text>
                </Group>
              ))}
          </Stack>
        </Paper>
      </Stack>
    );
  };

  // Get the current step component
  const renderCurrentStep = () => {
    switch (currentStep) {
      case 1:
        return renderStep1();
      case 2:
        return renderStep2();
      case 3:
        return renderStep3();
      case 4:
        return renderStep4();
      default:
        return renderStep1();
    }
  };

  // Step labels
  const stepLabels = ['Basic Info', 'Entry Rules', 'Prizes', 'Review'];

  return (
    <Container size="lg" py="xl">
      <Grid gutter="xl">
        {/* Left Column - Form */}
        <Grid.Col span={{ base: 12, lg: 8 }}>
          {/* Header */}
          <Group gap="md" mb="xl">
            <BackButton url="/crucibles" />
            <div>
              <Title order={2}>Create Crucible</Title>
              <Text c="dimmed" size="sm">
                Set up a new creative competition
              </Text>
            </div>
          </Group>

          {/* Step Indicators */}
          <Group gap="xs" mb="xl">
            {stepLabels.map((label, index) => (
              <Paper
                key={label}
                className={`flex-1 cursor-pointer border p-2 text-center ${
                  currentStep === index + 1
                    ? 'border-blue-500 bg-blue-500/20'
                    : currentStep > index + 1
                    ? 'border-green-500 bg-green-500/10'
                    : 'border-dark-4'
                }`}
                onClick={() => {
                  // Allow navigating to previous steps
                  if (index + 1 < currentStep) {
                    setStep(index + 1);
                  }
                }}
              >
                <Text size="xs" c="dimmed">
                  Step {index + 1}
                </Text>
                <Text size="sm" fw={500}>
                  {label}
                </Text>
              </Paper>
            ))}
          </Group>

          {/* Section Card */}
          <Paper p="xl" className="border border-dark-4">
            <Group gap="sm" mb="lg" pb="md" className="border-b border-dark-4">
              <div className="flex size-8 items-center justify-center rounded-lg bg-blue-500/10">
                {currentStep === 1 && <IconInfoCircle size={18} className="text-blue-5" />}
                {currentStep === 2 && <IconTicket size={18} className="text-blue-5" />}
                {currentStep === 3 && <IconTrophy size={18} className="text-blue-5" />}
                {currentStep === 4 && <IconInfoCircle size={18} className="text-blue-5" />}
              </div>
              <Text fw={600}>{stepLabels[currentStep - 1]}</Text>
            </Group>

            {renderCurrentStep()}
          </Paper>

          {/* Navigation Buttons */}
          <Group justify="space-between" mt="xl">
            <Button
              variant="light"
              color="gray"
              onClick={goToPrevStep}
              disabled={currentStep === 1}
              leftSection={<IconArrowLeft size={16} />}
            >
              Previous
            </Button>
            <Button
              onClick={handleNext}
              disabled={
                (currentStep === 1 && !isStep1Valid()) ||
                (currentStep === 2 && !isStep2Valid()) ||
                (currentStep === 3 && !isStep3Valid())
              }
              style={{ display: currentStep === 4 ? 'none' : undefined }}
            >
              Next
            </Button>
          </Group>
        </Grid.Col>

        {/* Right Column - Preview & Costs */}
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <div className="sticky top-8">
            {/* Preview Card */}
            <Text size="xs" c="dimmed" fw={600} mb="sm" tt="uppercase">
              Preview
            </Text>
            <Paper className="mb-4 overflow-hidden border border-dark-4">
              <div
                className="flex items-center justify-center bg-gradient-to-br from-dark-6 to-dark-8"
                style={{ aspectRatio: '16 / 9' }}
              >
                {imageFile?.status === 'success' ? (
                  <EdgeMedia
                    src={imageFile.objectUrl ?? imageFile.url}
                    width={400}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <Text c="dimmed" size="xs">
                    No cover image
                  </Text>
                )}
              </div>
              <div className="p-3">
                <Text size="sm" fw={600} lineClamp={2} mb="sm">
                  {formData.name || 'Your Crucible Name'}
                </Text>
                <Group justify="space-between" gap={4}>
                  <div className="text-center">
                    <Text size="sm" fw={600}>
                      {formData.entryFee}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Entry
                    </Text>
                  </div>
                  <div className="text-center">
                    <Text size="sm" fw={600}>
                      {durationOptions.find((d) => d.value === formData.duration)?.label || '8h'}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Duration
                    </Text>
                  </div>
                  <div className="text-center">
                    <Text size="sm" fw={600}>
                      0
                    </Text>
                    <Text size="xs" c="dimmed">
                      Entries
                    </Text>
                  </div>
                </Group>
              </div>
            </Paper>

            {/* Create Button (only on final step) */}
            {currentStep === 4 && (
              <Button
                fullWidth
                size="lg"
                mb="md"
                className="bg-gradient-to-r from-yellow-500 to-yellow-600"
                leftSection={
                  isSubmitting ? <Loader size={20} color="dark" /> : <IconCoin size={20} />
                }
                onClick={handleSubmit}
                disabled={isSubmitting}
              >
                {isSubmitting
                  ? 'Creating Crucible...'
                  : getTotalCost() === 0
                  ? 'Create Crucible - Free'
                  : `Create Crucible - ${getTotalCost().toLocaleString()} Buzz`}
              </Button>
            )}

            {/* Cost Breakdown */}
            <Paper p="md" className="border border-dark-4">
              <Text size="xs" c="dimmed" fw={600} mb="md" tt="uppercase">
                Cost Breakdown
              </Text>
              <Stack gap="xs">
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    Duration
                  </Text>
                  <Text size="sm" c="yellow" fw={600}>
                    {getDurationCost() === 0
                      ? 'Free'
                      : `+${getDurationCost().toLocaleString()} Buzz`}
                  </Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    Entry Limit
                  </Text>
                  <Text size="sm" c="yellow" fw={600}>
                    Free
                  </Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    Prize Customization
                  </Text>
                  <Text size="sm" c="yellow" fw={600}>
                    {getPrizeCustomizationCost() === 0
                      ? 'Free'
                      : `+${getPrizeCustomizationCost().toLocaleString()} Buzz`}
                  </Text>
                </Group>
                <div className="mt-2 border-t border-dark-4 pt-3">
                  <Group justify="space-between">
                    <Text size="sm" fw={600}>
                      Total Cost
                    </Text>
                    <Text size="md" c="yellow" fw={700}>
                      {getTotalCost() === 0 ? 'Free' : `${getTotalCost().toLocaleString()} Buzz`}
                    </Text>
                  </Group>
                </div>
              </Stack>
            </Paper>
          </div>
        </Grid.Col>
      </Grid>
    </Container>
  );
}

// Helper function for ordinal suffixes
function getOrdinalSuffix(num: number): string {
  const j = num % 10;
  const k = num % 100;
  if (j === 1 && k !== 11) return 'st';
  if (j === 2 && k !== 12) return 'nd';
  if (j === 3 && k !== 13) return 'rd';
  return 'th';
}
