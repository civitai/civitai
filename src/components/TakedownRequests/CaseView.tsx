import { Alert, Anchor, Button, Card, List, Loader, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { CaseView as View } from '~/server/services/takedown-requests.service';
import { cleanValues, RequestFields, type FieldValues } from './RequestFields';

type Load = { view: View } | { error: string; retry?: boolean } | null;
const NOT_VALID = 'This link has expired or is not valid. Use the latest link we emailed you.';
/** Where the page's inline head script leaves the link token it took out of the address bar. */
export const CASE_LINK_KEY = 'civ-case-link';

/** What a failed load tells the person: only a refused link reads as expired. */
function loadError(status: number): Exclude<Load, null | { view: View }> {
  if (status === 401 || status === 404) return { error: NOT_VALID };
  if (status === 429)
    return { error: 'Too many requests. Try again in a few minutes.', retry: true };
  return { error: 'We couldn’t load your case right now. Try again in a moment.', retry: true };
}

async function call(publicRef: string, init?: { body: unknown }) {
  const res = await fetch(`/api/requests/case/${publicRef}`, {
    method: init ? 'POST' : 'GET',
    headers: init ? { 'content-type': 'application/json' } : undefined,
    body: init ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/**
 * The case a party's private link opens. The token arrives in the fragment; it is exchanged once for a
 * cookie and taken out of the address bar, so it is not left in history or shared with a copied URL.
 */
export function CaseView({ publicRef }: { publicRef: string }) {
  const [load, setLoad] = useState<Load>(null);

  const refresh = async () => {
    // The token from the email link, kept only until a cookie holds it, so a failed first try can be
    // retried without the link.
    const token = sessionStorage.getItem(`${CASE_LINK_KEY}:${publicRef}`);
    const res = token ? await call(publicRef, { body: { token } }) : await call(publicRef);
    if (res.ok) sessionStorage.removeItem(`${CASE_LINK_KEY}:${publicRef}`);
    setLoad(res.ok ? { view: res.body as View } : loadError(res.status));
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicRef]);

  if (!load) return <Loader />;
  if ('error' in load)
    return (
      <Stack gap="sm">
        <Alert color="red">{load.error}</Alert>
        {load.retry && (
          <Button variant="default" onClick={() => void refresh()}>
            Try again
          </Button>
        )}
      </Stack>
    );
  const { view } = load;

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={2}>{view.title}</Title>
        <Text c="dimmed">
          Case {view.publicRef}, received {new Date(view.receivedAt).toUTCString()}
        </Text>
        <Text>
          Status: <strong>{view.state.label}</strong>
        </Text>
      </Stack>
      {view.items.length > 0 && (
        <Stack gap={4}>
          <Text fw={600}>Items</Text>
          <List>
            {view.items.map((i) => (
              <List.Item key={i.url}>
                <Anchor href={i.url} target="_blank" rel="noopener noreferrer">
                  {i.url}
                </Anchor>
              </List.Item>
            ))}
          </List>
        </Stack>
      )}
      {view.actions.map((a) => (
        <CaseAction key={a.id} publicRef={publicRef} action={a} onDone={refresh} />
      ))}
    </Stack>
  );
}

function CaseAction({
  publicRef,
  action,
  onDone,
}: {
  publicRef: string;
  action: View['actions'][number];
  onDone: () => Promise<void>;
}) {
  const [values, setValues] = useState<FieldValues>({});
  // One id per filing: a retry after a timeout records nothing new.
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [errors, setErrors] = useState<Record<string, string>>();
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [pending, setPending] = useState(false);

  return (
    <Card withBorder>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          const res = await call(publicRef, {
            body: { actionId: action.id, submissionId, values: cleanValues(action.fields, values) },
          }).finally(() => setPending(false));
          setErrors(res.body.fieldErrors);
          if (res.ok) {
            setMessage({ ok: true, text: 'Sent. We have recorded it on your case.' });
            setValues({});
            setSubmissionId(crypto.randomUUID());
            await onDone();
          } else if (!res.body.fieldErrors)
            setMessage({
              ok: false,
              text:
                res.status < 500 ? res.body.message : 'We couldn’t send this. Please try again.',
            });
        }}
      >
        <Stack gap="md">
          <Text fw={600}>{action.label}</Text>
          <RequestFields
            fields={action.fields}
            values={values}
            errors={errors}
            disabled={pending}
            onChange={(id, v) => setValues((s) => ({ ...s, [id]: v }))}
          />
          {message && <Alert color={message.ok ? 'green' : 'red'}>{message.text}</Alert>}
          <Button type="submit" loading={pending}>
            {action.label}
          </Button>
        </Stack>
      </form>
    </Card>
  );
}
