import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Grid,
  Group,
  Paper,
  Progress,
  Stack,
  Table,
  Text,
  Title,
  Loader,
  Code,
  Accordion,
} from '@mantine/core';
import { IconCheck, IconX, IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { isDev, isTest } from '~/env/other';
import type { NewOrderDamnedReason } from '~/server/common/enums';
import { NsfwLevel } from '~/server/common/enums';
import { Form, InputNumber, InputSelect, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';

const NSFW_LEVELS = [
  { value: NsfwLevel.PG, label: 'PG (Suggestive)' },
  { value: NsfwLevel.PG13, label: 'PG13 (Partial Nudity)' },
  { value: NsfwLevel.R, label: 'R (Nudity)' },
  { value: NsfwLevel.X, label: 'X (Sexual)' },
  { value: NsfwLevel.XXX, label: 'XXX (Explicit)' },
  { value: NsfwLevel.Blocked, label: 'Blocked (Violation)' },
];

const DAMNED_REASONS = [
  { value: 'CSAM', label: 'CSAM' },
  { value: 'MinorSexualized', label: 'Minor Sexualized' },
  { value: 'RealPerson', label: 'Real Person' },
  { value: 'Other', label: 'Other' },
];

const voteSchema = z.object({
  imageId: z.number().min(1, 'Image ID is required'),
  rating: z.enum(NsfwLevel),
  userId: z.number().optional(),
  damnedReason: z.string().optional(),
  level: z.number().min(20).max(80).optional(),
  smites: z.number().min(0).max(6).optional(),
});

export default function KonoVotingTestPage() {
  const [imageId, setImageId] = useState<number | undefined>();
  const [lastVoteResult, setLastVoteResult] = useState<any>(null);

  // Vote submission form
  const form = useForm({
    schema: voteSchema,
    defaultValues: {
      imageId: undefined,
      rating: NsfwLevel.PG13,
      userId: undefined,
      damnedReason: undefined,
      level: undefined,
      smites: undefined,
    },
  });

  // Mutations
  const submitVote = trpc.games.newOrder.testVote.useMutation();
  const resetVotes = trpc.games.newOrder.resetImageVotes.useMutation();

  // Queries
  const queueState = trpc.games.newOrder.getQueueState.useQuery(imageId ? { imageId } : undefined, {
    enabled: !!imageId,
  });
  const voteDetails = trpc.games.newOrder.getVoteDetails.useQuery(
    { imageId: imageId! },
    { enabled: !!imageId }
  );

  if (!(isDev || isTest)) return <NotFound />;

  const handleSubmitVote = async (values: z.infer<typeof voteSchema>) => {
    try {
      const result = await submitVote.mutateAsync({
        imageId: values.imageId,
        rating: values.rating as NsfwLevel,
        userId: values.userId,
        damnedReason: values.damnedReason as NewOrderDamnedReason | undefined,
      });
      setLastVoteResult(result);
      setImageId(values.imageId);
      queueState.refetch();
      voteDetails.refetch();
    } catch (error) {
      console.error('Vote submission error:', error);
    }
  };

  const handleReset = async () => {
    if (!imageId) return;
    try {
      await resetVotes.mutateAsync({ imageId });
      setLastVoteResult(null);
      queueState.refetch();
      voteDetails.refetch();
    } catch (error) {
      console.error('Reset error:', error);
    }
  };

  const handleInspect = () => {
    const id = form.getValues().imageId;
    if (id) {
      setImageId(id);
    }
  };

  return (
    <Container size="xl" py="xl">
      <Stack gap="xl">
        <div>
          <Title order={1}>Knights of New Order - Voting Test UI</Title>
          <Text c="dimmed" mt="xs">
            Manual testing interface for weighted voting and consensus system
          </Text>
        </div>

        {/* Vote Submission Form */}
        <Card withBorder>
          <Form form={form} onSubmit={handleSubmitVote}>
            <Stack gap="md">
              <Title order={3}>Submit Test Vote</Title>

              <Grid>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <InputNumber
                    name="imageId"
                    label="Image ID"
                    placeholder="Enter image ID"
                    required
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <InputNumber
                    name="userId"
                    label="User ID (optional)"
                    placeholder="Defaults to your user ID"
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <InputSelect name="rating" label="NSFW Rating" data={NSFW_LEVELS} required />
                </Grid.Col>
              </Grid>

              <Grid>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <InputNumber
                    name="level"
                    label="Custom Level (20-80)"
                    placeholder="Leave empty for actual level"
                    min={20}
                    max={80}
                    description="Override player level for vote weight testing"
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <InputNumber
                    name="smites"
                    label="Custom Smites (0-6)"
                    placeholder="Leave empty for actual smites"
                    min={0}
                    max={6}
                    description="Override smites for vote weight testing"
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <InputSelect
                    name="damnedReason"
                    label="Damned Reason (for Blocked)"
                    data={DAMNED_REASONS}
                    placeholder="Optional"
                    clearable
                  />
                </Grid.Col>
              </Grid>

              <Group>
                <Button type="submit" loading={submitVote.isPending}>
                  Submit Vote
                </Button>
                <Button variant="light" onClick={handleInspect}>
                  Inspect Image
                </Button>
                <Button
                  variant="outline"
                  color="red"
                  onClick={handleReset}
                  loading={resetVotes.isPending}
                  disabled={!imageId}
                >
                  Reset Image Votes
                </Button>
              </Group>
            </Stack>
          </Form>
        </Card>

        {/* Last Vote Result */}
        {lastVoteResult && (
          <Card withBorder>
            <Stack gap="md">
              <Group justify="space-between">
                <Title order={3}>Last Vote Result</Title>
                {lastVoteResult.consensus?.reached ? (
                  <Badge color="green" size="lg" leftSection={<IconCheck size={16} />}>
                    Consensus Reached
                  </Badge>
                ) : (
                  <Badge color="blue" size="lg">
                    No Consensus Yet
                  </Badge>
                )}
              </Group>

              <Grid>
                <Grid.Col span={{ base: 12, md: 6 }}>
                  <Paper p="md" withBorder>
                    <Stack gap="xs">
                      <Group justify="space-between">
                        <Text size="sm" fw={500} c="dimmed">
                          Vote Details
                        </Text>
                        {lastVoteResult.vote.customWeightUsed && (
                          <Badge color="yellow" size="sm">
                            Custom Weight
                          </Badge>
                        )}
                      </Group>
                      <Text>
                        <strong>Voter:</strong> User {lastVoteResult.vote.votingUserId} (
                        {lastVoteResult.vote.votingUserRank})
                      </Text>
                      <Text>
                        <strong>Level:</strong> {lastVoteResult.vote.votingUserLevel}
                      </Text>
                      <Text>
                        <strong>Smites:</strong> {lastVoteResult.vote.votingUserSmites ?? 0}
                      </Text>
                      <Text>
                        <strong>Vote Weight:</strong> {lastVoteResult.vote.voteWeight.toFixed(2)}
                      </Text>
                      <Text>
                        <strong>Rating:</strong> {lastVoteResult.vote.rating}
                      </Text>
                    </Stack>
                  </Paper>
                </Grid.Col>

                <Grid.Col span={{ base: 12, md: 6 }}>
                  <Paper p="md" withBorder>
                    <Stack gap="xs">
                      <Text size="sm" fw={500} c="dimmed">
                        Queue Status
                      </Text>
                      <Text>
                        <strong>Queue Type:</strong> {lastVoteResult.queue.queueType}
                      </Text>
                      <Text>
                        <strong>Vote Count:</strong> {lastVoteResult.queue.voteCount} /{' '}
                        {lastVoteResult.queue.voteLimit}
                      </Text>
                      <Text>
                        <strong>Still in Queue:</strong>{' '}
                        {lastVoteResult.queue.stillInQueue ? 'Yes' : 'No'}
                      </Text>
                    </Stack>
                  </Paper>
                </Grid.Col>
              </Grid>

              {lastVoteResult.consensus && (
                <Paper p="md" withBorder>
                  <Stack gap="xs">
                    <Text size="sm" fw={500} c="dimmed">
                      Consensus Analysis
                    </Text>
                    {lastVoteResult.consensus.reached ? (
                      <>
                        <Text>
                          <strong>Final Rating:</strong> {lastVoteResult.consensus.finalRating}
                        </Text>
                        <Text>
                          <strong>Method:</strong> {lastVoteResult.consensus.method}
                        </Text>
                      </>
                    ) : (
                      <Text>
                        <strong>Current Leader:</strong> {lastVoteResult.consensus.currentLeader}
                      </Text>
                    )}
                    <Text>
                      <strong>Total Weighted Votes:</strong>{' '}
                      {lastVoteResult.consensus.totalWeightedVotes}
                    </Text>
                    <Text>
                      <strong>Votes Required:</strong> {lastVoteResult.consensus.votesRequired}
                    </Text>
                    <Text>
                      <strong>Threshold:</strong> {lastVoteResult.consensus.threshold}
                    </Text>
                    <Progress
                      value={
                        (lastVoteResult.consensus.totalWeightedVotes /
                          lastVoteResult.consensus.votesRequired) *
                        100
                      }
                      size="lg"
                      mt="xs"
                    />
                  </Stack>
                </Paper>
              )}

              {/* Vote Distribution */}
              {lastVoteResult.voteDistribution?.length > 0 && (
                <div>
                  <Text size="sm" fw={500} mb="xs">
                    Vote Distribution
                  </Text>
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Rank</Table.Th>
                        <Table.Th>Rating</Table.Th>
                        <Table.Th>Weighted Score</Table.Th>
                        <Table.Th>Approx. Votes</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {lastVoteResult.voteDistribution.map((dist: any, idx: number) => (
                        <Table.Tr key={idx}>
                          <Table.Td>{dist.rank}</Table.Td>
                          <Table.Td>
                            <Badge>{dist.rating}</Badge>
                          </Table.Td>
                          <Table.Td>{dist.weightedScore}</Table.Td>
                          <Table.Td>{dist.approximateVotes}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
            </Stack>
          </Card>
        )}

        {/* Vote Details Inspection */}
        {imageId && (
          <Card withBorder>
            <Stack gap="md">
              <Group justify="space-between">
                <Title order={3}>Vote Details - Image {imageId}</Title>
                <Button
                  variant="light"
                  leftSection={<IconRefresh size={16} />}
                  onClick={() => {
                    queueState.refetch();
                    voteDetails.refetch();
                  }}
                >
                  Refresh
                </Button>
              </Group>

              {voteDetails.isLoading ? (
                <Loader />
              ) : voteDetails.error ? (
                <Alert color="red" icon={<IconX />}>
                  Error loading vote details: {voteDetails.error.message}
                </Alert>
              ) : voteDetails.data ? (
                <Stack gap="md">
                  {/* Image Info */}
                  <Paper p="md" withBorder>
                    <Text size="sm" fw={500} c="dimmed" mb="xs">
                      Image Information
                    </Text>
                    <Text>
                      <strong>Current NSFW Level:</strong>{' '}
                      <Badge>{voteDetails.data.image.currentNsfwLevel}</Badge>
                    </Text>
                    <Text size="xs" c="dimmed" mt="xs">
                      URL: {voteDetails.data.image.url}
                    </Text>
                  </Paper>

                  {/* Consensus Status */}
                  {voteDetails.data.consensus && (
                    <Paper p="md" withBorder>
                      <Stack gap="xs">
                        <Group justify="space-between">
                          <Text size="sm" fw={500} c="dimmed">
                            Consensus Status
                          </Text>
                          {voteDetails.data.consensus.hasConsensus ? (
                            <Badge color="green" leftSection={<IconCheck size={16} />}>
                              Consensus Reached
                            </Badge>
                          ) : (
                            <Badge color="blue">No Consensus</Badge>
                          )}
                        </Group>

                        {voteDetails.data.consensus.hasConsensus && (
                          <Text>
                            <strong>Winning Rating:</strong>{' '}
                            <Badge size="lg">{voteDetails.data.consensus.winningRating}</Badge>
                          </Text>
                        )}

                        <Text>
                          <strong>Winning Percentage:</strong>{' '}
                          {voteDetails.data.consensus.winningPercentage.toFixed(1)}%
                        </Text>
                        <Text>
                          <strong>Total Weighted Votes:</strong>{' '}
                          {voteDetails.data.consensus.totalWeightedVotes}
                        </Text>
                        <Text>
                          <strong>Current Votes:</strong> {voteDetails.data.consensus.currentVotes}{' '}
                          / {voteDetails.data.consensus.voteLimit}
                        </Text>
                        <Text>
                          <strong>Threshold:</strong> {voteDetails.data.consensus.threshold}
                        </Text>

                        <Progress
                          value={voteDetails.data.consensus.winningPercentage}
                          size="lg"
                          mt="xs"
                        />
                      </Stack>
                    </Paper>
                  )}

                  {/* Vote Distribution Table */}
                  {voteDetails.data.distribution?.length > 0 && (
                    <div>
                      <Text size="sm" fw={500} mb="xs">
                        Vote Distribution by Rating
                      </Text>
                      <Table striped highlightOnHover>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>Rank</Table.Th>
                            <Table.Th>Rating</Table.Th>
                            <Table.Th>Weighted Score</Table.Th>
                            <Table.Th>Approx. Votes</Table.Th>
                            <Table.Th>Percentage</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {voteDetails.data.distribution.map((dist: any, idx: number) => {
                            const percentage =
                              (voteDetails.data.consensus?.totalWeightedVotes ?? 0) > 0
                                ? (dist.weightedScore /
                                    (voteDetails.data.consensus?.totalWeightedVotes ?? 1)) *
                                  100
                                : 0;
                            return (
                              <Table.Tr key={idx}>
                                <Table.Td>{dist.rank}</Table.Td>
                                <Table.Td>
                                  <Badge>{dist.rating}</Badge>
                                </Table.Td>
                                <Table.Td>{dist.weightedScore}</Table.Td>
                                <Table.Td>{dist.approximateVotes}</Table.Td>
                                <Table.Td>{percentage.toFixed(1)}%</Table.Td>
                              </Table.Tr>
                            );
                          })}
                        </Table.Tbody>
                      </Table>
                    </div>
                  )}

                  {/* Individual Votes */}
                  {voteDetails.data.votes?.details?.length > 0 && (
                    <Accordion>
                      <Accordion.Item value="votes">
                        <Accordion.Control>
                          <Text fw={500}>Individual Votes ({voteDetails.data.votes.total})</Text>
                        </Accordion.Control>
                        <Accordion.Panel>
                          <Table striped>
                            <Table.Thead>
                              <Table.Tr>
                                <Table.Th>User ID</Table.Th>
                                <Table.Th>Rank</Table.Th>
                                <Table.Th>Rating</Table.Th>
                                <Table.Th>Status</Table.Th>
                                <Table.Th>Created At</Table.Th>
                              </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                              {voteDetails.data.votes.details.map((vote: any, idx: number) => (
                                <Table.Tr key={idx}>
                                  <Table.Td>{vote.userId}</Table.Td>
                                  <Table.Td>{vote.rank}</Table.Td>
                                  <Table.Td>
                                    <Badge>{vote.rating}</Badge>
                                  </Table.Td>
                                  <Table.Td>
                                    <Badge
                                      color={
                                        vote.status === 'Correct'
                                          ? 'green'
                                          : vote.status === 'Failed'
                                          ? 'red'
                                          : 'blue'
                                      }
                                    >
                                      {vote.status}
                                    </Badge>
                                  </Table.Td>
                                  <Table.Td>{new Date(vote.createdAt).toLocaleString()}</Table.Td>
                                </Table.Tr>
                              ))}
                            </Table.Tbody>
                          </Table>
                        </Accordion.Panel>
                      </Accordion.Item>
                    </Accordion>
                  )}
                </Stack>
              ) : null}
            </Stack>
          </Card>
        )}

        {/* Queue State */}
        {imageId && queueState.data && (
          <Card withBorder>
            <Stack gap="md">
              <Title order={3}>Queue State</Title>

              {queueState.isLoading ? (
                <Loader />
              ) : queueState.error ? (
                <Alert color="red" icon={<IconX />}>
                  Error loading queue state: {queueState.error.message}
                </Alert>
              ) : (
                <Stack gap="md">
                  <Paper p="md" withBorder>
                    <Text>
                      <strong>Total Images in Queue:</strong> {queueState.data.state.totalImages}
                    </Text>
                  </Paper>

                  {queueState.data.state.knight.length > 0 && (
                    <div>
                      <Text size="sm" fw={500} mb="xs">
                        Knight Queue
                      </Text>
                      <Table striped>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>Image ID</Table.Th>
                            <Table.Th>Vote Count</Table.Th>
                            <Table.Th>Priority</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {queueState.data.state.knight.map((item: any) => (
                            <Table.Tr key={item.imageId}>
                              <Table.Td>{item.imageId}</Table.Td>
                              <Table.Td>{item.voteCount}</Table.Td>
                              <Table.Td>
                                <Badge
                                  color={
                                    item.priority === 1
                                      ? 'red'
                                      : item.priority === 2
                                      ? 'orange'
                                      : 'blue'
                                  }
                                >
                                  {item.priority === 1
                                    ? 'High'
                                    : item.priority === 2
                                    ? 'Medium'
                                    : 'Default'}
                                </Badge>
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </div>
                  )}

                  {queueState.data.state.templar.length > 0 && (
                    <div>
                      <Text size="sm" fw={500} mb="xs">
                        Templar Queue
                      </Text>
                      <Table striped>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>Image ID</Table.Th>
                            <Table.Th>Vote Count</Table.Th>
                            <Table.Th>Priority</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {queueState.data.state.templar.map((item: any) => (
                            <Table.Tr key={item.imageId}>
                              <Table.Td>{item.imageId}</Table.Td>
                              <Table.Td>{item.voteCount}</Table.Td>
                              <Table.Td>
                                <Badge
                                  color={
                                    item.priority === 1
                                      ? 'red'
                                      : item.priority === 2
                                      ? 'orange'
                                      : 'blue'
                                  }
                                >
                                  {item.priority === 1
                                    ? 'High'
                                    : item.priority === 2
                                    ? 'Medium'
                                    : 'Default'}
                                </Badge>
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </div>
                  )}
                </Stack>
              )}
            </Stack>
          </Card>
        )}

        {/* Help Section */}
        <Card withBorder>
          <Stack gap="md">
            <Title order={3}>Testing Guide</Title>
            <Alert color="blue" icon={<IconAlertTriangle />}>
              This testing interface is only available in development/test environments.
            </Alert>

            <div>
              <Text fw={500} mb="xs">
                Quick Test Scenarios:
              </Text>
              <Stack gap="xs">
                <Code block>
                  {`1. Basic Consensus (60% threshold):
   - Vote with 3 users as PG13
   - Vote with 2 users as R
   - PG13 should win (3/5 = 60%)`}
                </Code>
                <Code block>
                  {`2. Elite Knight Override:
   - Vote with 1 level 80 user (weight 2.0) as X
   - Vote with 4 level 20 users (weight 1.0 each) as PG13
   - PG13 wins (400 vs 200 weighted score)`}
                </Code>
                <Code block>
                  {`3. Blocked Vote Detection:
   - Vote with 2 users as Blocked (with CSAM reason)
   - Image should be removed from queue immediately`}
                </Code>
              </Stack>
            </div>
          </Stack>
        </Card>
      </Stack>
    </Container>
  );
}
