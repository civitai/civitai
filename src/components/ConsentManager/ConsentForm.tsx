import { Box, BoxProps, Button, Group, Text, Title } from '@mantine/core';
import { useConsentManager } from '~/components/Ads/ads.utils';

export function ConsentForm(props: BoxProps) {
  const acceptAll = () => setConsent(true);
  const onlyNecessary = () => setConsent(false);

  function setConsent(targeting: boolean) {
    useConsentManager.setState({ targeting });
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
