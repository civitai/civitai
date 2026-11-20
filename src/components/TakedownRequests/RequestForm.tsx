import { Alert, Anchor, Button, Stack, Text, Title } from '@mantine/core';
import { useRef, useState } from 'react';
import {
  TurnstilePrivacyNotice,
  TurnstileWidget,
  type TurnstileWidgetRef,
} from '~/components/TurnstileWidget/TurnstileWidget';
import { env } from '~/env/client';
import type { RequestForm as Form } from '~/server/services/takedown-requests.service';
import { trpc } from '~/utils/trpc';
import { fallbackMailbox } from './fallback-mailbox';
import { cleanValues, RequestFields, type FieldValues } from './RequestFields';

export function RequestForm({ form }: { form: Form }) {
  // One id per page load: a resubmit after a timeout files nothing new.
  const [submissionId] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<FieldValues>({});
  const [token, setToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileWidgetRef>(null);
  const submit = trpc.takedownRequest.submit.useMutation({
    // A checked token is spent, whatever the answer.
    onSettled: () => {
      setToken(null);
      turnstile.current?.reset();
    },
  });
  const result = submit.data;
  const mailbox = fallbackMailbox(form.key);

  if (result?.ok)
    return (
      <Stack gap="sm">
        <Title order={2}>We received your request</Title>
        <Text>
          Your case number is <strong>{result.publicRef}</strong>. We have emailed you a private
          link where you can check its status and add information. Keep that link private.
        </Text>
      </Stack>
    );

  const refused = result && !result.ok ? result : null;
  const showError = !!submit.error || (!!refused && !refused.fieldErrors);
  // The moderator app's own refusals (too many requests, a closed form) are worded for people.
  const refusalText =
    refused && !refused.fieldErrors && refused.status && refused.status < 500
      ? refused.message
      : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!token) return;
        submit.mutate({
          processKey: form.key,
          submissionId,
          values: cleanValues(form.fields, values),
          turnstileToken: token,
        });
      }}
    >
      <Stack gap="lg">
        <RequestFields
          fields={form.fields}
          values={values}
          errors={refused?.fieldErrors}
          disabled={submit.isPending}
          onChange={(id, v) => setValues((s) => ({ ...s, [id]: v }))}
        />
        {showError && (
          <Alert color="red">
            {refusalText ?? (
              <>
                We couldn&apos;t submit your request. Please try again, or email{' '}
                <Anchor href={`mailto:${mailbox}`}>{mailbox}</Anchor>.
              </>
            )}
          </Alert>
        )}
        <TurnstileWidget
          ref={turnstile}
          siteKey={env.NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITEKEY}
          options={{ size: 'flexible' }}
          onSuccess={setToken}
          onExpire={() => setToken(null)}
        />
        <TurnstilePrivacyNotice c="dimmed" />
        <Button type="submit" loading={submit.isPending} disabled={!token}>
          Submit
        </Button>
      </Stack>
    </form>
  );
}
