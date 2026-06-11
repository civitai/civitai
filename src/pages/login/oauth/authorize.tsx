import {
  Box,
  Button,
  Card,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  Title,
  Badge,
  List,
  Checkbox,
  Alert,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconCoinFilled,
  IconShieldCheck,
  IconX,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { TokenScope, tokenScopeLabels } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';
import { simpleBuzzLimitToBudgets } from '~/server/schema/api-key.schema';
import { trpc } from '~/utils/trpc';

const periodOptions = [
  { value: 'day', label: 'Per 24 hours' },
  { value: 'week', label: 'Per 7 days' },
  { value: 'month', label: 'Per 30 days' },
];

export default function OAuthAuthorizePage() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [limitEnabled, setLimitEnabled] = useState(true);
  const [limitAmount, setLimitAmount] = useState<number | ''>(5000);
  const [limitPeriod, setLimitPeriod] = useState<'day' | 'week' | 'month'>('day');

  const clientId = router.query.client_id as string;
  // UserRead is a mandatory baseline granted on every authorization (the server
  // forces it on regardless), so reflect it in the consent list and submission.
  const scope = (parseInt(router.query.scope as string, 10) || 0) | TokenScope.UserRead;
  const redirectUri = router.query.redirect_uri as string;
  const state = router.query.state as string;
  const responseType = router.query.response_type as string;
  const codeChallenge = router.query.code_challenge as string;
  const codeChallengeMethod = router.query.code_challenge_method as string;

  // Fetch client details
  const { data: client, isLoading } = trpc.oauthClient.getById.useQuery(
    { id: clientId },
    { enabled: !!clientId }
  );

  if (!currentUser) {
    // Redirect to login
    const returnUrl = encodeURIComponent(router.asPath);
    router.replace(`/login?returnUrl=${returnUrl}`);
    return null;
  }

  if (isLoading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  if (!client) {
    return (
      <Container size="xs" py="xl">
        <Card withBorder p="xl">
          <Stack align="center" gap="md">
            <IconX size={48} color="red" />
            <Title order={3}>Invalid Application</Title>
            <Text c="dimmed">The application you are trying to authorize was not found.</Text>
          </Stack>
        </Card>
      </Container>
    );
  }

  // Parse requested scopes into human-readable list
  const requestedScopes = Object.entries(tokenScopeLabels)
    .filter(([bit]) => Flags.hasFlag(scope, parseInt(bit)))
    .map(([, label]) => label);

  // The only token-driven buzz spend Civitai allows flows through the
  // orchestrator (generation, training, scanning), gated by AIServicesWrite.
  // Every other buzz-spending procedure on the site is `blockApiKeys: true`,
  // so showing the limit prompt makes no sense unless this scope is included.
  const requestsSpend = Flags.hasFlag(scope, TokenScope.AIServicesWrite);

  // For dynamically-registered (RFC 7591) clients that Civitai has not verified,
  // surface a prominent warning with the raw client name + redirect host so the
  // user can judge whether they actually initiated this. A verified client
  // (manually reviewed) is exempt.
  const showUnverifiedWarning = client.isDynamicallyRegistered && !client.isVerified;
  let redirectHost = '';
  try {
    redirectHost = redirectUri ? new URL(redirectUri).host : '';
  } catch {
    redirectHost = '';
  }

  const handleApprove = async () => {
    setSubmitting(true);
    try {
      // Submit approval via POST (required by the authorize endpoint for security)
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/api/auth/oauth/authorize';

      const buzzLimit =
        requestsSpend && limitEnabled && typeof limitAmount === 'number' && limitAmount > 0
          ? simpleBuzzLimitToBudgets({ limit: limitAmount, period: limitPeriod })
          : null;

      const fields: Record<string, string> = {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: responseType,
        scope: scope.toString(),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        remember: remember ? 'true' : 'false',
        approved: 'true',
        // JSON-encoded BuzzBudget[] for the consent record, or empty for "no limit"
        buzz_limit: buzzLimit ? JSON.stringify(buzzLimit) : '',
      };

      for (const [name, value] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }

      document.body.appendChild(form);
      form.submit();
    } catch {
      setSubmitting(false);
    }
  };

  const handleDeny = () => {
    // Redirect back to client with access_denied error
    const url = new URL(redirectUri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'The user denied the authorization request');
    if (state) url.searchParams.set('state', state);
    window.location.href = url.toString();
  };

  return (
    <Container size="xs" py="xl">
      <Card withBorder p="xl">
        <Stack gap="lg">
          <Stack align="center" gap="xs">
            <Title order={3}>Authorize {client.name}</Title>
            {client.isVerified && (
              <Badge leftSection={<IconShieldCheck size={14} />} color="green" variant="light">
                Verified by Civitai
              </Badge>
            )}
            {client.description && (
              <Text c="dimmed" size="sm" ta="center">
                {client.description}
              </Text>
            )}
          </Stack>

          {showUnverifiedWarning && (
            <Alert
              icon={<IconAlertTriangle size={18} />}
              color="yellow"
              variant="light"
              title="This application is not verified by Civitai"
            >
              <Stack gap={4}>
                <Text size="sm">
                  <Text span fw={600}>
                    {client.name}
                  </Text>{' '}
                  registered itself automatically and has not been reviewed by Civitai. Only
                  continue if you started this connection yourself.
                </Text>
                {redirectHost && (
                  <Text size="xs" c="dimmed">
                    You will be redirected to{' '}
                    <Text span fw={600}>
                      {redirectHost}
                    </Text>{' '}
                    after authorizing.
                  </Text>
                )}
              </Stack>
            </Alert>
          )}

          <Divider />

          <Stack gap="xs">
            <Text fw={500}>This application is requesting access to your account:</Text>
            <List spacing="xs" size="sm" icon={<IconCheck size={16} color="green" />}>
              {requestedScopes.map((label) => (
                <List.Item key={label}>{label}</List.Item>
              ))}
            </List>
          </Stack>

          {requestsSpend && (
            <>
              <Divider />
              <Stack gap="xs">
                <Group justify="space-between" align="center">
                  <Group gap={6}>
                    <IconCoinFilled size={16} color="var(--mantine-color-yellow-6)" />
                    <Text fw={500} size="sm">
                      Limit how much buzz this app can spend
                    </Text>
                  </Group>
                  <Switch
                    checked={limitEnabled}
                    onChange={(e) => setLimitEnabled(e.currentTarget.checked)}
                  />
                </Group>
                <Text size="xs" c="dimmed">
                  This app is asking for AI services access, which lets it spend buzz on generation,
                  training, or scanning. Setting a rolling limit caps how much it can spend in any
                  window — you can change or remove the limit later in your account settings.
                </Text>
                {limitEnabled && (
                  <Group grow>
                    <NumberInput
                      label="Limit"
                      placeholder="Amount in buzz"
                      min={1}
                      value={limitAmount}
                      onChange={(v) => setLimitAmount(typeof v === 'number' ? v : '')}
                      thousandSeparator=","
                    />
                    <Select
                      label="Window"
                      data={periodOptions}
                      value={limitPeriod}
                      onChange={(v) => v && setLimitPeriod(v as 'day' | 'week' | 'month')}
                      allowDeselect={false}
                    />
                  </Group>
                )}
              </Stack>
            </>
          )}

          <Divider />

          <Checkbox
            label="Remember my decision for this application"
            checked={remember}
            onChange={(e) => setRemember(e.currentTarget.checked)}
          />

          <Group grow>
            <Button variant="default" onClick={handleDeny} disabled={submitting}>
              Deny
            </Button>
            <Button onClick={handleApprove} loading={submitting}>
              Authorize
            </Button>
          </Group>

          <Text size="xs" c="dimmed" ta="center">
            Signed in as {currentUser.username}
          </Text>
        </Stack>
      </Card>
    </Container>
  );
}
