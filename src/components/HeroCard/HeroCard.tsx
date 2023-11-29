import { Anchor, Card, CardProps, Group, Stack, Text, createStyles } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';

const useStyles = createStyles((theme) => ({
  card: {
    [theme.fn.largerThan('sm')]: {
      display: 'flex',
      gap: 40,
    },
  },
  section: {
    [theme.fn.largerThan('sm')]: {
      marginRight: 0,
      marginBottom: -40,
    },
  },
  title: {
    fontSize: 40,
    [theme.fn.smallerThan('sm')]: {
      fontSize: 28,
      marginTop: theme.spacing.xl,
    },
  },
}));

export function HeroCard({
  imageUrl,
  title,
  description,
  externalLink,
  className,
  ...cardProps
}: Props) {
  const { classes, cx } = useStyles();

  return (
    <Card radius="lg" p={40} className={cx(classes.card, className)} {...cardProps}>
      <Card.Section className={classes.section}>
        <img
          src={imageUrl}
          alt={title}
          width={480}
          height={376}
          style={{
            objectFit: 'cover',
            objectPosition: 'top',
          }}
        />
      </Card.Section>
      <Stack spacing={32}>
        <Text className={classes.title} weight={600}>
          {title}
        </Text>
        <Text size={20}>{description}</Text>
        <Anchor
          size="xl"
          weight="bold"
          target="_blank"
          rel="nofollow noreferrer"
          sx={{ color: 'white' }}
        >
          <Group spacing={8}>
            Learn more about {title}
            <IconExternalLink size={24} color="currentColor" />
          </Group>
        </Anchor>
      </Stack>
    </Card>
  );
}

type Props = Omit<CardProps, 'children'> & {
  imageUrl: string;
  title: string;
  description: string;
  externalLink?: string;
};
