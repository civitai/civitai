import { Box, useMantineTheme } from '@mantine/core';
import { Adunit } from '~/components/Ads/AdUnit';
import OnboardingWizard from '~/components/Onboarding/OnboardingWizard';

export default function Test() {
  const theme = useMantineTheme();
  const onComplete = () => console.log('complete');
  return <OnboardingWizard onComplete={onComplete} />;
}
