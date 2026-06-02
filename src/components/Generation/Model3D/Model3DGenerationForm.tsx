/**
 * Model3DGenerationForm
 *
 * The "3D Models" tab of the V2 generation panel (PolyGen / Meshy).
 *
 * Visually mirrors the standard V2 forms (Image / Video / Audio): inputs
 * are flat-listed top-down with V2 primitives (PromptInput, SliderInput,
 * ButtonGroupInput, Checkbox with description, AccordionLayout). The
 * submit + cost preview render through the shared GenerationFooter slot
 * so the sticky footer chrome (DailyBoost, status, terms) comes from
 * GenerationLayout — matching every other workflow.
 *
 * RHF-backed (not data-graph-backed) because the PolyGen schema is a
 * Zod discriminated union (`process: textTo3D | imageTo3D`) and the
 * server contract is fixed (`trpc.orchestrator.generate3D`). We bind
 * V2 visual primitives via react-hook-form `Controller`.
 */

import {
  ActionIcon,
  Button,
  Checkbox,
  Input,
  Notification,
  Stack,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconRestore, IconX } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { z } from 'zod';

import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { GenForm } from '~/components/Generation/Form/GenForm';
import { AccordionLayout } from '~/components/generation_v2/AccordionLayout';
import { BuzzTypeSelector, useSelectedBuzzType } from '~/components/generation_v2/FormFooter';
import { GenerationFooter } from '~/components/generation_v2/GenerationLayout';
import { ImageUploadMultipleInput } from '~/components/generation_v2/inputs/ImageUploadMultipleInput';
import type { ImageValue } from '~/components/generation_v2/inputs/ImageUploadMultipleInput';
import { PromptInput } from '~/components/generation_v2/inputs/PromptInput';
import { SliderInput } from '~/components/generation_v2/inputs/SliderInput';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ButtonGroupInput } from '~/libs/form/components/ButtonGroupInput';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import {
  model3dGenerationSchema,
  polygenSymmetryModes,
  polygenTextModes,
  polygenTopologies,
  type Model3DGenerationSchema,
} from '~/server/orchestrator/polygen/polygen.schema';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { generationFormStore } from '~/store/generation-form.store';
import { useDebouncer } from '~/utils/debouncer';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const STORAGE_KEY = 'generation-form-model3d';
const FORM_ID = 'generation-form-model3d';

/**
 * Default values for the unified form. The discriminator (`process`) is
 * controlled by the sub-tab selector and rewritten when the user toggles
 * between text-to-3D and image-to-3D. We keep one persisted form (not two)
 * so users can swap modes without losing common values like polycount.
 *
 * `process` defaults to text-to-3D because it requires no upload to start.
 */
const defaultValues = {
  process: 'textTo3D' as const,
  prompt: '',
  mode: 'full' as const,
  enablePromptExpansion: false,
  // Shared Meshy fields
  targetPolycount: 30_000,
  topology: 'triangle' as const,
  symmetryMode: 'auto' as const,
  shouldRemesh: true,
  enablePbr: false,
  texturePrompt: '',
  enableRigging: false,
  enableAnimation: false,
  seed: undefined,
  // image-to-3D-only fields (ignored when process=textTo3D)
  sourceImage: undefined,
  shouldTexture: true,
};

type Model3DFormValues = z.input<typeof model3dGenerationSchema>;

// Picker option lists — built once.
const processOptions = [
  { label: 'Text to 3D', value: 'textTo3D' },
  { label: 'Image to 3D', value: 'imageTo3D' },
];
const modeOptions = polygenTextModes.map((value) => ({
  label: value === 'full' ? 'Full' : 'Preview',
  value,
}));
const topologyOptions = polygenTopologies.map((value) => ({
  label: value === 'quad' ? 'Quad' : 'Triangle',
  value,
}));
const symmetryOptions = polygenSymmetryModes.map((value) => ({
  label: value === 'off' ? 'Off' : value === 'on' ? 'On' : 'Auto',
  value,
}));
const polycountPresets = [
  { label: '5k', value: 5_000 },
  { label: '30k', value: 30_000 },
  { label: '100k', value: 100_000 },
  { label: '300k', value: 300_000 },
];

export function Model3DGenerationForm() {
  const currentUser = useCurrentUser();
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [whatIfError, setWhatIfError] = useState<string | undefined>();
  const [isLoadingDebounced, setIsLoadingDebounced] = useState(false);

  const { conditionalPerformTransaction } = useBuzzTransaction({
    accountTypes: buzzSpendTypes,
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  const form = usePersistForm(STORAGE_KEY, {
    schema: model3dGenerationSchema,
    version: 1,
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    defaultValues,
    storage: typeof window !== 'undefined' ? localStorage : undefined,
  });

  const generate3D = trpc.orchestrator.generate3D.useMutation({
    onError: (e) => setSubmitError(e.message),
  });

  const process = form.watch('process');
  const prompt = form.watch('prompt');
  const sourceImage = form.watch('sourceImage');

  // Mirror V2's PriorityAlertSpace "missing field guidance" — friendly
  // helper text in blue that tells the user what's still needed before
  // they can submit. Not an error; clears as soon as the field is valid.
  const missingFieldMessage = useMemo<string | undefined>(() => {
    if (process === 'textTo3D' && !String(prompt ?? '').trim()) {
      return 'Add a prompt to start generating.';
    }
    if (process === 'imageTo3D' && !sourceImage) {
      return 'Upload a starting image to start generating.';
    }
    return undefined;
  }, [process, prompt, sourceImage]);

  function handleReset() {
    form.reset(defaultValues, { keepDefaultValues: false });
    setSubmitError(undefined);
    setWhatIfError(undefined);
  }

  function handleSubmit(data: Model3DGenerationSchema) {
    if (generate3D.isPending || isLoadingDebounced) return;
    if (!currentUser) {
      setSubmitError('You must be signed in to generate.');
      return;
    }
    setSubmitError(undefined);
    setIsLoadingDebounced(true);

    const { buzzType } = generationFormStore.getState();
    conditionalPerformTransaction(0, () => {
      generate3D.mutate(
        {
          input: data,
          ...(buzzType ? { buzzType } : {}),
        },
        {
          onSettled: () => {
            setTimeout(() => setIsLoadingDebounced(false), 500);
          },
        }
      );
    });
  }

  return (
    <GenForm
      id={FORM_ID}
      form={form as any}
      onSubmit={handleSubmit as any}
      className="relative flex flex-1 flex-col gap-3"
    >
      {/* Process picker — same look as V2 mode pickers */}
      <Controller
        name="process"
        control={form.control}
        render={({ field }) => (
          <Input.Wrapper label="Process">
            <ButtonGroupInput
              value={field.value as string}
              onChange={(v) => field.onChange(v)}
              data={processOptions}
            />
          </Input.Wrapper>
        )}
      />

      {/* Image-to-3D inputs */}
      {process === 'imageTo3D' && (
        <Stack gap="sm">
          <Controller
            name="sourceImage"
            control={form.control}
            render={({ field, fieldState }) => {
              const current = field.value as ImageValue | undefined;
              return (
                <ImageUploadMultipleInput
                  label="Starting image"
                  description="The reference Meshy will use to build the 3D mesh"
                  required
                  max={1}
                  aspect="square"
                  imageLayout="wrap"
                  value={current ? [current] : []}
                  onChange={(v) => field.onChange(v[0] ?? undefined)}
                  error={fieldState.error?.message}
                />
              );
            }}
          />
          <Controller
            name="shouldTexture"
            control={form.control}
            render={({ field }) => (
              <Checkbox
                label="Generate texture"
                description="Apply automatic texture to the generated mesh"
                checked={!!field.value}
                onChange={(e) => field.onChange(e.currentTarget.checked)}
              />
            )}
          />
        </Stack>
      )}

      {/* Text-to-3D inputs */}
      {process === 'textTo3D' && (
        <>
          <Controller
            name="prompt"
            control={form.control}
            render={({ field, fieldState }) => (
              <Input.Wrapper label="Prompt" required error={fieldState.error?.message}>
                <PromptInput
                  value={field.value as string}
                  onChange={(v) => field.onChange(v)}
                  placeholder="A low-poly fantasy treasure chest…"
                  minRows={2}
                  autosize
                />
              </Input.Wrapper>
            )}
          />
          <Controller
            name="mode"
            control={form.control}
            render={({ field }) => (
              <Input.Wrapper
                label="Mode"
                description="Preview is faster and cheaper. Full produces the higher-quality mesh."
              >
                <ButtonGroupInput
                  value={field.value as string}
                  onChange={field.onChange}
                  data={modeOptions}
                />
              </Input.Wrapper>
            )}
          />
          <Controller
            name="enablePromptExpansion"
            control={form.control}
            render={({ field }) => (
              <Checkbox
                label="Auto-expand prompt"
                description="Let Meshy elaborate sparse prompts before generation"
                checked={!!field.value}
                onChange={(e) => field.onChange(e.currentTarget.checked)}
              />
            )}
          />
        </>
      )}

      {/* Shared Meshy controls */}
      <Controller
        name="targetPolycount"
        control={form.control}
        render={({ field }) => (
          <SliderInput
            label="Target polycount"
            description="Final triangle count target. Higher = more detail, more cost."
            value={field.value as number}
            onChange={field.onChange}
            min={100}
            max={300_000}
            step={100}
            presets={polycountPresets}
          />
        )}
      />

      <Controller
        name="topology"
        control={form.control}
        render={({ field }) => (
          <Input.Wrapper label="Topology">
            <ButtonGroupInput
              value={field.value as string}
              onChange={field.onChange}
              data={topologyOptions}
            />
          </Input.Wrapper>
        )}
      />

      <Controller
        name="symmetryMode"
        control={form.control}
        render={({ field }) => (
          <Input.Wrapper label="Symmetry">
            <ButtonGroupInput
              value={field.value as string}
              onChange={field.onChange}
              data={symmetryOptions}
            />
          </Input.Wrapper>
        )}
      />

      {/* Advanced — collapsible to match V2 forms */}
      <AccordionLayout
        label="Advanced"
        storeKey="generation-form-model3d-advanced"
        defaultOpen={false}
      >
        <Controller
          name="shouldRemesh"
          control={form.control}
          render={({ field }) => (
            <Checkbox
              label="Remesh"
              description="Re-tessellate the mesh for cleaner topology"
              checked={!!field.value}
              onChange={(e) => field.onChange(e.currentTarget.checked)}
            />
          )}
        />
        <Controller
          name="enablePbr"
          control={form.control}
          render={({ field }) => (
            <Checkbox
              label="Enable PBR textures"
              description="Generate physically-based rendering textures (albedo, normal, roughness)"
              checked={!!field.value}
              onChange={(e) => field.onChange(e.currentTarget.checked)}
            />
          )}
        />
        <Controller
          name="texturePrompt"
          control={form.control}
          render={({ field }) => (
            <Textarea
              label="Texture prompt"
              description="Describe the material / style for the texture"
              placeholder="Weathered oak with bronze fittings…"
              value={(field.value as string) ?? ''}
              onChange={(e) => field.onChange(e.currentTarget.value)}
              autosize
              minRows={2}
              maxLength={600}
            />
          )}
        />
        <Controller
          name="enableRigging"
          control={form.control}
          render={({ field }) => (
            <Checkbox
              label="Enable rigging"
              description="Add a skeleton to the mesh for animation"
              checked={!!field.value}
              onChange={(e) => field.onChange(e.currentTarget.checked)}
            />
          )}
        />
        <Controller
          name="enableAnimation"
          control={form.control}
          render={({ field }) => (
            <Checkbox
              label="Enable animation"
              description="Generate idle animation for the rigged mesh"
              checked={!!field.value}
              onChange={(e) => field.onChange(e.currentTarget.checked)}
            />
          )}
        />
        <InputSeed name="seed" label="Seed" />
      </AccordionLayout>

      {/* Footer — rendered into the shared sticky chrome from GenerationLayout */}
      <GenerationFooter>
        <PriorityAlert
          missingFieldMessage={missingFieldMessage}
          whatIfError={whatIfError}
          submitError={submitError}
          onClearSubmitError={() => setSubmitError(undefined)}
        />
        <div className="flex h-[52px] items-stretch gap-2">
          <Model3DSubmitButton
            loading={generate3D.isPending || isLoadingDebounced}
            setWhatIfError={setWhatIfError}
          />
          <Tooltip label="Reset">
            <ActionIcon
              onClick={handleReset}
              variant="default"
              className="h-auto"
              size="xl"
              aria-label="Reset form"
            >
              <IconRestore size={16} />
            </ActionIcon>
          </Tooltip>
        </div>
      </GenerationFooter>
    </GenForm>
  );
}

// =============================================================================
// Cost preview (debounced whatif) + submit button
// =============================================================================

/**
 * Fields that do not affect cost. We strip these before the debounced whatif
 * call so identical-cost edits (e.g. typing in the prompt) don't thrash the
 * orchestrator.
 */
const WHATIF_EXCLUDE_KEYS = new Set(['prompt', 'texturePrompt', 'seed']);

/**
 * Mirrors V2 PriorityAlertSpace (FormFooter.tsx). Only one alert renders at
 * a time, in priority order: missing-field guidance (blue, info), whatIf
 * cost-estimate error (red, no close), submit error (red, dismissible).
 */
function PriorityAlert({
  missingFieldMessage,
  whatIfError,
  submitError,
  onClearSubmitError,
}: {
  missingFieldMessage?: string;
  whatIfError?: string;
  submitError?: string;
  onClearSubmitError: () => void;
}) {
  let alert: ReactNode = null;
  if (missingFieldMessage) {
    alert = (
      <Notification
        icon={<IconAlertTriangle size={18} />}
        color="blue"
        className="whitespace-pre-wrap rounded-md bg-blue-8/20"
        withCloseButton={false}
      >
        {missingFieldMessage}
      </Notification>
    );
  } else if (whatIfError) {
    alert = (
      <Notification
        icon={<IconX size={18} />}
        color="red"
        className="whitespace-pre-wrap rounded-md bg-red-8/20"
        withCloseButton={false}
      >
        {whatIfError}
      </Notification>
    );
  } else if (submitError) {
    alert = (
      <Notification
        icon={<IconX size={18} />}
        color="red"
        onClose={onClearSubmitError}
        className="whitespace-pre-wrap rounded-md bg-red-8/20"
      >
        {submitError}
      </Notification>
    );
  }
  return <>{alert}</>;
}

function Model3DSubmitButton({
  loading,
  setWhatIfError,
}: {
  loading: boolean;
  setWhatIfError: (e?: string) => void;
}) {
  const { getValues, watch } = useFormContext<Model3DFormValues>();
  const status = useGenerationStatus();
  const [query, setQuery] = useState<Model3DGenerationSchema | null>(null);
  const [canQuery, setCanQuery] = useState(false);
  const debouncer = useDebouncer(300);
  const debouncedDataRef = useRef<string>('');

  // Debounce form-change → whatif input. We feed the same Zod-validated
  // form data the submit mutation uses, so cost-preview parity is automatic.
  useEffect(() => {
    function syncQuery() {
      debouncer(() => {
        const raw = getValues();
        const filtered = Object.fromEntries(
          Object.entries(raw).filter(([k]) => !WHATIF_EXCLUDE_KEYS.has(k))
        );
        const fp = JSON.stringify(filtered);
        if (fp === debouncedDataRef.current) return;
        debouncedDataRef.current = fp;
        const parsed = model3dGenerationSchema.safeParse(raw);
        setQuery(parsed.success ? parsed.data : null);
      });
    }
    syncQuery();
    const sub = watch(() => syncQuery());
    return sub.unsubscribe;
  }, [debouncer, getValues, watch]);

  // First call delayed slightly so the form initializes before whatif fires.
  useEffect(() => {
    const t = setTimeout(() => setCanQuery(true), 500);
    return () => clearTimeout(t);
  }, []);

  const {
    data: queryData,
    isFetching,
    error,
  } = trpc.orchestrator.generate3DWhatIf.useQuery(query!, {
    enabled: !!query && canQuery,
  });

  useEffect(() => {
    setWhatIfError(error?.message);
  }, [error, setWhatIfError]);

  const cost = queryData?.cost?.total ?? 0;

  const { selectedType } = useSelectedBuzzType();
  const { color } = useBuzzCurrencyConfig(selectedType);

  return (
    <Button.Group className="flex-1">
      <GenerateButton
        type="submit"
        form={FORM_ID}
        className="h-full flex-1 px-2"
        color={color}
        disabled={!query || !status.available}
        loading={isFetching || loading}
      >
        Generate
      </GenerateButton>
      <BuzzTypeSelector cost={cost} loading={isFetching} />
    </Button.Group>
  );
}
