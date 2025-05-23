import {
  Badge,
  Box,
  Button,
  Card,
  Container,
  Divider,
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
  cleanPrompt,
} from '~/utils/metadata/audit';
import { normalizeText } from '~/utils/normalize-text';

type AuditResult = {
  highlighted: string;
  replaced?: { prompt?: string; negativePrompt?: string };
  tags: string[];
};

type ToAudit = {
  prompt: string;
  negativePrompt?: string;
};

export default function MetadataTester() {
  const [prompts, setPrompts] = useState<ToAudit[]>([]);
  const [results, setResults] = useState<{ passed: AuditResult[]; failed: AuditResult[] }>({
    passed: [],
    failed: [],
  });

  const updateJson = (json: string) => {
    try {
      let setTo: ToAudit[] = [{ prompt: json }];
      if (json.trim().startsWith('[')) {
        const parsed = JSON.parse(json) as ToAudit[];
        setTo = parsed;
      }
      setPrompts(setTo);
      updateResults(setTo);
    } catch (err) {
      console.log(err);
      setPrompts([]);
    }
  };

  const updateResults = (input?: ToAudit[]) => {
    input ??= prompts;
    if (!input) return;
    const passed = new Set<AuditResult>();
    const failed = new Set<AuditResult>();

    for (let { prompt, negativePrompt } of input) {
      prompt = normalizeText(prompt);
      negativePrompt = normalizeText(negativePrompt);
      const isInappropriate = includesInappropriate({ prompt, negativePrompt }) !== false;
      const tags = getTagsFromPrompt(prompt) || [];
      const highlighted = highlightInappropriate({ prompt, negativePrompt }) ?? prompt;
      const replaced = cleanPrompt({ prompt, negativePrompt });
      if (isInappropriate) {
        failed.add({ highlighted, replaced, tags });
      } else {
        passed.add({ highlighted, replaced, tags });
      }
    }
    setResults({ passed: [...passed], failed: [...failed] });
  };

  return (
    <Container size="md">
      <Stack>
        <Group align="flex-end">
          <Title>Prompt Tester</Title>
          <Group gap={4} ml="auto">
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
          placeholder={`Prompts JSON: { prompt: string; negativePrompt?: string }[]`}
        />
        <Group grow align="flex-start">
          {Object.entries(results).map(([key, values]) => (
            <Box key={key} w="50%" px="xs">
              <Text size="lg" fw={500} tt="uppercase" mb="sm">
                {key}
              </Text>
              <Stack gap="xs">
                {values.map(({ highlighted, tags, replaced }) => (
                  <Card withBorder key={highlighted}>
                    <div dangerouslySetInnerHTML={{ __html: highlighted }} />
                    {replaced && (
                      <>
                        <Divider label="Cleaned" mt="xs" />
                        <Text>{replaced.prompt}</Text>
                        {replaced.negativePrompt && (
                          <Text c="dimmed">{replaced.negativePrompt}</Text>
                        )}
                      </>
                    )}
                    <div></div>
                    {tags.length > 0 && (
                      <Group gap={4} mt="sm">
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
