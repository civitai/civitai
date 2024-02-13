import { useRouter } from 'next/router';
import OnboardingWizard from '~/components/Onboarding/OnboardingWizard';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';

export default function OnboardingPage() {
  const router = useRouter();
  const returnUrl = router.query.returnUrl as string;
  const handleComplete = () => {
    router.replace(returnUrl);
  };

  return (
    <ScrollArea py="md">
      <OnboardingWizard onComplete={handleComplete} />
    </ScrollArea>
  );
}

OnboardingPage.getLayout = function getLayout(page: any) {
  return <>{page}</>;
};
