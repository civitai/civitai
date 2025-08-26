import React from 'react';
import { Container, Title, Text, Stack, Paper, Grid, Card, Image, Button, Group, Alert } from '@mantine/core';
import { IconInfoCircle, IconKeyboard } from '@tabler/icons-react';
import { Meta } from '~/components/Meta/Meta';

export default function AdLayerDemo() {
  return (
    <>
      <Meta title="Ad Layer Demo - User-Managed Ads" description="Interactive demo of the user-managed ad system" />

      {/* Ad Layer Mockup is now rendered at the app root level and will automatically show on this page */}

      {/* Demo Content - Simulates a typical page */}
      <Container size="xl" py="xl">
        <Stack gap="xl">
          {/* Instructions */}
          <Alert icon={<IconInfoCircle />} color="blue" variant="light" radius="md">
            <Stack gap="xs">
              <Text fw={600}>Interactive Ad Layer Demo</Text>
              <Text size="sm">
                Click the blue button in the bottom-right corner to manage ads. Enable "Edit Mode" to drag and reposition ads anywhere on the page.
              </Text>
              <Group gap="xs">
                <IconKeyboard size={16} />
                <Text size="xs" color="dimmed">
                  Keyboard shortcuts: Ctrl/Cmd + E (toggle edit mode), Ctrl/Cmd + M (open manager), Ctrl/Cmd + Shift + L (toggle ad layer)
                </Text>
              </Group>
            </Stack>
          </Alert>

          {/* Page Header */}
          <div>
            <Title order={1}>User-Managed Ads Demo</Title>
            <Text size="lg" color="dimmed" mt="xs">
              Experience the future of web advertising - where users control ad placement
            </Text>
          </div>

          {/* Simulated Content Grid */}
          <Grid>
            {Array.from({ length: 12 }).map((_, index) => (
              <Grid.Col key={index} span={{ xs: 12, sm: 6, md: 4 }}>
                <Card shadow="sm" radius="md" withBorder>
                  <Card.Section>
                    <Image
                      src={`https://placehold.co/400x200/E3F2FD/1976D2?text=Content+${index + 1}`}
                      height={200}
                      alt={`Content ${index + 1}`}
                    />
                  </Card.Section>
                  <Stack gap="xs" mt="md">
                    <Text fw={500}>Sample Content Item {index + 1}</Text>
                    <Text size="sm" color="dimmed">
                      This is sample content to demonstrate how ads overlay on top of regular page content.
                    </Text>
                    <Button variant="light" fullWidth>
                      View Details
                    </Button>
                  </Stack>
                </Card>
              </Grid.Col>
            ))}
          </Grid>

          {/* Features List */}
          <Paper shadow="xs" p="lg" radius="md" withBorder>
            <Title order={2} mb="md">Key Features</Title>
            <Stack gap="sm">
              <Text>✅ Drag ads anywhere on the page</Text>
              <Text>✅ Edge-based positioning (maintains distance from nearest edge on resize)</Text>
              <Text>✅ Minimize/expand individual ads</Text>
              <Text>✅ Add up to 5 ad blocks (minimum 2 for free users)</Text>
              <Text>✅ Positions saved to localStorage</Text>
              <Text>✅ Grid snapping for clean alignment (10px grid)</Text>
              <Text>✅ Reset to default layout anytime</Text>
              <Text>✅ Dark mode support</Text>
              <Text>✅ Mobile responsive (fixed positions on small screens)</Text>
              <Text>✅ Site-wide availability (Ctrl/Cmd + Shift + L to toggle)</Text>
            </Stack>
          </Paper>

          {/* Technical Details */}
          <Paper shadow="xs" p="lg" radius="md" withBorder>
            <Title order={2} mb="md">Technical Implementation</Title>
            <Stack gap="sm">
              <Text>
                <strong>React Draggable:</strong> Powers the drag and drop functionality
              </Text>
              <Text>
                <strong>Edge-Based Positioning:</strong> Ads anchor to nearest edges for responsive behavior
              </Text>
              <Text>
                <strong>Zustand + Persist:</strong> State management with localStorage persistence
              </Text>
              <Text>
                <strong>Full Viewport Coverage:</strong> Fixed layer using 100vw/100vh, no scrolling
              </Text>
              <Text>
                <strong>Root-Level Rendering:</strong> Ad layer renders at app root for proper z-index stacking
              </Text>
            </Stack>
          </Paper>

          {/* Benefits */}
          <Paper shadow="xs" p="lg" radius="md" withBorder bg="blue.0">
            <Title order={2} mb="md">Why User-Managed Ads?</Title>
            <Grid>
              <Grid.Col span={{ xs: 12, md: 6 }}>
                <Stack gap="sm">
                  <Text fw={600}>For Users:</Text>
                  <Text size="sm">• Control where ads appear</Text>
                  <Text size="sm">• Less intrusive browsing</Text>
                  <Text size="sm">• Personalized layout</Text>
                  <Text size="sm">• Minimize ads when not needed</Text>
                </Stack>
              </Grid.Col>
              <Grid.Col span={{ xs: 12, md: 6 }}>
                <Stack gap="sm">
                  <Text fw={600}>For Publishers:</Text>
                  <Text size="sm">• 100% viewability rate</Text>
                  <Text size="sm">• Higher CPMs (2-3x)</Text>
                  <Text size="sm">• Better user satisfaction</Text>
                  <Text size="sm">• Unique value proposition</Text>
                </Stack>
              </Grid.Col>
            </Grid>
          </Paper>

          {/* Usage Guide */}
          <Paper shadow="xs" p="lg" radius="md" withBorder>
            <Title order={2} mb="md">How to Enable Ad Layer</Title>
            <Stack gap="sm">
              <Text>
                <strong>Option 1:</strong> Press <code>Ctrl/Cmd + Shift + L</code> on any page
              </Text>
              <Text>
                <strong>Option 2:</strong> Add <code>?adLayerMockup=true</code> to any URL
              </Text>
              <Text>
                <strong>Option 3:</strong> Visit this demo page at <code>/demo/ad-layer</code>
              </Text>
              <Text color="dimmed" size="sm">
                Once enabled, the ad layer persists across page navigation until disabled.
              </Text>
            </Stack>
          </Paper>
        </Stack>
      </Container>
    </>
  );
}
