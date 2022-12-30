import { Stack, Text, List, Title } from '@mantine/core';
import { ContextModalProps } from '@mantine/modals';

export default function QuestionInfoModal({ context, id }: ContextModalProps) {
  return (
    <Stack>
      <Title order={3}>What is this?</Title>
      <Text>
        {`It's a question and answer platform where users can ask and answer questions on a wide range
        of topics. Think Quora or stackoverflow but for model creation and use! Here's how it works:`}
      </Text>

      <List type="ordered">
        <List.Item>
          A user creates an account on Civitai and poses a question on a particular topic.
        </List.Item>
        <List.Item>
          Other users who are interested in answering the question can do so by writing a response
          and submitting it.
        </List.Item>
        <List.Item>
          The responses are displayed to all users who visit the question page, and other users can
          upvote or downvote the responses based on their quality and relevance.
        </List.Item>
        <List.Item>
          Civitai ranks the responses based on the upvotes and downvotes, the most highly ranked
          responses are displayed at the top of the page.
        </List.Item>
        <List.Item>
          Users can also ask follow-up questions or make comments on the responses.
        </List.Item>
      </List>

      <Text>
        Overall, the goal of this page is to provide users with high-quality, accurate, and
        informative answers to their questions from a diverse community of fantastic users with
        years of cumulative knowledge in art, stable diffusion, and model creation.
      </Text>
    </Stack>
  );
}
