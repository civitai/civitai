import { NotFound } from '~/components/AppLayout/NotFound';
import {
  useTipaltiConfigurationUrl,
  useUserPaymentConfiguration,
} from '~/components/UserPaymentConfiguration/util';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useRef } from 'react';
import { Container, Stack, Title, Text } from '@mantine/core';

export default function Onboard() {
  const { userPaymentConfiguration, isLoading: isLoadingUserPaymentConfiguration } =
    useUserPaymentConfiguration();
  const { tipaltiConfigurationUrl, isLoading: isLoadingTipaltiConfigurationUrl } =
    useTipaltiConfigurationUrl(!!userPaymentConfiguration?.tipaltiAccountId);

  if (isLoadingUserPaymentConfiguration || isLoadingTipaltiConfigurationUrl) {
    return <PageLoader />;
  }

  if (tipaltiConfigurationUrl) {
    return (
      <Container>
        <Stack>
          <Title order={3}>Setup your Tipalti Account</Title>
          <Text size="sm" color="faded">
            Below iFrame has been directly provided by Tipalti to ensure your account is setup
            correctly and your data is safe. Please follow the instructions provided by Tipalti to
            complete, update and modify your account. This is required to receive payments.
          </Text>
          <iframe
            src={tipaltiConfigurationUrl}
            style={{
              width: '100%',
              height: '100%',
              minHeight: 'calc(100vh - 200px)',
            }}
          />
        </Stack>
      </Container>
    );
  }

  return <NotFound />;
}
