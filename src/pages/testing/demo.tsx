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

type AuditResult = {
  highlighted: string;
  tags: string[];
};

export default function Demo() {
  return (
    <Container size="md">
      <img src="/api/image/model/1" />
    </Container>
  );
}
