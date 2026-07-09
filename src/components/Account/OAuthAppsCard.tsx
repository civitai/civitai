import { useState } from 'react';
import { useDisclosure } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  Text,
  Card,
  Stack,
  Group,
  Title,
  Button,
  Box,
  LoadingOverlay,
  Table,
  Center,
  Paper,
  Badge,
  Modal,
  TextInput,
  Textarea,
  Radio,
  Select,
  Checkbox,
  Code,
  CopyButton,
  Alert,
  Anchor,
} from '@mantine/core';
import {
  IconPlus,
  IconTrash,
  IconEdit,
  IconRefresh,
  IconCheck,
  IconClipboard,
  IconCalendar,
  IconKey,
  IconHash,
  IconCopy,
  IconInfoCircle,
} from '@tabler/icons-react';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import {
  TokenScope,
  TokenScopePresets,
  tokenScopePresetLabels,
  tokenScopeGrid,
} from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';
import classes from './OAuthAppsCard.module.css';

const presetOptions = (
  Object.keys(tokenScopePresetLabels) as (keyof typeof TokenScopePresets)[]
).map((key) => ({ value: key, label: tokenScopePresetLabels[key] }));

function getPresetKey(tokenScope: number): string | null {
  for (const [key, value] of Object.entries(TokenScopePresets)) {
    if (tokenScope === value) return key;
  }
  return null;
}

function ScopeSelector({
  tokenScope,
  onChange,
}: {
  tokenScope: number;
  onChange: (scope: number) => void;
}) {
  const preset = getPresetKey(tokenScope);

  const handlePresetChange = (value: string | null) => {
    if (!value) return;
    const newScope = TokenScopePresets[value as keyof typeof TokenScopePresets];
    if (newScope != null) onChange(newScope);
  };

  const handleToggleFlag = (flag: number) => {
    onChange(Flags.toggleFlag(tokenScope, flag));
  };

  return (
    <>
      <Select
        label="Permission preset"
        data={presetOptions}
        value={preset}
        onChange={handlePresetChange}
        placeholder="Custom"
        clearable={false}
      />
      <Box>
        <Text size="sm" fw={500} mb={4}>
          Permissions
        </Text>
        <Table withTableBorder withColumnBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Resource</Table.Th>
              <Table.Th style={{ textAlign: 'center', width: 70 }}>Read</Table.Th>
              <Table.Th style={{ textAlign: 'center', width: 70 }}>Write</Table.Th>
              <Table.Th style={{ textAlign: 'center', width: 70 }}>Delete</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tokenScopeGrid.map((row) => (
              <Table.Tr key={row.label}>
                <Table.Td>
                  <Text size="sm">{row.label}</Text>
                </Table.Td>
                <Table.Td style={{ textAlign: 'center' }}>
                  {'read' in row && row.read ? (
                    <Checkbox
                      checked={Flags.hasFlag(tokenScope, row.read)}
                      onChange={() => handleToggleFlag(row.read)}
                      styles={{ input: { cursor: 'pointer' } }}
                    />
                  ) : (
                    <Text size="xs" c="dimmed">
                      —
                    </Text>
                  )}
                </Table.Td>
                <Table.Td style={{ textAlign: 'center' }}>
                  {'write' in row && row.write ? (
                    <Checkbox
                      checked={Flags.hasFlag(tokenScope, row.write)}
                      onChange={() => handleToggleFlag(row.write)}
                      styles={{ input: { cursor: 'pointer' } }}
                    />
                  ) : (
                    <Text size="xs" c="dimmed">
                      —
                    </Text>
                  )}
                </Table.Td>
                <Table.Td style={{ textAlign: 'center' }}>
                  {'delete' in row && row.delete ? (
                    <Checkbox
                      checked={Flags.hasFlag(tokenScope, row.delete)}
                      onChange={() => handleToggleFlag(row.delete)}
                      styles={{ input: { cursor: 'pointer' } }}
                    />
                  ) : (
                    <Text size="xs" c="dimmed">
                      —
                    </Text>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    </>
  );
}

function SecretDisplay({
  clientId,
  clientSecret,
  onClose,
}: {
  clientId: string;
  clientSecret: string;
  onClose: () => void;
}) {
  const isPublic = !clientSecret;
  return (
    <Stack>
      <Text fw={500}>
        {isPublic ? 'Application registered — you’re all set' : 'Application registered'}
      </Text>
      <Box>
        <Text size="sm" fw={500} mb={4}>
          Client ID
        </Text>
        <CopyButton value={clientId}>
          {({ copied, copy }) => (
            <Box pos="relative" onClick={copy} style={{ cursor: 'pointer' }}>
              <Code block color={copied ? 'green' : undefined}>
                {copied ? 'Copied' : clientId}
              </Code>
              <LegacyActionIcon
                className="absolute right-2 top-1/2 -translate-y-1/2"
                variant="transparent"
                color="gray"
              >
                {copied ? <IconCheck /> : <IconClipboard />}
              </LegacyActionIcon>
            </Box>
          )}
        </CopyButton>
      </Box>
      {isPublic ? (
        <Box>
          <Text size="sm" fw={500} mb={4}>
            Authentication
          </Text>
          <Alert
            variant="light"
            color="blue"
            icon={<IconInfoCircle />}
            title="No client secret to save"
          >
            <Text size="sm">
              Browser and mobile apps can’t store a secret safely, so we don’t issue one. Your app
              proves itself with PKCE — a one-time proof generated on each login — together with
              your registered redirect URI. Just hold on to the Client ID above.{' '}
              <Anchor
                href="https://developer.civitai.com/site/oauth/#supported-flow"
                target="_blank"
                rel="noopener noreferrer"
              >
                Learn how the PKCE flow works
              </Anchor>
              .
            </Text>
          </Alert>
        </Box>
      ) : (
        <>
          <Box>
            <Text size="sm" fw={500} mb={4}>
              Client Secret
            </Text>
            <CopyButton value={clientSecret}>
              {({ copied, copy }) => (
                <Box pos="relative" onClick={copy} style={{ cursor: 'pointer' }}>
                  <Code block color={copied ? 'green' : undefined}>
                    {copied ? 'Copied' : clientSecret}
                  </Code>
                  <LegacyActionIcon
                    className="absolute right-2 top-1/2 -translate-y-1/2"
                    variant="transparent"
                    color="gray"
                  >
                    {copied ? <IconCheck /> : <IconClipboard />}
                  </LegacyActionIcon>
                </Box>
              )}
            </CopyButton>
          </Box>
          <Text size="xs" fw={500} c="red.5">
            Save the client secret now — you will not be able to see it again.
          </Text>
        </>
      )}
      <Group justify="flex-end">
        <Button onClick={onClose}>Done</Button>
      </Group>
    </Stack>
  );
}

// Origin entries are exact-matched against the browser's `Origin` header, so
// they must be a bare scheme://host[:port]. We pre-validate on the client to
// give a fast inline error; the server enforces the same rule.
function parseOriginList(
  text: string
): { value: string[]; error: string | null } {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const cleaned: string[] = [];
  for (const line of lines) {
    try {
      const url = new URL(line);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { value: [], error: `Origin must use http(s): ${line}` };
      }
      if (line !== url.origin) {
        return {
          value: [],
          error: `Origin must be scheme://host[:port] with no path: ${line}`,
        };
      }
      cleaned.push(url.origin);
    } catch {
      return { value: [], error: `Invalid origin: ${line}` };
    }
  }
  return { value: cleaned, error: null };
}

function deriveOriginsFromRedirectUrisClient(uris: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const uri of uris) {
    try {
      const origin = new URL(uri).origin;
      if (origin === 'null' || seen.has(origin)) continue;
      seen.add(origin);
      out.push(origin);
    } catch {
      // ignore — URI was already validated
    }
  }
  return out;
}

const clientTypeOptions = [
  {
    value: 'confidential',
    title: 'Server App',
    term: 'confidential',
    description:
      'Runs on a backend you control, where code is never exposed to users. Gets a client secret to authenticate at the token endpoint.',
    examples: 'Node, Python, Go, PHP — anything server-side.',
  },
  {
    value: 'public',
    title: 'Browser / Mobile App',
    term: 'public',
    description:
      "Runs on the user's device, so it can't keep a secret hidden. Uses PKCE — a one-time proof generated each login — instead of a stored secret.",
    examples: 'React/Vue SPAs, iOS, Android, desktop apps.',
  },
] as const;

function ClientTypeSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Radio.Group label="App type" value={value} onChange={onChange} required>
      <Stack gap="xs" mt="xs">
        {clientTypeOptions.map((opt) => (
          <Radio.Card
            key={opt.value}
            value={opt.value}
            p="md"
            radius="md"
            className={classes.typeCard}
          >
            <Group wrap="nowrap" align="flex-start" gap="sm">
              <Radio.Indicator mt={2} />
              <div style={{ minWidth: 0 }}>
                <Group gap="xs" wrap="nowrap">
                  <Text fw={600} size="sm">
                    {opt.title}
                  </Text>
                  <Code>{opt.term}</Code>
                </Group>
                <Text size="sm" c="dimmed" mt={2}>
                  {opt.description}
                </Text>
                <Text size="xs" c="dimmed" mt={4} fs="italic">
                  {opt.examples}
                </Text>
              </div>
            </Group>
          </Radio.Card>
        ))}
      </Stack>
    </Radio.Group>
  );
}

function RegisterAppModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [redirectUrisText, setRedirectUrisText] = useState('');
  const [allowedOriginsText, setAllowedOriginsText] = useState('');
  const [isConfidential, setIsConfidential] = useState(true);
  const [tokenScope, setTokenScope] = useState(TokenScope.Full);
  const [result, setResult] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [uriError, setUriError] = useState<string | null>(null);
  const [originError, setOriginError] = useState<string | null>(null);

  const createMutation = trpc.oauthClient.create.useMutation({
    onSuccess(data) {
      utils.oauthClient.getAll.invalidate();
      setResult({
        clientId: data.clientId,
        clientSecret: data.clientSecret ?? '',
      });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to register application',
        error: new Error(error.message),
      });
    },
  });

  const resetForm = () => {
    setName('');
    setDescription('');
    setRedirectUrisText('');
    setAllowedOriginsText('');
    setIsConfidential(true);
    setTokenScope(TokenScope.Full);
    setResult(null);
    setUriError(null);
    setOriginError(null);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const parseRedirectUris = (): string[] | null => {
    const uris = redirectUrisText
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);
    if (uris.length === 0) {
      setUriError('At least one redirect URI is required');
      return null;
    }
    for (const uri of uris) {
      try {
        new URL(uri);
      } catch {
        setUriError(`Invalid URL: ${uri}`);
        return null;
      }
    }
    setUriError(null);
    return uris;
  };

  const handleSubmit = () => {
    const uris = parseRedirectUris();
    if (!uris) return;
    if (!name.trim()) return;

    // Origins only matter for public clients (Origin pinning at the token
    // endpoint), so the field is hidden for server apps. Send an empty array
    // there and let the server's redirectUris backfill handle it. For public
    // clients, parse the field and fall back to deriving from redirectUris.
    let allowedOrigins: string[] = [];
    if (!isConfidential) {
      const originsParsed = parseOriginList(allowedOriginsText);
      if (originsParsed.error) {
        setOriginError(originsParsed.error);
        return;
      }
      allowedOrigins =
        originsParsed.value.length > 0
          ? originsParsed.value
          : deriveOriginsFromRedirectUrisClient(uris);
    }

    createMutation.mutate({
      name: name.trim(),
      description: description.trim(),
      redirectUris: uris,
      allowedOrigins,
      isConfidential,
      allowedScopes: tokenScope,
    });
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="Register OAuth Application"
      size="lg"
      closeOnClickOutside={!createMutation.isPending}
      closeOnEscape={!createMutation.isPending}
    >
      {result ? (
        <SecretDisplay
          clientId={result.clientId}
          clientSecret={result.clientSecret}
          onClose={handleClose}
        />
      ) : (
        <Stack>
          <ClientTypeSelector
            value={isConfidential ? 'confidential' : 'public'}
            onChange={(val) => setIsConfidential(val === 'confidential')}
          />
          <TextInput
            label="App name"
            placeholder="My Application"
            required
            maxLength={128}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Textarea
            label="Description"
            placeholder="A brief description of your application"
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <Textarea
            label="Redirect URIs"
            description="One URI per line"
            placeholder={'https://example.com/callback\nhttps://example.com/auth/callback'}
            required
            minRows={3}
            value={redirectUrisText}
            onChange={(e) => {
              setRedirectUrisText(e.currentTarget.value);
              setUriError(null);
            }}
            error={uriError}
          />
          {!isConfidential && (
            <Textarea
              label="Allowed origins"
              description="One origin per line (e.g. https://app.example.com). Leave blank to derive from redirect URIs."
              placeholder={'https://app.example.com\nhttp://localhost:5173'}
              minRows={2}
              value={allowedOriginsText}
              onChange={(e) => {
                setAllowedOriginsText(e.currentTarget.value);
                setOriginError(null);
              }}
              error={originError}
            />
          )}
          <ScopeSelector tokenScope={tokenScope} onChange={setTokenScope} />
          <Group justify="space-between">
            <Button variant="default" onClick={handleClose} disabled={createMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              loading={createMutation.isPending}
              disabled={!name.trim()}
            >
              Register App
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function EditAppModal({
  opened,
  onClose,
  client,
}: {
  opened: boolean;
  onClose: () => void;
  client: {
    id: string;
    name: string;
    description: string | null;
    redirectUris: string[];
    allowedOrigins: string[];
    allowedScopes: number;
  };
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(client.name);
  const [description, setDescription] = useState(client.description ?? '');
  const [redirectUrisText, setRedirectUrisText] = useState(client.redirectUris.join('\n'));
  const [allowedOriginsText, setAllowedOriginsText] = useState(
    client.allowedOrigins.join('\n')
  );
  const [tokenScope, setTokenScope] = useState(client.allowedScopes);
  const [uriError, setUriError] = useState<string | null>(null);
  const [originError, setOriginError] = useState<string | null>(null);

  const updateMutation = trpc.oauthClient.update.useMutation({
    onSuccess() {
      utils.oauthClient.getAll.invalidate();
      onClose();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to update application',
        error: new Error(error.message),
      });
    },
  });

  const parseRedirectUris = (): string[] | null => {
    const uris = redirectUrisText
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);
    if (uris.length === 0) {
      setUriError('At least one redirect URI is required');
      return null;
    }
    for (const uri of uris) {
      try {
        new URL(uri);
      } catch {
        setUriError(`Invalid URL: ${uri}`);
        return null;
      }
    }
    setUriError(null);
    return uris;
  };

  const handleSubmit = () => {
    const uris = parseRedirectUris();
    if (!uris) return;
    if (!name.trim()) return;

    const originsParsed = parseOriginList(allowedOriginsText);
    if (originsParsed.error) {
      setOriginError(originsParsed.error);
      return;
    }

    updateMutation.mutate({
      id: client.id,
      name: name.trim(),
      description: description.trim(),
      redirectUris: uris,
      allowedOrigins: originsParsed.value,
      allowedScopes: tokenScope,
    });
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Edit OAuth Application"
      size="lg"
      closeOnClickOutside={!updateMutation.isPending}
      closeOnEscape={!updateMutation.isPending}
    >
      <Stack>
        <TextInput
          label="App name"
          placeholder="My Application"
          required
          maxLength={128}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Textarea
          label="Description"
          placeholder="A brief description of your application"
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <Textarea
          label="Redirect URIs"
          description="One URI per line"
          placeholder={'https://example.com/callback'}
          required
          minRows={3}
          value={redirectUrisText}
          onChange={(e) => {
            setRedirectUrisText(e.currentTarget.value);
            setUriError(null);
          }}
          error={uriError}
        />
        <Textarea
          label="Allowed origins"
          description="One origin per line (e.g. https://app.example.com). Enforced for public clients."
          placeholder={'https://app.example.com'}
          minRows={2}
          value={allowedOriginsText}
          onChange={(e) => {
            setAllowedOriginsText(e.currentTarget.value);
            setOriginError(null);
          }}
          error={originError}
        />
        <ScopeSelector tokenScope={tokenScope} onChange={setTokenScope} />
        <Group justify="space-between">
          <Button variant="default" onClick={onClose} disabled={updateMutation.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={updateMutation.isPending} disabled={!name.trim()}>
            Save Changes
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function OAuthAppsCard() {
  const utils = trpc.useUtils();
  const [registerOpened, { open: openRegister, close: closeRegister }] = useDisclosure(false);
  const [editClient, setEditClient] = useState<{
    id: string;
    name: string;
    description: string | null;
    redirectUris: string[];
    allowedOrigins: string[];
    allowedScopes: number;
  } | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);

  const { data: clients = [], isLoading } = trpc.oauthClient.getAll.useQuery();

  const deleteMutation = trpc.oauthClient.delete.useMutation({
    onSuccess() {
      utils.oauthClient.getAll.invalidate();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to delete application',
        error: new Error(error.message),
      });
    },
  });

  const rotateMutation = trpc.oauthClient.rotateSecret.useMutation({
    onSuccess(data) {
      setRotatedSecret(data.clientSecret);
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to rotate secret',
        error: new Error(error.message),
      });
    },
  });

  const handleDelete = (id: string, name: string) => {
    openConfirmModal({
      title: 'Delete OAuth Application',
      children: (
        <Stack gap="xs">
          <Text size="sm">
            Are you sure you want to delete <strong>{name}</strong>?
          </Text>
          <Text size="sm" c="red">
            This will revoke all tokens and disconnect all users.
          </Text>
        </Stack>
      ),
      centered: true,
      labels: { confirm: 'Delete Application', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => deleteMutation.mutate({ id }),
    });
  };

  const handleRotateSecret = (id: string, name: string) => {
    openConfirmModal({
      title: 'Rotate Client Secret',
      children: (
        <Stack gap="xs">
          <Text size="sm">
            Generate a new client secret for <strong>{name}</strong>?
          </Text>
          <Text size="sm" c="red">
            The old secret will be immediately invalidated. Any integrations using it will stop
            working.
          </Text>
        </Stack>
      ),
      centered: true,
      labels: { confirm: 'Rotate Secret', cancel: 'Cancel' },
      confirmProps: { color: 'orange' },
      onConfirm: () => rotateMutation.mutate({ id }),
    });
  };

  return (
    <>
      <Card withBorder>
        <Stack gap={0}>
          <Group align="start" justify="space-between">
            <Title order={2}>OAuth Applications</Title>
            <Button
              size="compact-sm"
              leftSection={<IconPlus size={14} stroke={1.5} />}
              onClick={openRegister}
            >
              Register App
            </Button>
          </Group>
          <Text c="dimmed" size="sm">
            Register OAuth applications to allow third-party integrations to access the Civitai API
            on behalf of users.
          </Text>
        </Stack>
        <Box mt="md" style={{ position: 'relative' }}>
          <LoadingOverlay visible={isLoading} />
          {clients.length > 0 ? (
            <Stack gap="sm">
              {clients.map((client) => (
                <Paper key={client.id} withBorder p="md" radius="md">
                  <Stack gap="xs">
                    {/* Header line: name + type badges + actions on right (same flex container) */}
                    <Group justify="space-between" align="center" wrap="nowrap">
                      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                        <Text
                          fw={600}
                          size="sm"
                          lineClamp={1}
                          title={client.name}
                          style={{ minWidth: 0 }}
                        >
                          {client.name}
                        </Text>
                        <Badge
                          size="sm"
                          variant="light"
                          color={client.isConfidential ? 'blue' : 'gray'}
                        >
                          {client.isConfidential ? 'Confidential' : 'Public'}
                        </Badge>
                        {client.isVerified && (
                          <Badge size="sm" variant="light" color="green">
                            Verified
                          </Badge>
                        )}
                      </Group>
                      <Group gap="xs" wrap="nowrap">
                        <LegacyActionIcon
                          variant="subtle"
                          color="blue"
                          onClick={() =>
                            setEditClient({
                              id: client.id,
                              name: client.name,
                              description: client.description,
                              redirectUris: client.redirectUris,
                              allowedOrigins: client.allowedOrigins ?? [],
                              allowedScopes: client.allowedScopes,
                            })
                          }
                          title="Edit"
                        >
                          <IconEdit size={16} stroke={1.5} />
                        </LegacyActionIcon>
                        {client.isConfidential && (
                          <LegacyActionIcon
                            variant="subtle"
                            color="orange"
                            onClick={() => handleRotateSecret(client.id, client.name)}
                            title="Rotate secret"
                          >
                            <IconRefresh size={16} stroke={1.5} />
                          </LegacyActionIcon>
                        )}
                        <LegacyActionIcon
                          variant="subtle"
                          color="red"
                          onClick={() => handleDelete(client.id, client.name)}
                          title="Delete"
                        >
                          <IconTrash size={16} stroke={1.5} />
                        </LegacyActionIcon>
                      </Group>
                    </Group>

                    {/* Meta line: date · token count · client ID (copyable) */}
                    <Group gap="md" wrap="wrap" align="center">
                      <Group gap={4} wrap="nowrap">
                        <IconCalendar size={12} color="var(--mantine-color-dimmed)" />
                        <Text size="xs" c="dimmed">
                          {formatDate(client.createdAt)}
                        </Text>
                      </Group>
                      <Group gap={4} wrap="nowrap">
                        <IconKey size={12} color="var(--mantine-color-dimmed)" />
                        <Text size="xs" c="dimmed">
                          {client._count.tokens} {client._count.tokens === 1 ? 'token' : 'tokens'}
                        </Text>
                      </Group>
                      <Group gap={4} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                        <IconHash size={12} color="var(--mantine-color-dimmed)" />
                        <Text
                          size="xs"
                          c="dimmed"
                          ff="monospace"
                          lineClamp={1}
                          style={{ minWidth: 0 }}
                          title={client.id}
                        >
                          {client.id}
                        </Text>
                        <CopyButton value={client.id}>
                          {({ copied, copy }) => (
                            <LegacyActionIcon
                              size="xs"
                              variant="subtle"
                              color={copied ? 'green' : 'gray'}
                              onClick={copy}
                              title={copied ? 'Copied!' : 'Copy client ID'}
                            >
                              {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                            </LegacyActionIcon>
                          )}
                        </CopyButton>
                      </Group>
                    </Group>

                    {client.description ? (
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {client.description}
                      </Text>
                    ) : null}
                  </Stack>
                </Paper>
              ))}
            </Stack>
          ) : (
            <Paper radius="md" mt="lg" p="lg" style={{ position: 'relative' }} withBorder>
              <Center>
                <Stack gap={2}>
                  <Text fw="bold">No OAuth applications registered yet</Text>
                  <Text size="sm" c="dimmed">
                    Register your first OAuth application to enable third-party integrations.
                  </Text>
                </Stack>
              </Center>
            </Paper>
          )}
        </Box>
      </Card>

      <RegisterAppModal opened={registerOpened} onClose={closeRegister} />

      {editClient && (
        <EditAppModal
          opened={!!editClient}
          onClose={() => setEditClient(null)}
          client={editClient}
        />
      )}

      {/* Rotated secret display modal */}
      <Modal
        opened={!!rotatedSecret}
        onClose={() => setRotatedSecret(null)}
        title="New Client Secret"
        centered
      >
        {rotatedSecret && (
          <Stack>
            <CopyButton value={rotatedSecret}>
              {({ copied, copy }) => (
                <Box pos="relative" onClick={copy} style={{ cursor: 'pointer' }}>
                  <Code block color={copied ? 'green' : undefined}>
                    {copied ? 'Copied' : rotatedSecret}
                  </Code>
                  <LegacyActionIcon
                    className="absolute right-2 top-1/2 -translate-y-1/2"
                    variant="transparent"
                    color="gray"
                  >
                    {copied ? <IconCheck /> : <IconClipboard />}
                  </LegacyActionIcon>
                </Box>
              )}
            </CopyButton>
            <Text size="xs" c="red.5" fw={500}>
              Save the new client secret now — you will not be able to see it again.
            </Text>
            <Group justify="flex-end">
              <Button onClick={() => setRotatedSecret(null)}>Done</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
