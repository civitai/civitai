import {
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  Container,
  Group,
  Loader,
  MultiSelect,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconSpeakerphone } from '@tabler/icons-react';
import { useState } from 'react';
import { SiteAlertStrip } from '~/components/SiteAlerts/SiteAlertStrip';
import type {
  SiteAlertRecord,
  SiteAlertSeverity,
  SiteAlertSurface,
} from '~/shared/constants/site-alert.constants';
import {
  SITE_ALERT_BROKEN_TEMPLATE,
  SITE_ALERT_DEFAULT_DURATION_MS,
  SITE_ALERT_MAX_DURATION_MS,
  siteAlertPresets,
  siteAlertSeverities,
} from '~/shared/constants/site-alert.constants';
import type { DomainColor } from '~/shared/utils/prisma/enums';
import { isValidAlertPathPattern } from '~/shared/utils/site-alert-match';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type FormState = {
  id?: number;
  severity: SiteAlertSeverity;
  title: string;
  message: string;
  paths: string[];
  domains: DomainColor[];
  hours: number;
  dismissible: boolean;
};

const emptyForm = (): FormState => ({
  severity: 'warning',
  title: '',
  message: '',
  paths: [],
  domains: ['all'],
  hours: SITE_ALERT_DEFAULT_DURATION_MS / 3_600_000,
  dismissible: true,
});

const MAX_HOURS = SITE_ALERT_MAX_DURATION_MS / 3_600_000;
const domainOptions: DomainColor[] = ['all', 'blue', 'green', 'red'];

export function SiteAlertsManager() {
  const [form, setForm] = useState<FormState>(emptyForm);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((x) => ({ ...x, [key]: value }));

  const utils = trpc.useUtils();
  const { data: alerts, isLoading } = trpc.siteAlerts.list.useQuery();
  const onSuccess = (message: string) => {
    showSuccessNotification({ message });
    void utils.siteAlerts.list.invalidate();
  };
  const onError = (error: { message: string }) =>
    showErrorNotification({ title: 'Site alert not saved', error });

  const post = trpc.siteAlerts.post.useMutation({
    onSuccess: () => {
      onSuccess('Alert posted');
      setForm(emptyForm());
    },
    onError,
  });
  const edit = trpc.siteAlerts.edit.useMutation({
    onSuccess: () => {
      onSuccess('Alert updated');
      setForm(emptyForm());
    },
    onError,
  });
  const extend = trpc.siteAlerts.extend.useMutation({
    onSuccess: () => onSuccess('Alert extended'),
    onError,
  });
  const end = trpc.siteAlerts.end.useMutation({
    onSuccess: () => onSuccess('Alert ended'),
    onError,
  });

  const invalidPaths = form.paths.filter((x) => !isValidAlertPathPattern(x));
  const canSave = !!form.title.trim() && invalidPaths.length === 0;

  const handleSave = () => {
    const content = {
      severity: form.severity,
      title: form.title,
      message: form.message.trim() || null,
      paths: form.paths,
      domains: form.domains,
      dismissible: form.dismissible,
    };
    if (form.id) edit.mutate({ id: form.id, ...content });
    else
      post.mutate({
        ...content,
        surfaces: ['everywhere'],
        endsAt: new Date(Date.now() + form.hours * 3_600_000),
      });
  };

  const applyBrokenTemplate = (label: string | null) => {
    const preset = siteAlertPresets.find((x) => x.label === label);
    if (!preset) return;
    setForm((x) => ({
      ...x,
      ...SITE_ALERT_BROKEN_TEMPLATE(preset.label),
      paths: preset.paths,
      dismissible: false,
    }));
  };

  const togglePreset = (paths: string[], on: boolean) =>
    set(
      'paths',
      on ? [...new Set([...form.paths, ...paths])] : form.paths.filter((x) => !paths.includes(x))
    );

  const startEdit = (alert: SiteAlertRecord) =>
    setForm({
      id: alert.id,
      severity: alert.severity,
      title: alert.title,
      message: alert.message ?? '',
      paths: alert.paths,
      domains: alert.domains,
      hours: 0,
      dismissible: alert.dismissible,
    });

  const now = Date.now();
  const active = (alerts ?? []).filter((x) => new Date(x.endsAt).getTime() > now);
  const ended = (alerts ?? []).filter((x) => new Date(x.endsAt).getTime() <= now);

  return (
    <Container size="md" py="xl">
      <Stack gap="xl">
        <Group gap="sm" align="center">
          <IconSpeakerphone size={28} />
          <Stack gap={0}>
            <Title order={2}>Site Alerts</Title>
            <Text c="dimmed" size="sm">
              Incident banners shown at the top of matching pages. Visitors pick up a change on
              their next action on the site.
            </Text>
          </Stack>
        </Group>

        <Card withBorder>
          <Stack gap="md">
            <Group justify="space-between">
              <Title order={4}>{form.id ? `Edit alert #${form.id}` : 'New alert'}</Title>
              {form.id ? (
                <Button variant="subtle" size="xs" onClick={() => setForm(emptyForm())}>
                  Cancel edit
                </Button>
              ) : (
                <Select
                  placeholder="“X is broken, fix rolling out”"
                  data={siteAlertPresets.map((x) => x.label)}
                  onChange={applyBrokenTemplate}
                  value={null}
                  w={280}
                  aria-label="Broken feature template"
                />
              )}
            </Group>

            <SegmentedControl
              data={siteAlertSeverities.map((x) => ({ label: x, value: x }))}
              value={form.severity}
              onChange={(value) => {
                const severity = value as SiteAlertSeverity;
                setForm((x) => ({
                  ...x,
                  severity,
                  dismissible: x.id ? x.dismissible : severity !== 'outage',
                }));
              }}
            />
            <TextInput
              label="Title"
              required
              maxLength={120}
              value={form.title}
              onChange={(e) => set('title', e.currentTarget.value)}
            />
            <Textarea
              label="Message"
              maxLength={500}
              autosize
              minRows={2}
              value={form.message}
              onChange={(e) => set('message', e.currentTarget.value)}
            />

            <Stack gap={6}>
              <Text size="sm" fw={500}>
                Feature presets
              </Text>
              <Group gap={6}>
                {siteAlertPresets.map((preset) => (
                  <Chip
                    key={preset.label}
                    size="xs"
                    checked={preset.paths.every((x) => form.paths.includes(x))}
                    onChange={(on) => togglePreset(preset.paths, on)}
                  >
                    {preset.label}
                  </Chip>
                ))}
              </Group>
            </Stack>
            <TagsInput
              label="Paths"
              description="Empty means every page. * matches one segment, ** any number. The query string is ignored."
              placeholder="/models/*/edit"
              value={form.paths}
              onChange={(paths) => set('paths', paths)}
              error={invalidPaths.length ? `Not a valid path: ${invalidPaths.join(', ')}` : null}
              clearable
            />

            <Group grow align="flex-start">
              <MultiSelect
                label="Domains"
                data={domainOptions}
                value={form.domains}
                onChange={(value) => set('domains', value as DomainColor[])}
              />
              {!form.id && (
                <NumberInput
                  label="Ends after (hours)"
                  min={0.25}
                  max={MAX_HOURS}
                  step={1}
                  decimalScale={2}
                  value={form.hours}
                  onChange={(value) => set('hours', Number(value) || 0)}
                />
              )}
            </Group>

            <Stack gap={6}>
              <Text size="sm" fw={500}>
                Surfaces
              </Text>
              <Group gap="md">
                <Checkbox label="Pages (by path)" checked readOnly />
                {(['generator', 'trainer'] as SiteAlertSurface[]).map((x) => (
                  <Checkbox key={x} label={x} disabled />
                ))}
              </Group>
              <Text size="xs" c="dimmed">
                Generator and trainer panels are not supported yet.
              </Text>
            </Stack>

            <Switch
              label="Visitors can dismiss it"
              checked={form.dismissible}
              onChange={(e) => set('dismissible', e.currentTarget.checked)}
            />

            {form.title.trim() && (
              <Stack gap={4}>
                <Text size="xs" c="dimmed">
                  Preview
                </Text>
                <SiteAlertStrip
                  alert={{
                    id: form.id ?? 0,
                    severity: form.severity,
                    title: form.title,
                    message: form.message || null,
                    paths: form.paths,
                    surfaces: ['everywhere'],
                    domains: form.domains,
                    startsAt: '',
                    endsAt: '',
                    dismissible: form.dismissible,
                  }}
                  onDismiss={() => undefined}
                />
              </Stack>
            )}

            <Group justify="flex-end">
              <Button
                onClick={handleSave}
                disabled={!canSave || (!form.id && form.hours <= 0)}
                loading={post.isPending || edit.isPending}
              >
                {form.id ? 'Save changes' : 'Post alert'}
              </Button>
            </Group>
          </Stack>
        </Card>

        <Stack gap="sm">
          <Title order={4}>Active and scheduled</Title>
          {isLoading ? (
            <Loader />
          ) : active.length === 0 ? (
            <Text c="dimmed" size="sm">
              No active alerts.
            </Text>
          ) : (
            active.map((alert) => (
              <AlertRow key={alert.id} alert={alert}>
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => extend.mutate({ id: alert.id, minutes: 60 })}
                >
                  +1h
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => extend.mutate({ id: alert.id, minutes: 240 })}
                >
                  +4h
                </Button>
                <Button size="xs" variant="default" onClick={() => startEdit(alert)}>
                  Edit
                </Button>
                <Button
                  size="xs"
                  color="red"
                  loading={end.isPending && end.variables?.id === alert.id}
                  onClick={() => end.mutate({ id: alert.id })}
                >
                  End now
                </Button>
              </AlertRow>
            ))
          )}
        </Stack>

        {ended.length > 0 && (
          <Stack gap="sm">
            <Title order={4}>Ended (last 7 days)</Title>
            {ended.map((alert) => (
              <AlertRow key={alert.id} alert={alert} />
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}

function AlertRow({ alert, children }: { alert: SiteAlertRecord; children?: React.ReactNode }) {
  const startsAt = new Date(alert.startsAt);
  const scheduled = startsAt.getTime() > Date.now();
  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <SiteAlertStrip alert={alert} />
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2}>
            <Group gap={6}>
              <Badge size="sm" variant="light">
                #{alert.id}
              </Badge>
              {scheduled && (
                <Badge size="sm" color="grape" variant="light">
                  starts {startsAt.toLocaleString()}
                </Badge>
              )}
              {!alert.dismissible && (
                <Badge size="sm" color="gray" variant="light">
                  not dismissible
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              {alert.paths.length ? alert.paths.join('  ') : 'Every page'} ·{' '}
              {alert.domains.join(', ')}
            </Text>
            <Text size="xs" c="dimmed">
              Ends {new Date(alert.endsAt).toLocaleString()} · posted by {alert.createdBy.username}
              {alert.updatedBy.id !== alert.createdBy.id ||
              alert.updatedBy.at !== alert.createdBy.at
                ? `, last change by ${alert.updatedBy.username}`
                : ''}
            </Text>
          </Stack>
          {children && <Group gap={6}>{children}</Group>}
        </Group>
      </Stack>
    </Card>
  );
}
