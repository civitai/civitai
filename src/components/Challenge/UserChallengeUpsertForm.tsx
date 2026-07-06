import { Alert, Button, Divider, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import * as z from 'zod';
import { BackButton } from '~/components/BackButton/BackButton';
import {
  Form,
  InputDateTimePicker,
  InputNumber,
  InputRTE,
  InputSelect,
  InputSimpleImageUpload,
  InputText,
  useForm,
} from '~/libs/form';
import {
  CHALLENGE_ENTRY_HOUSE_CUT,
  CHALLENGE_MAX_ENTRY_FEE,
  CHALLENGE_MIN_ENTRY_FEE,
  getEntryPoolContribution,
} from '~/shared/constants/challenge.constants';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

// UI schema: prize distribution + judging categories are flattened for the form and
// reassembled on submit into the shape userChallengeUpsertSchema expects.
const schema = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters').max(200),
  description: z.string().optional(),
  theme: z.string().min(1, 'Theme is required').max(100),
  coverImage: z
    .object({
      id: z.number().optional(),
      url: z.string(),
      hash: z.string().nullish(),
      width: z.number().nullish(),
      height: z.number().nullish(),
    })
    .refine((val) => !!val.url, { message: 'Cover image is required' }),
  judgeId: z.string().min(1, 'Pick a judge'),
  entryFee: z.number().min(CHALLENGE_MIN_ENTRY_FEE).max(CHALLENGE_MAX_ENTRY_FEE).default(CHALLENGE_MIN_ENTRY_FEE),
  initialPrizeBuzz: z.number().min(0).default(0),
  maxParticipants: z.number().min(1).max(100000).optional(),
  maxEntriesPerUser: z.number().min(1).max(100).default(5),
  dist1: z.number().min(0).max(100).default(50),
  dist2: z.number().min(0).max(100).default(30),
  dist3: z.number().min(0).max(100).default(20),
  cat1Name: z.string().default('Theme'),
  cat1Criteria: z.string().default('How well the entry fits the challenge theme.'),
  cat2Name: z.string().default('Creativity'),
  cat2Criteria: z.string().default('Originality and inventiveness of the entry.'),
  cat3Name: z.string().default('Aesthetic'),
  cat3Criteria: z.string().default('Overall visual quality and craft.'),
  startsAt: z.date(),
  endsAt: z.date(),
});
type FormData = z.infer<typeof schema>;

export function UserChallengeUpsertForm() {
  const router = useRouter();
  const queryUtils = trpc.useUtils();

  const now = new Date();
  const form = useForm({
    schema,
    defaultValues: {
      entryFee: CHALLENGE_MIN_ENTRY_FEE,
      initialPrizeBuzz: 0,
      maxEntriesPerUser: 5,
      dist1: 50,
      dist2: 30,
      dist3: 20,
      startsAt: new Date(now.getTime() + 60 * 60 * 1000),
      endsAt: new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000),
    },
    shouldUnregister: false,
  });

  const { data: judges } = trpc.challenge.getJudgeOptions.useQuery();
  const judgeOptions = (judges ?? []).map((j: { id: number; name: string }) => ({
    value: String(j.id),
    label: j.name,
  }));

  const entryFee = form.watch('entryFee') ?? CHALLENGE_MIN_ENTRY_FEE;
  const perEntryToPool = getEntryPoolContribution(entryFee);

  const upsertMutation = trpc.challenge.upsertUserChallenge.useMutation({
    onSuccess: async (result) => {
      showSuccessNotification({
        title: 'Challenge submitted',
        message: 'Your challenge is being reviewed and will go live once it passes moderation.',
      });
      await queryUtils.challenge.getInfinite.invalidate();
      await router.push(`/challenges/${result.id}`);
    },
    onError: (error) => {
      showErrorNotification({ title: 'Unable to create challenge', error: new Error(error.message) });
    },
  });

  const handleSubmit = (data: FormData) => {
    const distribution = [data.dist1, data.dist2, data.dist3];
    if (distribution.reduce((a, b) => a + b, 0) !== 100) {
      showErrorNotification({
        title: 'Invalid prize split',
        error: new Error('Prize distribution must add up to 100%.'),
      });
      return;
    }

    const judgingCategories = [
      { name: data.cat1Name, criteria: data.cat1Criteria },
      { name: data.cat2Name, criteria: data.cat2Criteria },
      { name: data.cat3Name, criteria: data.cat3Criteria },
    ].filter((c) => c.name.trim() && c.criteria.trim());

    upsertMutation.mutate({
      title: data.title,
      description: data.description,
      theme: data.theme,
      coverImage: data.coverImage,
      allowedNsfwLevel: sfwBrowsingLevelsFlag,
      modelVersionIds: [],
      judgeId: Number(data.judgeId),
      judgingCategories,
      entryFee: data.entryFee,
      initialPrizeBuzz: data.initialPrizeBuzz,
      prizeDistribution: distribution,
      maxParticipants: data.maxParticipants,
      maxEntriesPerUser: data.maxEntriesPerUser,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
    });
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack gap="md">
        <Group gap="xs">
          <BackButton url="/challenges" />
          <Title order={2}>Create a Challenge</Title>
        </Group>

        <Alert icon={<IconInfoCircle size={16} />} color="blue">
          Your challenge is funded by entry fees. Each entry pays the entry fee; {CHALLENGE_ENTRY_HOUSE_CUT}{' '}
          Buzz per entry covers AI judging and the rest grows the prize pool. A moderation scan runs
          before your challenge becomes visible.
        </Alert>

        <Paper withBorder p="md">
          <Stack gap="sm">
            <Title order={4}>Basics</Title>
            <InputText name="title" label="Title" placeholder="e.g. Neon Cyberpunk Portraits" withAsterisk />
            <InputText
              name="theme"
              label="Theme"
              description="A short theme the judge uses to assess entries."
              withAsterisk
            />
            <InputRTE name="description" label="Description" includeControls={['formatting', 'link', 'list']} />
            <InputSimpleImageUpload name="coverImage" label="Cover image" withAsterisk />
            <InputSelect name="judgeId" label="Judge" data={judgeOptions} withAsterisk searchable />
          </Stack>
        </Paper>

        <Paper withBorder p="md">
          <Stack gap="sm">
            <Title order={4}>Judging categories</Title>
            <Text size="sm" c="dimmed">
              These categories and how they&apos;re scored are shown publicly so entrants know exactly
              how they&apos;ll be judged.
            </Text>
            {[1, 2, 3].map((i) => (
              <SimpleGrid key={i} cols={{ base: 1, sm: 2 }}>
                <InputText name={`cat${i}Name`} label={`Category ${i} name`} />
                <InputText name={`cat${i}Criteria`} label={`Category ${i} — how to score it`} />
              </SimpleGrid>
            ))}
          </Stack>
        </Paper>

        <Paper withBorder p="md">
          <Stack gap="sm">
            <Title order={4}>Entry fee &amp; prizes</Title>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <InputNumber
                name="entryFee"
                label="Entry fee (Buzz)"
                min={CHALLENGE_MIN_ENTRY_FEE}
                max={CHALLENGE_MAX_ENTRY_FEE}
                description={`Min ${CHALLENGE_MIN_ENTRY_FEE}. ${perEntryToPool} Buzz of each entry goes to the prize pool.`}
              />
              <InputNumber
                name="initialPrizeBuzz"
                label="Initial prize (Buzz, optional)"
                min={0}
                description="Buzz you seed the pool with (charged to you on creation)."
              />
            </SimpleGrid>
            <Divider label="Prize split (must total 100%)" />
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <InputNumber name="dist1" label="1st place %" min={0} max={100} />
              <InputNumber name="dist2" label="2nd place %" min={0} max={100} />
              <InputNumber name="dist3" label="3rd place %" min={0} max={100} />
            </SimpleGrid>
          </Stack>
        </Paper>

        <Paper withBorder p="md">
          <Stack gap="sm">
            <Title order={4}>Limits &amp; schedule</Title>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <InputNumber
                name="maxParticipants"
                label="Max participants (optional)"
                min={1}
                description="Caps total entries — bounds your judging cost."
              />
              <InputNumber name="maxEntriesPerUser" label="Max entries per participant" min={1} max={100} />
              <InputDateTimePicker name="startsAt" label="Starts at" withAsterisk />
              <InputDateTimePicker name="endsAt" label="Ends at" withAsterisk />
            </SimpleGrid>
          </Stack>
        </Paper>

        <Group justify="flex-end">
          <Button type="submit" loading={upsertMutation.isPending}>
            Submit challenge
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}
