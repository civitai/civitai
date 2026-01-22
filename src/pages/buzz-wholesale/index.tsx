import {
  Accordion,
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Grid,
  Group,
  List,
  Paper,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconBolt,
  IconBuildingStore,
  IconCheck,
  IconChartLine,
  IconMoneybag,
  IconPercentage,
  IconShoppingCart,
  IconTrendingUp,
  IconUserPlus,
  IconUsers,
  IconWorld,
  IconCreditCardPay,
} from '@tabler/icons-react';
import { Meta } from '~/components/Meta/Meta';
import { wholesaleTiers, formatCurrency, formatDiscount } from '~/utils/buzz-wholesale/tiers';
import type { WholesaleTier } from '~/utils/buzz-wholesale/tiers';
import classes from './index.module.scss';
import clsx from 'clsx';

const sizing = {
  header: {
    title: 52,
    subtitle: 28,
  },
  sections: {
    title: 32,
    subtitle: 'xl',
  },
  icons: 48,
} as const;

const APPLICATION_FORM_URL = 'https://forms.clickup.com/8459928/f/825mr-15671/O2QCQLTXFXFNWAIH5U';

export default function BuzzWholesalePage() {
  return (
    <>
      <Meta
        title="Buzz Wholesale Program | Civitai"
        description="Partner with Civitai to offer Buzz gift cards to your customers. Access wholesale rates, marketing support, and exclusive benefits."
      />
      <Container size="xl">
        <Stack gap="xl" py="xl">
          <HeroSection />
          <HowItWorksSection />
          <TiersSection />
          <WhyPartnerSection />
          <RequirementsSection />
          <FAQSection />
          <CTASection />
        </Stack>
      </Container>
    </>
  );
}

const HeroSection = () => {
  return (
    <Stack gap="lg" className={classes.section}>
      <Title fz={sizing.header.title} className={classes.highlightColor} mb="sm">
        <Text component="span" fz={32} fw={700}>
          Join the
        </Text>
        <br />
        Civitai Buzz Wholesale Program
      </Title>

      <Text fz={sizing.header.subtitle} lh={1.3} mb="xs" maw={800}>
        Partner with Civitai to offer Buzz gift cards to your customers. Access competitive
        wholesale rates, marketing support, and exclusive benefits to grow your business.
      </Text>

      <Grid>
        <Grid.Col span={12}>
          <Paper withBorder className={clsx(classes.card, classes.highlightCard)} h="100%">
            <Stack>
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap="md">
                  <Title order={3} c="white">
                    Expand Your Product Offerings
                  </Title>
                  <Text c="white" size="lg">
                    Sell Buzz gift cards at wholesale rates with discounts up to 10%. Get featured
                    on Civitai&apos;s gift cards page and tap into a thriving community of millions
                    of users.
                  </Text>
                  <Button
                    component="a"
                    href={APPLICATION_FORM_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    size="lg"
                    variant="white"
                    leftSection={<IconUserPlus size={20} />}
                    mt="sm"
                  >
                    Apply Now
                  </Button>
                </Stack>
                <Group gap={0} wrap="nowrap" className={classes.boltGroup}>
                  <IconBolt style={{ fill: 'white' }} color="white" size={40} />
                  <IconBolt style={{ fill: 'white' }} color="white" size={64} />
                  <IconBolt style={{ fill: 'white' }} color="white" size={40} />
                </Group>
              </Group>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
    </Stack>
  );
};

const howItWorksSteps = [
  {
    icon: <IconUserPlus size={sizing.icons} />,
    title: 'Apply & Get Approved',
    description: 'Submit your application with business details and get reviewed by our team',
  },
  {
    icon: <IconPercentage size={sizing.icons} />,
    title: 'Choose Your Tier',
    description: 'Select a commitment level based on your expected volume and business goals',
  },
  {
    icon: <IconShoppingCart size={sizing.icons} />,
    title: 'Purchase & Distribute',
    description: 'Buy Buzz gift cards at wholesale rates and offer them to your customers',
  },
  {
    icon: <IconTrendingUp size={sizing.icons} />,
    title: 'Earn & Grow',
    description: 'Profit from resales and upgrade tiers for better rates and exclusive benefits',
  },
];

const HowItWorksSection = () => {
  return (
    <Stack className={classes.section}>
      <Stack gap={0} mb="sm">
        <Title size={sizing.sections.title} order={2} className={classes.highlightColor}>
          How It Works
        </Title>
        <Text size={sizing.sections.subtitle}>Simple steps to become a Buzz wholesale partner</Text>
      </Stack>
      <Grid>
        {howItWorksSteps.map((step, index) => (
          <Grid.Col span={{ base: 12, sm: 6, md: 3 }} key={index}>
            <Paper withBorder className={classes.card} h="100%">
              <Stack gap="md" align="center">
                <div className={classes.iconWrapper}>{step.icon}</div>
                <Text className={classes.highlightColor} size="xl" fw={700} ta="center">
                  {step.title}
                </Text>
                <Text c="dimmed" ta="center">
                  {step.description}
                </Text>
              </Stack>
            </Paper>
          </Grid.Col>
        ))}
      </Grid>
    </Stack>
  );
};

const TierCard = ({ tier }: { tier: WholesaleTier }) => {
  const isRecommended = tier.recommended;
  const isTopTier = tier.level === 1;
  const queryParams = tier.applicationQueryParams
    ? new URLSearchParams(tier.applicationQueryParams).toString()
    : '';
  const APPLICATION_FORM_URL_WITH_PARAMS = queryParams
    ? `${APPLICATION_FORM_URL}?${queryParams}`
    : APPLICATION_FORM_URL;

  return (
    <Card
      shadow="sm"
      padding="xl"
      radius="md"
      withBorder
      className={clsx(classes.tierCard, {
        [classes.recommendedTier]: isRecommended,
        [classes.topTier]: isTopTier,
      })}
    >
      <Stack gap="lg" h="100%">
        {/* Header */}
        <Stack gap="xs">
          <Group justify="space-between" wrap="nowrap">
            <Text size="xs" tt="uppercase" fw={700} c="dimmed">
              Tier {tier.level}
            </Text>
            {isRecommended && (
              <Badge variant="filled" color="blue" size="sm">
                Most Popular
              </Badge>
            )}
            {isTopTier && (
              <Badge variant="filled" color="yellow" size="sm">
                Exclusive
              </Badge>
            )}
          </Group>
          <Title order={2} className={classes.tierName}>
            {tier.name}
          </Title>
          <Text c="dimmed" size="sm">
            {tier.subtitle}
          </Text>
        </Stack>

        <Divider />

        {/* Pricing */}
        <Stack gap="xs">
          <Text size="sm" c="dimmed" fw={500}>
            Monthly Minimum
          </Text>
          <Title order={3} className={classes.tierPrice}>
            {formatCurrency(tier.monthlyMinimum)}
            <Text component="span" size="sm" c="dimmed" fw={400}>
              /month
            </Text>
          </Title>
          <Text size="sm" c="dimmed">
            Up to{' '}
            <Text component="span" fw={700} className={classes.highlightColor}>
              {formatDiscount(tier.maxDiscount)}
            </Text>{' '}
            discount
          </Text>
        </Stack>

        {/* Discount Scale */}
        <Stack gap="xs">
          <Text size="sm" fw={600}>
            Discount Scale
          </Text>
          <Table className={classes.discountTable}>
            <Table.Tbody>
              {tier.discountScale.map((scale, idx) => (
                <Table.Tr key={idx}>
                  <Table.Td className={classes.volumeCell}>{formatCurrency(scale.volume)}</Table.Td>
                  <Table.Td className={classes.discountCell}>
                    {formatDiscount(scale.discount)}
                    {scale.note && (
                      <Text component="span" size="xs" c="dimmed" ml={4}>
                        ({scale.note})
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>

        <Divider />

        {/* Features */}
        <Stack gap="md" style={{ flex: 1 }}>
          <Text size="sm" fw={600}>
            What&apos;s Included
          </Text>
          <List
            spacing="sm"
            size="sm"
            center
            icon={
              <ThemeIcon color="green" size={20} radius="xl" variant="light">
                <IconCheck size={14} />
              </ThemeIcon>
            }
          >
            {tier.features.map((feature, idx) => (
              <List.Item key={idx}>
                <Text size="sm">{feature}</Text>
              </List.Item>
            ))}
          </List>
        </Stack>

        {/* CTA */}
        <Button
          component="a"
          href={APPLICATION_FORM_URL_WITH_PARAMS}
          target="_blank"
          rel="noopener noreferrer"
          size="lg"
          variant={tier.ctaVariant}
          fullWidth
          mt="auto"
        >
          {tier.ctaText}
        </Button>
      </Stack>
    </Card>
  );
};

const TiersSection = () => {
  return (
    <Stack className={classes.section}>
      <Stack gap={0} mb="sm" align="center">
        <Title size={sizing.sections.title} order={2} className={classes.highlightColor}>
          Choose Your Partnership Tier
        </Title>
        <Text size={sizing.sections.subtitle} ta="center" maw={800}>
          Select the tier that matches your business volume and goals
        </Text>
      </Stack>
      <Grid gutter="lg">
        {wholesaleTiers.map((tier) => (
          <Grid.Col key={tier.id} span={{ base: 12, md: 4 }} data-tier-level={tier.level}>
            <TierCard tier={tier} />
          </Grid.Col>
        ))}
      </Grid>
    </Stack>
  );
};

const benefits = [
  {
    icon: <IconUsers size={sizing.icons} />,
    label: 'Active Community',
    value: 'Millions of Users',
    description: 'Access a thriving community of AI creators and enthusiasts',
  },
  {
    icon: <IconCreditCardPay size={sizing.icons} />,
    label: 'Growing Market',
    value: '20k+ sales/month',
    description: 'Current Buzz gift card sales through wholesale partners',
  },
  {
    icon: <IconWorld size={sizing.icons} />,
    label: 'Global Reach',
    value: 'Worldwide',
    description: 'Serve customers from around the globe',
  },
  {
    icon: <IconChartLine size={sizing.icons} />,
    label: 'Competitive Margins',
    value: 'Up to 10%',
    description: 'Earn healthy margins on every gift card sold',
  },
];

const WhyPartnerSection = () => {
  return (
    <Stack className={classes.section}>
      <Stack gap={0} mb="sm" align="center">
        <Title size={sizing.sections.title} order={2} className={classes.highlightColor}>
          Why Partner With Civitai?
        </Title>
        <Text size={sizing.sections.subtitle} ta="center" maw={800}>
          Join a rapidly growing platform with millions of engaged users
        </Text>
      </Stack>
      <Grid>
        {benefits.map((benefit, index) => (
          <Grid.Col key={index} span={{ base: 12, sm: 6, md: 3 }}>
            <Paper withBorder className={classes.card} h="100%">
              <Stack gap="md" align="center">
                <div className={classes.iconWrapper}>{benefit.icon}</div>
                <Stack gap={4} align="center">
                  <Text className={classes.highlightColor} size="xl" fw={700} ta="center">
                    {benefit.value}
                  </Text>
                  <Text size="sm" fw={600} ta="center">
                    {benefit.label}
                  </Text>
                  <Text size="sm" c="dimmed" ta="center">
                    {benefit.description}
                  </Text>
                </Stack>
              </Stack>
            </Paper>
          </Grid.Col>
        ))}
      </Grid>
    </Stack>
  );
};

const requirements = [
  'Valid business license or registration',
  'Tax ID or equivalent business identification',
  'Business bank account for payments',
  'Ability to meet monthly minimum commitments',
  'Agreement to Civitai wholesale terms of service',
  'Established online or physical retail presence',
];

const RequirementsSection = () => {
  return (
    <Stack className={classes.section}>
      <Stack gap={0} mb="sm">
        <Title size={sizing.sections.title} order={2} className={classes.highlightColor}>
          Application Requirements
        </Title>
        <Text size={sizing.sections.subtitle}>What you need to become a partner</Text>
      </Stack>
      <Paper withBorder className={classes.card}>
        <Grid>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Stack gap="md">
              <Group gap="md">
                <IconBuildingStore size={48} className={classes.highlightColor} />
                <Title order={3}>Business Eligibility</Title>
              </Group>
              <List
                spacing="md"
                size="md"
                icon={
                  <ThemeIcon color="blue" size={24} radius="xl" variant="light">
                    <IconCheck size={16} />
                  </ThemeIcon>
                }
              >
                {requirements.map((req, idx) => (
                  <List.Item key={idx}>{req}</List.Item>
                ))}
              </List>
            </Stack>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Stack gap="md" h="100%" justify="center">
              <Text c="dimmed" size="md">
                We review all applications carefully to ensure our partners can provide excellent
                service to Civitai customers. Higher tier partnerships may require additional
                verification and creditworthiness assessment.
              </Text>
              <Text c="dimmed" size="md">
                Application review typically takes 3-5 business days. Once approved, we&apos;ll work
                with you to set up your wholesale account and get you started.
              </Text>
              <Button
                component="a"
                href={APPLICATION_FORM_URL}
                target="_blank"
                rel="noopener noreferrer"
                size="lg"
                leftSection={<IconUserPlus size={20} />}
                w="fit-content"
              >
                Start Your Application
              </Button>
            </Stack>
          </Grid.Col>
        </Grid>
      </Paper>
    </Stack>
  );
};

const faqs = [
  {
    q: 'How are discounts applied?',
    a: 'Discounts are based on your monthly purchase volume and tier level. The discount percentage increases as your volume grows within your tier. Discounts are applied at the time of purchase.',
  },
  {
    q: "What happens if I don't meet my monthly minimum?",
    a: 'Partners are expected to meet their monthly minimum commitments. If you consistently fall short, we may need to move you to a lower tier or adjust your partnership terms. We understand business fluctuates, so we work with partners on a case-by-case basis.',
  },
  {
    q: 'Can I change tiers?',
    a: 'Yes! You can upgrade to a higher tier at any time if you meet the volume requirements. Downgrades can also be requested and will be reviewed on a case-by-case basis.',
  },
  {
    q: 'How quickly can I get approved?',
    a: 'Most applications are reviewed within 3-5 business days. Higher tier partnerships (Tier 1 and 2) may require additional verification and could take up to 2 weeks for full approval.',
  },
  {
    q: 'What payment methods do you accept?',
    a: 'We accept wire transfers, ACH payments, and major credit cards for wholesale purchases. Tier 1 Strategic Vendors may qualify for Net 30 payment terms after establishing a track record.',
  },
  {
    q: 'Do gift cards expire?',
    a: "Buzz gift cards do not expire. Once redeemed, the Buzz remains in the user's account indefinitely.",
  },
  {
    q: 'Can I get custom denominations?',
    a: 'Standard denominations are available to all partners. Custom denominations may be available for Tier 1 and Tier 2 partners based on volume and business needs.',
  },
  {
    q: 'How does listing on the gift cards page work?',
    a: 'Tier 3 partners are listed under "Other Vendors" dropdown. Tier 2 partners get primary listing in the featured vendor selector. Tier 1 Strategic Vendors become the default vendor, automatically selected when users visit the gift cards page.',
  },
  {
    q: 'Is there an onboarding process?',
    a: "Yes! Once approved, you'll receive access to our wholesale portal, marketing materials, and technical documentation. Tier 2 and Tier 1 partners receive personalized onboarding with a dedicated account manager.",
  },
  {
    q: 'Can I resell in my region/country?',
    a: 'Yes, you can resell Buzz gift cards globally. However, you are responsible for compliance with local laws and regulations regarding gift card sales in your jurisdiction.',
  },
];

const FAQSection = () => {
  return (
    <Stack className={classes.section}>
      <Stack>
        <Title order={2} className={classes.highlightColor} size={sizing.sections.title}>
          Frequently asked questions
        </Title>
        <Accordion variant="default" classNames={{ control: 'py-4' }}>
          {faqs.map((faq, index) => (
            <Accordion.Item key={index} value={`faq-${index}`}>
              <Accordion.Control>
                <Group gap={8}>
                  <Text size="lg" fw={700}>
                    {faq.q}
                  </Text>
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Text>{faq.a}</Text>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      </Stack>
    </Stack>
  );
};

const CTASection = () => {
  return (
    <Stack className={classes.section} align="center">
      <Paper withBorder className={clsx(classes.card, classes.ctaCard)} maw={800} w="100%">
        <Stack gap="xl" align="center" py="xl">
          <Stack gap="md" align="center">
            <Title order={2} ta="center" className={classes.highlightColor}>
              Ready to Become a Wholesale Partner?
            </Title>
            <Text size="lg" ta="center" c="dimmed" maw={600}>
              Join Civitai&apos;s wholesale program and start offering Buzz gift cards to your
              customers today.
            </Text>
          </Stack>
          <Button
            component="a"
            href={APPLICATION_FORM_URL}
            target="_blank"
            rel="noopener noreferrer"
            size="xl"
            leftSection={<IconUserPlus size={24} />}
          >
            Apply Now
          </Button>
          <Stack gap="xs" align="center">
            <Text size="sm" c="dimmed">
              Have questions?{' '}
              <Anchor href="mailto:wholesale@civitai.com" fw={500}>
                Contact our wholesale team
              </Anchor>
            </Text>
          </Stack>
        </Stack>
      </Paper>
    </Stack>
  );
};
