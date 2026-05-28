/**
 * Model3DGenerationForm
 *
 * The "3D Model" tab of the generation panel. Two sub-tabs:
 *   - text-to-3D (`process: 'textTo3D'`)
 *   - image-to-3D (`process: 'imageTo3D'`)
 *
 * Mirrors the shape of VideoGenerationForm / SoraFormInput conceptually:
 * react-hook-form bound to the shared Zod schema from workstream B
 * (`textTo3DSchema` / `imageTo3DSchema` discriminated on `process`), with
 * an inline cost preview powered by the orchestrator `whatif` query.
 *
 * On submit the form calls the `generate3D` tRPC mutation, which in turn
 * calls `submitPolyGenWorkflow` server-side. The Draft Model3D row is
 * created later by the workflow result handler (workstream B); workstream G
 * picks up "Post from Generation" once that flow is wired.
 */

import { Button, Input, Notification, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { z } from 'zod';

import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { DailyBoostRewardClaim } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { GenForm } from '~/components/Generation/Form/GenForm';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { InputPrompt } from '~/components/Generate/Input/InputPrompt';
import { BuzzTypeSelector, useSelectedBuzzType } from '~/components/generation_v2/FormFooter';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  InputCheckbox,
  InputNumberSlider,
  InputSegmentedControl,
  InputTextArea,
} from '~/libs/form';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import {
  model3dGenerationSchema,
  polygenSymmetryModes,
  polygenTextModes,
  polygenTopologies,
  type Model3DGenerationSchema,
} from '~/server/orchestrator/polygen/polygen.schema';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { defaultWorkflowCost } from '~/shared/orchestrator/workflow-data';
import { generationFormStore } from '~/store/generation-form.store';
import { useDebouncer } from '~/utils/debouncer';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const STORAGE_KEY = 'generation-form-model3d';

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

/**
 * The form's effective Zod schema is a `discriminatedUnion('process')` so
 * `prompt` is required only for `textTo3D` and `sourceImage` only for
 * `imageTo3D`. usePersistForm needs a single object schema to seed default
 * values; we pass the discriminated union and let it pick the right
 * variant at validate-time.
 */
type Model3DFormValues = z.input<typeof model3dGenerationSchema>;

export function Model3DGenerationForm() {
  const currentUser = useCurrentUser();
  const [error, setError] = useState<string | undefined>();
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
    onError: (e) => setError(e.message),
  });

  const process = form.watch('process');

  function handleProcessChange(next: 'textTo3D' | 'imageTo3D') {
    form.setValue('process', next, { shouldDirty: true, shouldValidate: false });
  }

  function handleReset() {
    form.reset(defaultValues, { keepDefaultValues: false });
    setError(undefined);
  }

  function handleSubmit(data: Model3DGenerationSchema) {
    if (generate3D.isPending || isLoadingDebounced) return;
    if (!currentUser) {
      setError('You must be signed in to generate.');
      return;
    }
    setError(undefined);
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
      form={form as any}
      onSubmit={handleSubmit as any}
      className="relative flex h-full flex-1 flex-col justify-between gap-2"
    >
      <div className="flex flex-col gap-3 px-2">
        <div className="flex flex-col gap-0.5">
          <Input.Label>Process</Input.Label>
          <InputSegmentedControl
            name="process"
            data={[
              { label: 'Text to 3D', value: 'textTo3D' },
              { label: 'Image to 3D', value: 'imageTo3D' },
            ]}
            onChange={(v) => handleProcessChange(v as 'textTo3D' | 'imageTo3D')}
          />
        </div>

        {process === 'imageTo3D' && (
          <div className="flex flex-col gap-2">
            <Input.Label required>Starting image</Input.Label>
            <InputSourceImageUpload name="sourceImage" />
            <InputCheckbox name="shouldTexture" label="Generate texture" />
          </div>
        )}

        {process === 'textTo3D' && (
          <>
            <InputPrompt
              required
              name="prompt"
              label="Prompt"
              placeholder="A low-poly fantasy treasure chest..."
              autosize
            />
            <div className="flex flex-col gap-0.5">
              <Input.Label>Mode</Input.Label>
              <InputSegmentedControl
                name="mode"
                data={polygenTextModes.map((value) => ({
                  label: value === 'full' ? 'Full' : 'Preview',
                  value,
                }))}
              />
            </div>
            <InputCheckbox
              name="enablePromptExpansion"
              label="Auto-expand prompt"
            />
          </>
        )}

        <InputNumberSlider
          name="targetPolycount"
          label="Target Polycount"
          min={100}
          max={300_000}
          step={100}
        />

        <div className="flex flex-col gap-0.5">
          <Input.Label>Topology</Input.Label>
          <InputSegmentedControl
            name="topology"
            data={polygenTopologies.map((value) => ({
              label: value === 'quad' ? 'Quad' : 'Triangle',
              value,
            }))}
          />
        </div>

        <div className="flex flex-col gap-0.5">
          <Input.Label>Symmetry</Input.Label>
          <InputSegmentedControl
            name="symmetryMode"
            data={polygenSymmetryModes.map((value) => ({
              label: value === 'off' ? 'Off' : value === 'on' ? 'On' : 'Auto',
              value,
            }))}
          />
        </div>

        <InputCheckbox name="shouldRemesh" label="Remesh" />
        <InputCheckbox name="enablePbr" label="Enable PBR textures" />

        <InputTextArea
          name="texturePrompt"
          label="Texture prompt"
          placeholder="Describe the texture / material style..."
          maxLength={600}
          autosize
        />

        <InputCheckbox name="enableRigging" label="Enable rigging" />
        <InputCheckbox name="enableAnimation" label="Enable animation" />

        <InputSeed name="seed" label="Seed" />
      </div>

      <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
        <DailyBoostRewardClaim />
        {!error ? (
          <Model3DCostPreview />
        ) : (
          <Notification
            icon={<IconX size={18} />}
            color="red"
            onClose={() => setError(undefined)}
            className="rounded-md bg-red-8/20"
          >
            {error}
          </Notification>
        )}
        <div className="flex gap-2">
          <Model3DSubmitButton
            loading={generate3D.isPending || isLoadingDebounced}
            setError={setError}
          />
          <Button onClick={handleReset} variant="default" className="h-auto px-3">
            Reset
          </Button>
        </div>
      </div>
    </GenForm>
  );
}

// =============================================================================
// Cost preview (debounced whatif)
// =============================================================================

/**
 * Fields that do not affect cost. We strip these before the debounced whatif
 * call so identical-cost edits (e.g. typing in the prompt) don't thrash the
 * orchestrator.
 */
const WHATIF_EXCLUDE_KEYS = new Set(['prompt', 'texturePrompt', 'seed']);

function Model3DSubmitButton({
  loading,
  setError,
}: {
  loading: boolean;
  setError: (e?: string) => void;
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
        // Drop fields that don't influence cost so two cost-identical edits
        // don't re-fire the network call.
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
    setError(error?.message);
  }, [error, setError]);

  const cost = queryData?.cost?.total ?? 0;

  const { selectedType } = useSelectedBuzzType();
  const { color } = useBuzzCurrencyConfig(selectedType);

  return (
    <Button.Group className="flex-1">
      <GenerateButton
        type="submit"
        className="flex-1"
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

function Model3DCostPreview() {
  // Cheap inline placeholder; the real cost lives in `Model3DSubmitButton`'s
  // `BuzzTypeSelector` (mirrors the existing image/video form footer).
  // We keep this slot so the layout doesn't jump when an error notification
  // appears in its place.
  const data = useMemo(() => defaultWorkflowCost, []);
  return (
    <Text size="xs" c="dimmed" className="text-center">
      Base cost preview: {numberWithCommas(data.base)} Buzz · Total updated on the Generate button.
    </Text>
  );
}
