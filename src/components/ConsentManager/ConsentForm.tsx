import { Box, BoxProps, Button, Group, Text, Title } from '@mantine/core';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

declare const gtag: (...args: any[]) => void;

type ConsentProps = {
  marketing: boolean;
};

export const useConsentMode = create<{ consentMode?: ConsentProps }>()(
  persist(() => ({}), { name: 'consentMode' })
);

export function ConsentForm(props: BoxProps) {
  const acceptAll = () => setConsent({ marketing: true });
  const onlyNecessary = () => setConsent({ marketing: false });

  function setConsent(consent: ConsentProps) {
    const consentMode = {
      functionality_storage: 'granted',
      security_storage: 'granted',
      ad_storage: consent.marketing ? 'granted' : 'denied',
      ad_user_data: consent.marketing ? 'granted' : 'denied',
      ad_personalization: consent.marketing ? 'granted' : 'denied',
    };
    gtag('consent', 'update', consentMode);
    useConsentMode.setState({ consentMode: consent });
  }

  return (
    <Box {...props}>
      {/* <Title>Cookie Settings</Title> */}
      <Text>
        We use cookies to provide you with the best possible experience. They also allow us to
        analyze user behavior in order to constantly improve the website for you.
      </Text>
      <Group>
        <Button size="sm" onClick={acceptAll}>
          Accept All
        </Button>
        <Button size="sm" onClick={onlyNecessary}>
          Only Necessary
        </Button>
      </Group>
    </Box>
  );
}
