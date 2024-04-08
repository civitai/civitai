import {
  Badge,
  Box,
  Button,
  Card,
  Container,
  Group,
  List,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import {
  getTagsFromPrompt,
  highlightInappropriate,
  includesInappropriate,
} from '~/utils/metadata/audit';
import { normalizeText } from '~/utils/string-helpers';

type AuditResult = {
  highlighted: string;
  tags: string[];
};

export default function MetadataTester() {
  const [prompts, setPrompts] = useState<string[]>([]);
  const [results, setResults] = useState<{ passed: AuditResult[]; failed: AuditResult[] }>({
    passed: [],
    failed: [],
  });

  const updateJson = (json: string) => {
    try {
      let setTo = [json];
      if (json.trim().startsWith('[')) {
        const parsed = JSON.parse(json) as { prompt: string }[];
        setTo = parsed.map((p) => p.prompt);
      }
      setPrompts(setTo);
      updateResults(setTo);
    } catch (err) {
      console.log(err);
      setPrompts([]);
    }
  };

  const updateResults = (input?: string[]) => {
    input ??= prompts;
    if (!input) return;
    const passed = new Set<AuditResult>();
    const failed = new Set<AuditResult>();

    for (let prompt of input) {
      prompt = normalizeText(prompt);
      const isInappropriate = includesInappropriate(prompt) !== false;
      const tags = getTagsFromPrompt(prompt) || [];
      const highlighted = highlightInappropriate(prompt) ?? prompt;
      if (isInappropriate) {
        failed.add({ highlighted, tags });
      } else {
        passed.add({ highlighted, tags });
      }
    }
    setResults({ passed: [...passed], failed: [...failed] });
  };

  return (
    <Container size="md">
      <Stack>
        <Group align="flex-end">
          <Title>Prompt Tester</Title>
          <Group spacing={4} ml="auto">
            <Badge color="red" variant="light">
              Blocked Word
            </Badge>
            <Badge color="orange" variant="light">
              NSFW Word
            </Badge>
            <Badge color="blue" variant="light">
              Minor Word
            </Badge>
            <Badge color="teal" variant="light">
              POI Word
            </Badge>
          </Group>
        </Group>
        <Textarea
          onChange={(e) => updateJson(e.target.value)}
          autosize
          minRows={5}
          placeholder={`Prompts JSON: {prompt: string}[]`}
        />
        <Group grow align="flex-start">
          {Object.entries(results).map(([key, values]) => (
            <Box key={key} w="50%" px="xs">
              <Text size="lg" weight={500} tt="uppercase" mb="sm">
                {key}
              </Text>
              <Stack spacing="xs">
                {values.map(({ highlighted, tags }) => (
                  <Card withBorder key={highlighted}>
                    <div dangerouslySetInnerHTML={{ __html: highlighted }} />
                    {tags.length > 0 && (
                      <Group spacing={4} mt="sm">
                        {tags.map((tag) => (
                          <Badge size="xs" key={tag}>
                            {tag}
                          </Badge>
                        ))}
                      </Group>
                    )}
                  </Card>
                ))}
              </Stack>
            </Box>
          ))}
        </Group>
      </Stack>
    </Container>
  );
}
