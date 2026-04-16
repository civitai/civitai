import {
  Alert,
  Checkbox,
  Container,
  Divider,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { isDev } from '~/env/other';
import { useDomainColor } from '~/hooks/useDomainColor';
import { OnboardingSteps } from '~/server/common/enums';

const OnboardingWizard = dynamic(() => import('~/components/Onboarding/OnboardingWizard'));

const STEP_OPTIONS: { value: OnboardingSteps; label: string }[] = [
  { value: OnboardingSteps.TOS, label: 'TOS' },
  { value: OnboardingSteps.RedTOS, label: 'RedTOS' },
  { value: OnboardingSteps.Profile, label: 'Profile' },
  { value: OnboardingSteps.BrowsingLevels, label: 'BrowsingLevels' },
  { value: OnboardingSteps.Buzz, label: 'Buzz' },
];

export default function DevOnboardingPage() {
  const router = useRouter();
  const domain = useDomainColor();
  const defaultSelection = useMemo<OnboardingSteps[]>(
    () =>
      domain === 'green'
        ? [OnboardingSteps.TOS, OnboardingSteps.Profile, OnboardingSteps.Buzz]
        : [
            OnboardingSteps.TOS,
            OnboardingSteps.Profile,
            OnboardingSteps.BrowsingLevels,
            OnboardingSteps.Buzz,
          ],
    [domain]
  );
  const [selected, setSelected] = useState<OnboardingSteps[]>(defaultSelection);
  const [startStep, setStartStep] = useState<OnboardingSteps>(defaultSelection[0]);
  const [iteration, setIteration] = useState(0);

  useEffect(() => {
    const { step } = router.query;
    if (typeof step !== 'string') return;
    const match = STEP_OPTIONS.find((o) => o.label.toLowerCase() === step.toLowerCase());
    if (match) setStartStep(match.value);
  }, [router.query]);

  if (!isDev) return <NotFound />;

  const toggle = (step: OnboardingSteps) => {
    setSelected((prev) =>
      prev.includes(step) ? prev.filter((s) => s !== step) : [...prev, step]
    );
  };

  const orderedSelection = STEP_OPTIONS.map((o) => o.value).filter((v) => selected.includes(v));
  const startInSelection = orderedSelection.includes(startStep)
    ? startStep
    : orderedSelection[0];
  const wizardKey = `${iteration}-${startInSelection}-${orderedSelection.join(',')}`;

  return (
    <Container size="md" py="md">
      <Stack>
        <Title order={2}>Onboarding Preview (dev only)</Title>
        <Alert color="yellow" variant="light">
          Preview mode — step mutations are skipped, nothing writes to your user. Abort button still
          signs you out. Append <code>?step=Buzz</code> etc. to jump to a step.
        </Alert>
        <Paper withBorder p="md">
          <Stack gap="xs">
            <Text fw={500}>Steps to render</Text>
            <Group>
              {STEP_OPTIONS.map((opt) => (
                <Checkbox
                  key={opt.value}
                  label={opt.label}
                  checked={selected.includes(opt.value)}
                  onChange={() => toggle(opt.value)}
                />
              ))}
            </Group>
            <Select
              label="Jump to step"
              data={STEP_OPTIONS.filter((o) => selected.includes(o.value)).map((o) => ({
                value: String(o.value),
                label: o.label,
              }))}
              value={String(startInSelection ?? '')}
              onChange={(v) => v && setStartStep(Number(v) as OnboardingSteps)}
              allowDeselect={false}
              comboboxProps={{ withinPortal: false }}
            />
            <Text size="xs" c="dimmed">
              Reorder follows enum order (TOS, RedTOS, Profile, BrowsingLevels, Buzz). Wizard
              remounts on selection or start-step change.
            </Text>
          </Stack>
        </Paper>
        <Divider />
        <Paper withBorder p="md">
          {orderedSelection.length === 0 ? (
            <Text c="dimmed">Select at least one step.</Text>
          ) : (
            <OnboardingWizard
              key={wizardKey}
              stepsOverride={orderedSelection}
              startStep={startInSelection}
              isPreview
              onComplete={() => setIteration((n) => n + 1)}
            />
          )}
        </Paper>
      </Stack>
    </Container>
  );
}
