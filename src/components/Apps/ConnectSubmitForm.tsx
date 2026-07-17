import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Loader,
  Select,
  Stack,
  Stepper,
  Table,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconExternalLink,
  IconPlugConnected,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ListingAssetStep } from '~/components/Apps/ListingAssetStep';
import {
  CONNECT_CATEGORY_OPTIONS,
  CONNECT_CONTENT_RATING_OPTIONS,
  CONNECT_SUBMIT_LIMITS,
  emptyConnectSubmitForm,
  isConnectClientStepComplete,
  isConnectDetailsStepComplete,
  scopeKeyForBit,
  toSubmitConnectInput,
  toggleScopeBit,
  validateConnectSubmitForm,
  type ConnectSubmitFormErrors,
  type ConnectSubmitFormValues,
} from '~/components/Apps/connectSubmitFormConfig';
import type { MarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import type { OffsiteContentRating } from '~/server/schema/blocks/offsite-listing.schema';
import { isAppBlockOauthClientId } from '~/shared/constants/block-scope.constants';
import {
  tokenScopeGrid,
  tokenScopeLabels,
  tokenScopeMaskToList,
} from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/submit — "Connect an app" mode body (W13, un-defers the OAuth-connect seam).
 * A native publish-request flow that links a registered OAuth client the caller OWNS
 * (design B1: creates a DRAFT listing + a pending request on submit), then reuses the
 * standard asset step. The author picks one of their own OAuth apps, opts INTO the
 * subset of that app's allowed scopes it will request (explicit opt-in from empty),
 * and writes a short justification per requested scope.
 *
 * DISCLOSURE/REVIEW-ONLY: the requested-scope subset is stored + reviewed; it does
 * NOT gate OAuth token issuance (the client's allowedScopes stays the runtime ceiling
 * via the existing consent flow).
 *
 * The server (`submitConnectListing`) is the source of truth; the client mirror
 * (`validateConnectSubmitForm`) only surfaces inline errors before the round-trip.
 *
 * DARK: reachable only behind `app-blocks-author` (the gSSP gate on /apps/submit is
 * unchanged) — mirrors the External-link mode's gating.
 */

type Submitted = { listingId: string; publishRequestId: string; slug: string };

const STEP_CLIENT = 0;
const STEP_DETAILS = 1;
const STEP_ASSETS = 2;

export function ConnectSubmitForm() {
  const [active, setActive] = useState<number>(STEP_CLIENT);
  const [values, setValues] = useState<ConnectSubmitFormValues>(emptyConnectSubmitForm());
  const [errors, setErrors] = useState<ConnectSubmitFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);

  const clientsQuery = trpc.oauthClient.getAll.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  // The caller's OWN OAuth clients, EXCLUDING App-Block clients (managed by the App
  // Blocks flow — never a hand-authored connect target). `getAll` is already scoped
  // to the caller (`userId`), so this is the ownership filter + the app-block exclude.
  const clients = useMemo(
    () => (clientsQuery.data ?? []).filter((c) => !isAppBlockOauthClientId(c.id)),
    [clientsQuery.data]
  );

  const selectedClient = useMemo(
    () => clients.find((c) => c.id === values.connectClientId) ?? null,
    [clients, values.connectClientId]
  );
  const allowedScopes = selectedClient?.allowedScopes ?? 0;

  const submitMutation = trpc.appListings.submitConnectListing.useMutation({
    onSuccess: (res: Submitted) => {
      setSubmitted(res);
      setServerError(null);
      setActive(STEP_ASSETS);
      showSuccessNotification({ message: 'Draft created. Add your assets to finish.' });
    },
    onError: (e: { message: string }) => {
      setServerError(e.message);
      showErrorNotification({ title: 'Could not create the listing', error: new Error(e.message) });
    },
  });

  function setField<K extends keyof ConnectSubmitFormValues>(
    key: K,
    value: ConnectSubmitFormValues[K]
  ) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function handleSelectClient(clientId: string | null) {
    // Changing the client resets the requested scopes + justifications — the new
    // client has a DIFFERENT ceiling, so a carried-over mask could exceed it.
    setValues((v) => ({
      ...v,
      connectClientId: clientId,
      requestedScopes: 0,
      scopeJustifications: {},
    }));
    setErrors((prev) => ({ ...prev, connectClientId: undefined, requestedScopes: undefined }));
  }

  function handleToggleScope(bit: number) {
    setValues((v) => toggleScopeBit(v, bit));
  }

  function handleJustificationChange(key: string, text: string) {
    setValues((v) => ({
      ...v,
      scopeJustifications: { ...v.scopeJustifications, [key]: text },
    }));
  }

  function handleDetailsKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (isConnectDetailsStepComplete(values, allowedScopes)) handleCreateDraft();
  }

  function handleAdvanceFromClient() {
    if (!isConnectClientStepComplete(values, allowedScopes)) {
      setErrors((prev) => ({
        ...prev,
        connectClientId: values.connectClientId ? undefined : 'Choose one of your OAuth apps.',
      }));
      return;
    }
    setErrors((prev) => ({ ...prev, connectClientId: undefined, requestedScopes: undefined }));
    setActive(STEP_DETAILS);
  }

  function handleCreateDraft() {
    const nextErrors = validateConnectSubmitForm(values, allowedScopes);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    submitMutation.mutate(toSubmitConnectInput(values));
  }

  function handleStepClick(step: number) {
    if (submitted) return;
    if (step === STEP_CLIENT) setActive(STEP_CLIENT);
    else if (step === STEP_DETAILS && isConnectClientStepComplete(values, allowedScopes)) {
      setActive(STEP_DETAILS);
    }
  }

  const busy = submitMutation.isPending;
  const requestedScopeList = tokenScopeMaskToList(values.requestedScopes);

  const clientOptions = clients.map((c) => ({ value: c.id, label: c.name }));

  return (
    <Stack gap="md" data-testid="apps-connect-submit-form">
      <Alert
        color="blue"
        variant="light"
        icon={<IconPlugConnected size={16} />}
        title="Connect an app"
      >
        <Text size="sm">
          Link one of your registered OAuth apps so users can grant it access. Disclose the scopes
          your app requests and why — a moderator reviews it before it appears. This does not change
          what your app can do: your OAuth client’s allowed scopes stay the limit.
        </Text>
      </Alert>

      {serverError && (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          title="Submission problem"
        >
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {serverError}
          </Text>
        </Alert>
      )}

      <Stepper active={active} onStepClick={handleStepClick} allowNextStepsSelect={false} size="sm">
        <Stepper.Step
          label="App & scopes"
          description="Your OAuth app"
          allowStepClick={!submitted}
          data-testid="apps-connect-wizard-step-client"
        >
          <Stack gap="md" mt="md">
            {clientsQuery.isLoading ? (
              <Group gap={8} data-testid="apps-connect-clients-loading">
                <Loader size={16} />
                <Text size="sm" c="dimmed">
                  Loading your OAuth apps…
                </Text>
              </Group>
            ) : clients.length === 0 ? (
              <Alert color="gray" variant="light" data-testid="apps-connect-no-clients">
                <Text size="sm">
                  You have no eligible OAuth apps. Register one in your account settings first, then
                  come back to list it.
                </Text>
              </Alert>
            ) : (
              <>
                <Select
                  label="OAuth app"
                  description="One of your registered OAuth clients. Users will grant this app access."
                  placeholder="Choose an app"
                  data={clientOptions}
                  value={values.connectClientId}
                  onChange={handleSelectClient}
                  error={errors.connectClientId}
                  disabled={busy}
                  required
                  data-testid="apps-connect-client-select"
                />

                {selectedClient && (
                  <Stack gap="xs" data-testid="apps-connect-scope-grid">
                    <div>
                      <Text size="sm" fw={500}>
                        Requested scopes
                      </Text>
                      <Text size="xs" c="dimmed">
                        Check only the scopes your app needs. Scopes greyed out aren’t in this app’s
                        allowed set.
                      </Text>
                    </div>
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
                            {(['read', 'write', 'delete'] as const).map((col) => {
                              const bit = (row as { read?: number; write?: number; delete?: number })[
                                col
                              ];
                              const available = bit != null && Flags.hasFlag(allowedScopes, bit);
                              return (
                                <Table.Td key={col} style={{ textAlign: 'center' }}>
                                  {bit != null ? (
                                    <Checkbox
                                      checked={Flags.hasFlag(values.requestedScopes, bit)}
                                      onChange={() => handleToggleScope(bit)}
                                      disabled={!available || busy}
                                      styles={{ input: { cursor: available ? 'pointer' : 'not-allowed' } }}
                                      data-testid={`apps-connect-scope-${bit}`}
                                    />
                                  ) : (
                                    <Text size="xs" c="dimmed">
                                      —
                                    </Text>
                                  )}
                                </Table.Td>
                              );
                            })}
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                    {errors.requestedScopes && (
                      <Text size="xs" c="red">
                        {errors.requestedScopes}
                      </Text>
                    )}

                    {requestedScopeList.length > 0 && (
                      <Stack gap="sm" data-testid="apps-connect-justifications">
                        <Text size="sm" fw={500}>
                          Why do you need each scope? (optional, helps review)
                        </Text>
                        {requestedScopeList.map(({ bit, key, label }) => {
                          const justificationKey = scopeKeyForBit(bit);
                          const text = values.scopeJustifications[justificationKey] ?? '';
                          return (
                            <Textarea
                              key={bit}
                              label={label || tokenScopeLabels[bit] || key}
                              placeholder="Explain why your app needs this scope…"
                              autosize
                              minRows={2}
                              maxRows={4}
                              value={text}
                              onChange={(e) =>
                                handleJustificationChange(justificationKey, e.currentTarget.value)
                              }
                              maxLength={CONNECT_SUBMIT_LIMITS.justificationMax}
                              disabled={busy}
                              description={`${text.length}/${CONNECT_SUBMIT_LIMITS.justificationMax}`}
                              data-testid={`apps-connect-justification-${bit}`}
                            />
                          );
                        })}
                      </Stack>
                    )}
                  </Stack>
                )}
              </>
            )}

            <Group justify="space-between">
              <Button variant="default" component={Link} href="/apps/my-submissions" disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={handleAdvanceFromClient}
                disabled={busy || !isConnectClientStepComplete(values, allowedScopes)}
                data-testid="apps-connect-wizard-next-client"
              >
                Next
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Step
          label="Details"
          description="Name & metadata"
          allowStepClick={!submitted && isConnectClientStepComplete(values, allowedScopes)}
          data-testid="apps-connect-wizard-step-details"
        >
          <Stack gap="md" mt="md">
            <TextInput
              label="Name"
              placeholder="My Connected App"
              value={values.name}
              onChange={(e) => setField('name', e.currentTarget.value)}
              onKeyDown={handleDetailsKeyDown}
              error={errors.name}
              maxLength={CONNECT_SUBMIT_LIMITS.nameMax}
              required
              disabled={busy}
              data-autofocus
              data-testid="apps-connect-submit-name"
            />

            <TextInput
              label="Slug"
              description={`Your app's URL slug (${CONNECT_SUBMIT_LIMITS.slugMin}–${CONNECT_SUBMIT_LIMITS.slugMax} chars, lowercase a–z / 0–9 / hyphens).`}
              placeholder="my-connected-app"
              value={values.slug}
              onChange={(e) => setField('slug', e.currentTarget.value)}
              onKeyDown={handleDetailsKeyDown}
              error={errors.slug}
              maxLength={CONNECT_SUBMIT_LIMITS.slugMax}
              required
              disabled={busy}
              data-testid="apps-connect-submit-slug"
            />

            <TextInput
              label="Tagline"
              description="A short one-liner (optional)."
              value={values.tagline}
              onChange={(e) => setField('tagline', e.currentTarget.value)}
              onKeyDown={handleDetailsKeyDown}
              error={errors.tagline}
              maxLength={CONNECT_SUBMIT_LIMITS.taglineMax}
              disabled={busy}
            />

            <Textarea
              label="Description"
              description="What the app does (optional)."
              autosize
              minRows={3}
              maxRows={8}
              value={values.description}
              onChange={(e) => setField('description', e.currentTarget.value)}
              error={errors.description}
              maxLength={CONNECT_SUBMIT_LIMITS.descriptionMax}
              disabled={busy}
            />

            <Group grow align="flex-start">
              <Select
                label="Category"
                placeholder="No category"
                data={CONNECT_CATEGORY_OPTIONS}
                value={values.category}
                onChange={(v: string | null) =>
                  setField('category', (v as MarketplaceCategory) || null)
                }
                error={errors.category}
                clearable
                disabled={busy}
              />
              <Select
                label="Content rating"
                data={CONNECT_CONTENT_RATING_OPTIONS}
                value={values.contentRating}
                onChange={(v: string | null) =>
                  setField('contentRating', (v as OffsiteContentRating) || 'g')
                }
                error={errors.contentRating}
                allowDeselect={false}
                disabled={busy}
              />
            </Group>

            <Textarea
              label="What is this app? (optional)"
              description="A note for the reviewer — recorded on the request."
              autosize
              minRows={2}
              maxRows={6}
              value={values.changelog}
              onChange={(e) => setField('changelog', e.currentTarget.value)}
              error={errors.changelog}
              maxLength={CONNECT_SUBMIT_LIMITS.changelogMax}
              disabled={busy}
            />

            <Group justify="space-between">
              <Button
                variant="default"
                onClick={() => setActive(STEP_CLIENT)}
                disabled={busy}
                data-testid="apps-connect-wizard-back-details"
              >
                Back
              </Button>
              <Button
                onClick={handleCreateDraft}
                loading={busy}
                disabled={!isConnectDetailsStepComplete(values, allowedScopes)}
                leftSection={<IconPlugConnected size={16} />}
                data-testid="apps-connect-submit-create"
              >
                Create draft
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Step
          label="Assets"
          description="Icon, cover, screenshots"
          allowStepClick={false}
          data-testid="apps-connect-wizard-step-assets"
        >
          <div data-testid="apps-connect-wizard-assets-panel">
            {submitted ? (
              <ListingAssetStep
                listingId={submitted.listingId}
                contentRating={values.contentRating}
                suggestions={{}}
                header={
                  <Alert
                    color="green"
                    variant="light"
                    icon={<IconCheck size={16} />}
                    title="Draft created"
                  >
                    <Text size="sm">
                      <Code>{submitted.slug}</Code> is a pending connect submission. Attach an icon, a
                      cover and at least one screenshot below — a moderator can only approve an
                      asset-complete listing. Content rating:{' '}
                      <Badge size="xs">{values.contentRating}</Badge>
                    </Text>
                  </Alert>
                }
                footer={
                  <Group justify="flex-end">
                    <Button
                      component={Link}
                      href="/apps/my-submissions"
                      rightSection={<IconExternalLink size={16} />}
                    >
                      View my submissions
                    </Button>
                  </Group>
                }
              />
            ) : (
              <Alert color="gray" variant="light" mt="md">
                <Text size="sm">Create the draft on the previous step to add assets.</Text>
              </Alert>
            )}
          </div>
        </Stepper.Step>
      </Stepper>
    </Stack>
  );
}
