import { Box, BoxProps, Button, Group, Text, Title } from '@mantine/core';

declare const gtag: (...args: any[]) => void;

export function ConsentForm(props: BoxProps) {
  const acceptAll = () => setConsent({ necessary: true, marketing: true });
  const onlyNecessary = () => setConsent({ necessary: true, marketing: false });

  return (
    <Box {...props}>
      <Title>Cookie Settings</Title>
      <Text>
        We use cookies to provide you with the best possible experience. They also allow us to
        analyze user behavior in order to constantly improve the website for you.
      </Text>
      <Group>
        <Button>Accept All</Button>
        <Button>Only Necessary</Button>
      </Group>
    </Box>
  );
}

type ConsentProps = {
  necessary: boolean;
  marketing: boolean;
};

function setConsent(consent: ConsentProps) {
  const consentMode = {
    functionality_storage: consent.necessary ? 'granted' : 'denied',
    security_storage: consent.necessary ? 'granted' : 'denied',
    ad_storage: consent.marketing ? 'granted' : 'denied',
    ad_user_data: consent.marketing ? 'granted' : 'denied',
    ad_personalization: consent.marketing ? 'granted' : 'denied',
  };
  gtag('consent', 'update', consentMode);
  localStorage.setItem('consentMode', JSON.stringify(consentMode));
}
