import { useState } from 'react';
import type { ModalProps } from '@mantine/core';
import {
  Alert,
  Anchor,
  Box,
  Button,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
} from '@mantine/core';
import { IconCheck, IconClipboard } from '@tabler/icons-react';
import type * as z from 'zod';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Form, InputText, useForm } from '~/libs/form';
import { addApiKeyInputSchema, simpleBuzzLimitToBudgets } from '~/server/schema/api-key.schema';
import {
  TokenScope,
  TokenScopePresets,
  tokenScopePresetLabels,
  tokenScopeGrid,
} from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';

const schema = addApiKeyInputSchema;

const presetOptions = (
  Object.keys(tokenScopePresetLabels) as (keyof typeof TokenScopePresets)[]
).map((key) => ({ value: key, label: tokenScopePresetLabels[key] }));

function getPresetKey(tokenScope: number): string | null {
  for (const [key, value] of Object.entries(TokenScopePresets)) {
    if (tokenScope === value) return key;
  }
  return null;
}

const periodOptions = [
  { value: 'day', label: 'Per 24 hours' },
  { value: 'week', label: 'Per 7 days' },
  { value: 'month', label: 'Per 30 days' },
];

export function ApiKeyModal({ ...props }: Props) {
  const features = useFeatureFlags();
  const [tokenScope, setTokenScope] = useState<number>(TokenScope.Full);
  const [preset, setPreset] = useState<string | null>('Full');
  const [limitEnabled, setLimitEnabled] = useState(false);
  const [limitAmount, setLimitAmount] = useState<number | ''>(5000);
  const [limitPeriod, setLimitPeriod] = useState<'day' | 'week' | 'month'>('day');

  const form = useForm({
    schema,
    mode: 'onChange',
    shouldUnregister: false,
    defaultValues: {
      name: '',
      tokenScope: TokenScope.Full,
    },
  });
  const queryUtils = trpc.useUtils();

  const {
    data: apiKey,
    isPending: mutating,
    mutate,
    reset,
  } = trpc.apiKey.add.useMutation({
    onSuccess() {
      queryUtils.apiKey.getAllUserKeys.invalidate();
    },
    onError(error) {
      showErrorNotification({
        title: 'Unable to generate API Key',
        error: new Error(error.message),
      });
    },
  });

  const updateTokenScope = (newScope: number) => {
    setTokenScope(newScope);
    setPreset(getPresetKey(newScope));
    form.setValue('tokenScope', newScope);
  };

  const handlePresetChange = (value: string | null) => {
    if (!value) return;
    setPreset(value);
    const newScope = TokenScopePresets[value as keyof typeof TokenScopePresets];
    if (newScope != null) {
      setTokenScope(newScope);
      form.setValue('tokenScope', newScope);
    }
  };

  const handleToggleFlag = (flag: number) => {
    const newScope = Flags.toggleFlag(tokenScope, flag);
    updateTokenScope(newScope);
  };

  const handleSaveApiKey = (values: z.infer<typeof schema>) => {
    const buzzLimit =
      limitEnabled && typeof limitAmount === 'number' && limitAmount > 0
        ? simpleBuzzLimitToBudgets({ limit: limitAmount, period: limitPeriod })
        : null;
    mutate({
      ...values,
      tokenScope,
      buzzLimit,
    });
  };

  const handleClose = () => {
    form.reset();
    reset();
    setTokenScope(TokenScope.Full);
    setPreset('Full');
    setLimitEnabled(false);
    setLimitAmount(5000);
    setLimitPeriod('day');
    props.onClose();
  };

  return (
    <Modal
      {...props}
      onClose={handleClose}
      closeOnClickOutside={!mutating}
      closeOnEscape={!mutating}
      size="lg"
    >
      {apiKey ? (
        <Stack gap={4}>
          <Text fw={500}>Here is your API Key:</Text>
          <CopyButton value={apiKey}>
            {({ copied, copy }) => (
              <Box pos="relative" onClick={copy} style={{ cursor: 'pointer' }}>
                <Code block color={copied ? 'green' : undefined}>
                  {copied ? 'Copied' : apiKey}
                </Code>
                <LegacyActionIcon
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  right={10}
                  variant="transparent"
                  color="gray"
                >
                  {copied ? <IconCheck /> : <IconClipboard />}
                </LegacyActionIcon>
              </Box>
            )}
          </CopyButton>
          <Text size="xs" c="dimmed">
            {`Be sure to save this, you won't be able to see it again.`}
          </Text>
          <Alert color="yellow" mt="sm" p="sm">
            <Text size="xs">
              You are responsible for everything done with this key. Anything generated, posted, or
              published with it — including by automated agents or scripts — counts as your own
              action under the{' '}
              <Anchor href="/content/tos" target="_blank" rel="noopener noreferrer">
                Terms of Service
              </Anchor>
              .
            </Text>
          </Alert>
        </Stack>
      ) : (
        <Form form={form} onSubmit={handleSaveApiKey}>
          <Stack>
            <InputText
              name="name"
              label="Name"
              placeholder="Your API Key name"
              withAsterisk
              maxLength={64}
            />
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
            {features.apiKeyBuzzLimit && (
              <Box>
                <Group justify="space-between" align="center" mb={4}>
                  <Text size="sm" fw={500}>
                    Buzz spend limit
                  </Text>
                  <Switch
                    size="sm"
                    checked={limitEnabled}
                    onChange={(e) => setLimitEnabled(e.currentTarget.checked)}
                  />
                </Group>
                <Text size="xs" c="dimmed" mb={limitEnabled ? 8 : 0}>
                  Caps how much buzz this key can spend on AI services in a rolling window. Leave
                  off for no limit.
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
              </Box>
            )}
            <Group justify="space-between">
              <Button variant="default" disabled={mutating} onClick={handleClose}>
                Cancel
              </Button>
              <Button variant="filled" loading={mutating} type="submit">
                Save
              </Button>
            </Group>
          </Stack>
        </Form>
      )}
    </Modal>
  );
}

type Props = ModalProps;
