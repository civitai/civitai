import { Box, Button, Container, Group, List, Stack, Text, Textarea, Title } from '@mantine/core';
import { useState } from 'react';
import { includesInappropriate } from '~/utils/metadata/audit';

export default function MetadataTester() {
  const [prompts, setPrompts] = useState<string[]>([]);
  const [results, setResults] = useState<{ passed: string[]; failed: string[] }>({
    passed: [],
    failed: [],
  });

  const updateJson = (json: string) => {
    try {
      if (json.trim().startsWith('[')) {
        const parsed = JSON.parse(json) as { prompt: string }[];
        setPrompts(parsed.map((p) => p.prompt));
      } else {
        setPrompts([json]);
      }
      updateResults();
    } catch (err) {
      console.log(err);
      setPrompts([]);
    }
  };

  const updateResults = () => {
    const passed = new Set<string>();
    const failed = new Set<string>();

    console.log(prompts);

    for (const prompt of prompts) {
      const isInappropriate = includesInappropriate(prompt);
      if (isInappropriate) {
        failed.add(prompt);
      } else {
        passed.add(prompt);
      }
    }
    setResults({ passed: [...passed], failed: [...failed] });
  };

  return (
    <Container size="md">
      <Stack>
        <Title>Prompt Tester</Title>
        <Textarea
          onChange={(e) => updateJson(e.target.value)}
          autosize
          minRows={5}
          placeholder={`Prompts JSON: {prompt: string}[]`}
        />
        <Button onClick={updateResults}>Update</Button>
        <Group grow>
          {Object.entries(results).map(([key, values]) => (
            <Box key={key} w="50%">
              <Text size="md" weight={500}>
                {key}
              </Text>
              <List>
                {values.map((value) => (
                  <List.Item key={value}>{value}</List.Item>
                ))}
              </List>
            </Box>
          ))}
        </Group>
      </Stack>
    </Container>
  );
}
