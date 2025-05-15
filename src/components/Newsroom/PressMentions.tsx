import { Card, Text, Title } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PressMention } from '~/shared/utils/prisma/models';
import { formatDate } from '~/utils/date-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import classes from './PressMentions.module.scss';

export function PressMentions({ pressMentions }: { pressMentions: PressMention[] }) {
  return (
    <div className={classes.articles}>
      {pressMentions.map((pressMention) => (
        <PressMentionItem key={pressMention.id} pressMention={pressMention} />
      ))}
    </div>
  );
}

export function PressMentionItem({ pressMention }: { pressMention: PressMention }) {
  return (
    <Card component={Link} href={pressMention.url} className={classes.card} withBorder>
      <Text className={classes.source}>{pressMention.source}</Text>
      <Title order={3} className={classes.title}>
        {pressMention.title}
      </Title>
      <Text className={classes.publishDate}>{formatDate(pressMention.publishedAt)}</Text>
    </Card>
  );
}
