import {
  Alert,
  Badge,
  Button,
  Card,
  Loader,
  Radio,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import type { RouterOutput } from '~/types/router';
import {
  SITE_APPEAL_LINK_MAX,
  SITE_APPEAL_MESSAGE_MAX,
  SITE_APPEAL_SUBJECT_MAX,
  submitSiteAppealSchema,
} from '~/server/schema/site-appeal.schema';
import type { SiteAppealContext } from '~/server/schema/site-appeal.schema';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { AppealCategory, AppealStatus } from '~/shared/utils/prisma/enums';

type SiteAppealState = RouterOutput['report']['getSiteAppealState'];
type SiteAppealRow = SiteAppealState['appeals'][number];

const CATEGORY_LABELS: Record<AppealCategory, string> = {
  [AppealCategory.Account]: 'My account was banned or muted',
  [AppealCategory.Article]: 'An article of mine was removed',
  [AppealCategory.Model]: 'A model of mine was unpublished by a moderator',
  [AppealCategory.Other]: 'Something else',
};

const STATUS_BADGE: Record<AppealStatus, { color: string; label: string }> = {
  [AppealStatus.Pending]: { color: 'yellow', label: 'Under review' },
  [AppealStatus.Approved]: { color: 'green', label: 'Approved' },
  [AppealStatus.Rejected]: { color: 'red', label: 'Decision upheld' },
  [AppealStatus.Void]: { color: 'gray', label: 'Closed' },
};

/**
 * The site appeal form and the caller's own form appeals. `accountOnly` is the banned screen's
 * variant: an account appeal is the only kind a banned user can make or act on.
 */
export function SiteAppealPanel({
  accountOnly,
  initialCategory,
  initialEntityId,
}: {
  accountOnly?: boolean;
  initialCategory?: AppealCategory;
  initialEntityId?: number;
}) {
  const { data, isLoading, error } = trpc.report.getSiteAppealState.useQuery();

  if (isLoading) return <Loader className="mx-auto" />;
  if (error || !data)
    return (
      <Alert color="red" title="We could not load your appeals">
        {error?.message ?? 'Please try again later.'}
      </Alert>
    );

  const appeals = accountOnly
    ? data.appeals.filter((a) => a.category === AppealCategory.Account)
    : data.appeals;

  return (
    <Stack gap="lg">
      <SiteAppealForm
        state={data}
        accountOnly={accountOnly}
        initialCategory={initialCategory}
        initialEntityId={initialEntityId}
      />
      {appeals.length > 0 && <SiteAppealList appeals={appeals} />}
    </Stack>
  );
}

function availableCategories(state: SiteAppealState, accountOnly?: boolean) {
  const restricted = state.restriction.banned || state.restriction.muted;
  return Object.values(AppealCategory).filter((category) => {
    if (accountOnly) return category === AppealCategory.Account && restricted;
    switch (category) {
      case AppealCategory.Account:
        return restricted;
      case AppealCategory.Article:
        return state.articles.length > 0;
      case AppealCategory.Model:
        return state.models.length > 0;
      case AppealCategory.Other:
        return true;
    }
  });
}

function SiteAppealForm({
  state,
  accountOnly,
  initialCategory,
  initialEntityId,
}: {
  state: SiteAppealState;
  accountOnly?: boolean;
  initialCategory?: AppealCategory;
  initialEntityId?: number;
}) {
  const utils = trpc.useUtils();
  const categories = availableCategories(state, accountOnly);
  const [category, setCategory] = useState<AppealCategory | undefined>(
    initialCategory && categories.includes(initialCategory)
      ? initialCategory
      : categories.length === 1
      ? categories[0]
      : undefined
  );
  const [entityId, setEntityId] = useState<string | null>(
    initialEntityId ? String(initialEntityId) : null
  );
  const [subject, setSubject] = useState('');
  const [link, setLink] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = trpc.report.submitSiteAppeal.useMutation({
    onSuccess: async () => {
      setMessage('');
      setSubject('');
      setLink('');
      setErrors({});
      showSuccessNotification({
        title: 'Appeal submitted',
        message: 'A moderator will review it. You will be notified of the decision.',
      });
      await utils.report.getSiteAppealState.invalidate();
    },
  });

  if (categories.length === 0) return null;

  const entityOptions =
    category === AppealCategory.Article
      ? state.articles.map((a) => ({ value: String(a.id), label: a.title }))
      : category === AppealCategory.Model
      ? state.models.map((m) => ({ value: String(m.id), label: m.name }))
      : [];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = submitSiteAppealSchema.safeParse({
      category,
      entityId: entityId ? Number(entityId) : undefined,
      subject,
      link,
      message,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'category');
        next[key] ??= key === 'category' ? 'Choose what you are appealing' : issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    submit.mutate(parsed.data);
  };

  return (
    <Card withBorder component="form" onSubmit={handleSubmit}>
      <Stack>
        <Title order={3}>{accountOnly ? 'Appeal this decision' : 'Submit an appeal'}</Title>
        {!accountOnly && (
          <Radio.Group
            label="What are you appealing?"
            value={category ?? null}
            onChange={(value) => {
              setCategory(value as AppealCategory);
              setEntityId(null);
            }}
            error={errors.category}
          >
            <Stack gap="xs" mt="xs">
              {categories.map((c) => (
                <Radio key={c} value={c} label={CATEGORY_LABELS[c]} />
              ))}
            </Stack>
          </Radio.Group>
        )}
        {entityOptions.length > 0 && (
          <Select
            label={category === AppealCategory.Article ? 'Article' : 'Model'}
            placeholder="Choose one"
            data={entityOptions}
            value={entityId}
            onChange={setEntityId}
            error={errors.entityId}
            searchable
          />
        )}
        {category === AppealCategory.Other && (
          <>
            <TextInput
              label="What is this about?"
              value={subject}
              onChange={(e) => setSubject(e.currentTarget.value)}
              maxLength={SITE_APPEAL_SUBJECT_MAX}
              error={errors.subject}
            />
            <TextInput
              label="Link (optional)"
              description="A link to the content or page this is about"
              placeholder="https://civitai.com/..."
              value={link}
              onChange={(e) => setLink(e.currentTarget.value)}
              maxLength={SITE_APPEAL_LINK_MAX}
              error={errors.link}
            />
          </>
        )}
        {category && (
          <Textarea
            label="Why should we reconsider?"
            description="Explain what happened and why you believe the decision was wrong."
            value={message}
            onChange={(e) => setMessage(e.currentTarget.value)}
            maxLength={SITE_APPEAL_MESSAGE_MAX}
            autosize
            minRows={4}
            error={errors.message}
          />
        )}
        {submit.error && <Alert color="red">{submit.error.message}</Alert>}
        <Button type="submit" loading={submit.isPending} disabled={!category} className="self-end">
          Submit appeal
        </Button>
      </Stack>
    </Card>
  );
}

function appealSubject(appeal: SiteAppealRow) {
  if (appeal.category === AppealCategory.Other)
    return (appeal.context as SiteAppealContext | null)?.subject ?? CATEGORY_LABELS.Other;
  if (appeal.category === AppealCategory.Account) return 'Account restriction';
  return `${appeal.category} #${appeal.entityId}`;
}

function SiteAppealList({ appeals }: { appeals: SiteAppealRow[] }) {
  return (
    <Stack gap="sm">
      <Title order={4}>Your appeals</Title>
      {appeals.map((appeal) => {
        const badge = STATUS_BADGE[appeal.status];
        return (
          <Card key={appeal.id} withBorder>
            <Stack gap={4}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Text fw={600}>{appealSubject(appeal)}</Text>
                <Badge color={badge.color}>{badge.label}</Badge>
              </div>
              <Text size="xs" c="dimmed">
                Submitted {formatDate(appeal.createdAt)}
                {appeal.resolvedAt && ` · Reviewed ${formatDate(appeal.resolvedAt)}`}
              </Text>
              {appeal.resolvedMessage && (
                <Text size="sm">
                  <Text span fw={600}>
                    Moderator:{' '}
                  </Text>
                  {appeal.resolvedMessage}
                </Text>
              )}
            </Stack>
          </Card>
        );
      })}
    </Stack>
  );
}
