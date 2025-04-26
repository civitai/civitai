import { Card, Text, Title, Box } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PressMention } from '~/shared/utils/prisma/models';
import { formatDate } from '~/utils/date-helpers';
import { styles } from './PressMentions.styles';

export function PressMentions({ pressMentions }: { pressMentions: PressMention[] }) {
  return (
    <Box sx={styles.articles}>
      {pressMentions.map((pressMention) => (
        <PressMentionItem key={pressMention.id} pressMention={pressMention} />
      ))}
    </Box>
  );
}

export function PressMentionItem({ pressMention }: { pressMention: PressMention }) {
  return (
    <Card component={Link} href={pressMention.url} sx={styles.card} withBorder>
      <Text sx={styles.source}>{pressMention.source}</Text>
      <Title order={3} sx={styles.title}>
        {pressMention.title}
      </Title>
      <Text sx={styles.publishDate}>{formatDate(pressMention.publishedAt)}</Text>
    </Card>
  );
}
