import {
  Accordion,
  Box,
  Container,
  createStyles,
  Grid,
  Group,
  Stack,
  Table,
  Text,
  Title,
  TypographyStylesProvider,
} from '@mantine/core';
import { IconList } from '@tabler/icons-react';
import fs from 'fs';
import matter from 'gray-matter';
import { GetStaticProps, InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { TableOfContent } from '~/components/Article/Detail/TableOfContent';
import { containerQuery } from '~/utils/mantine-css-helpers';

const contentRoot = 'src/static-content/rules';
const files = ['minors', 'real-people'];
export const getStaticProps: GetStaticProps<{
  content: Record<string, string>;
}> = async () => {
  const content = files.reduce((acc, file) => {
    const fileName = fs.readFileSync(`${contentRoot}/${file}.md`, 'utf-8');
    const { content } = matter(fileName);
    acc[file] = content;
    return acc;
  }, {} as Record<string, string>);

  return {
    props: {
      content,
    },
  };
};

const headings = [
  { id: 'welcome', title: 'Welcome', level: 1 },
  {
    id: 'resource-dev',
    title: 'Responsible Resource Development',
    level: 1,
  },
  {
    id: 'content-policies',
    title: 'Content Policies',
    level: 1,
  },
  {
    id: 'generator',
    title: 'Using Civitai to Generate Images',
    level: 1,
  },
  {
    id: 'moderation',
    title: 'How We Moderate Content',
    level: 1,
  },
];

export default function Safety({ content }: InferGetServerSidePropsType<typeof getStaticProps>) {
  const { classes } = useStyles();

  return (
    <>
      <div className={classes.hero}>
        <Container size="md">
          <Stack align="center" spacing={0}>
            <Title className={classes.heroTitle}>Civitai Safety Center</Title>
            <Text ta="center" className={classes.heroText}>
              A summary of our policies, guidelines, and approach to keeping Civitai safe.
            </Text>
          </Stack>
        </Container>
      </div>
      <Container size="lg">
        <Grid gutter="lg">
          <Grid.Col xs={12} sm={4} className="hide-mobile">
            <Box pos="sticky" top={0}>
              <Group>
                <IconList size={20} />
                <Text weight={500}>Table of Contents</Text>
              </Group>
              <TableOfContent headings={headings} />
            </Box>
          </Grid.Col>
          <Grid.Col xs={12} sm={8}>
            <TypographyStylesProvider>
              <article className={classes.content}>
                <a id="welcome" />

                <p>
                  At Civitai, we recognize the transformative power of artificial intelligence and
                  are committed to harnessing this potential responsibly. As part of this
                  commitment, we have established clear guidelines to safeguard minors, respect real
                  individuals, and prevent the generation of harmful or illegal content.
                </p>
                <p>
                  Our platform is dedicated to fostering creativity and innovation while upholding
                  standards of safety and respect. We understand the importance of balancing the
                  freedom to create with the need to protect vulnerable groups and individuals.
                  Therefore, we have stringent policies against the creation of photorealistic
                  images of minors, depictions of extreme or illegal conduct, and any content that
                  may be deemed disturbing or offensive. We also prohibit the use of our resources
                  to generate the likeness of specific individuals for non-consensual or commercial
                  purposes.
                </p>
                <p>
                  At Civitai, we utilize AI systems along with the power of community to maintain a
                  safe and inclusive environment. We encourage you to be an active participant in
                  upholding our standards by accurately tagging content, reporting violations, and
                  providing feedback. Your involvement is crucial in shaping a safe AI community.
                  Together, we can navigate the exciting world of AI, ensuring that Civitai remains
                  a platform for innovation, creativity, and respect.
                </p>
                <Title order={2} id="resource-dev">
                  Responsible Resource Development
                </Title>
                <Title order={3}>Training</Title>
                <Title order={4}>Minors</Title>
                <ul>
                  <li>
                    Models intended for creating photorealistic depictions of minors are prohibited.
                  </li>
                  <li>
                    Take care not to include any photorealistic images of minors (under 18) in
                    training data.
                  </li>
                  <li>
                    Avoid all depictions of minors when training resources that are capable of
                    depicting nudity or sexual themes.
                  </li>
                </ul>
                <Title order={4}>Real People</Title>
                <ul>
                  <li>
                    Resources that are trained for the purpose of generating the likeness of a
                    specific individual must be non-commercial and non-sexual in nature, and may be
                    removed upon request from the person depicted.
                  </li>
                </ul>
                <Title order={4}>Extreme or Illegal Conduct</Title>
                <ul>
                  <li>
                    Do not create resources with the purpose of depicting extreme fetishes or
                    illegal conduct, such as rape, sexual abuse, scat or bestiality.
                  </li>
                  <li>
                    Do not create resources with a tendency to produce disturbing imagery, such as
                    graphic violence, gore, animal abuse, severe injuries or human death.
                  </li>
                </ul>
                <Title order={3}>Testing</Title>
                <p>
                  Prior to contributing a resource to Civitai, ensure that it does not have a
                  tendency to produce:
                </p>
                <ul>
                  <li>Photorealistic images of minors (under 18)</li>
                  <li>Minors in inappropriate clothing, poses, or themes</li>
                  <li>
                    Disturbing imagery, such as graphic violence, gore, animal abuse, severe
                    injuries or human death
                  </li>
                </ul>
                <Title order={2} id="content-policies">
                  Content Policies
                </Title>
                <p>
                  Civitai is committed to creating a safe, inclusive, and respectful environment for
                  everyone. We are dedicated to harnessing the potential of AI responsibly,
                  prioritizing the safety and wellbeing of minors and identifiable individuals.
                </p>
                <Title order={3}>Minors</Title>
                <ul>
                  <li>All photorealistic images of minors are prohibited.</li>
                  <li>
                    All sexual depictions of minors are prohibited, including anime genres such as
                    loli and shotacon
                  </li>
                </ul>
                <AdditionalContent content={content['minors']} />

                <Title order={3}>Real People</Title>
                <p>Any images that depict the likeness of an actual person must be:</p>
                <ul>
                  <li>
                    Non-commercial: including not soliciting donations or promoting a business.
                  </li>
                  <li>Consensual: content may be removed upon request.</li>
                  <li>Non-sexual or suggestive</li>
                </ul>
                <AdditionalContent content={content['real-people']} />
                <Title order={3}>Disturbing Imagery and Hate Speech</Title>
                <ul>
                  <li>
                    Do not post extremely disturbing images, such as graphic violence, gore, animal
                    abuse, severe injuries or human death
                  </li>
                  <li>
                    Do not post images that are disrespectful, demeaning or otherwise harmful
                    towards people or groups of people on the basis of their:
                    <ul>
                      <li>Religion or religious beliefs</li>
                      <li>Nationality, ethnicity, or race</li>
                      <li>Gender or sexual orientation</li>
                      <li>Disability or medical conditions</li>
                    </ul>
                  </li>
                </ul>
                <Title order={3}>Content Duplication and Impersonation</Title>
                <ul>
                  <li>Only post original images that you generated yourself.</li>
                  <li>
                    Do not falsely label images as having been created or endorsed by another
                    creator or otherwise impersonate another creator.
                  </li>
                </ul>
                <Title order={2} id="generator">
                  Using Civitai to Generate Images
                </Title>
                <p>
                  When using our onsite image generating services, all prompts and resulting images
                  must comply with our content policies.
                </p>
                <p>
                  This includes, but is not limited to, restrictions on mature content as it applies
                  to depictions of real individuals or minors, illegal or violent activities, and
                  disrespectful or offensive content.
                </p>
                <Title order={3}>Prohibited Image Generation Attempts</Title>
                <p>
                  Attempts to generate images that violate our content policies are strictly
                  prohibited.
                </p>
                <Title order={3}>Moderation and Enforcement</Title>
                <p>
                  Our moderation team actively monitors onsite image generation activities. Content
                  that violates our rules, or attempts to circumvent our content restrictions, will
                  result in appropriate actions, which may include content removal, flagging of the
                  account, suspension of access to the image generation feature, or a ban from the
                  platform.
                </p>
                <Title order={3}>Reporting and Accountability</Title>
                <p>
                  Users are encouraged to report any inappropriate image generation attempts or
                  results they come across. Reports can be submitted through our standard reporting
                  mechanism, and should include relevant information to assist in the investigation.
                </p>
                <p>
                  Users found to be repeatedly attempting to generate content that violates our
                  rules may face additional consequences, including potential suspension or
                  termination of their Civitai account.
                </p>
                <Title order={3}>Transparency and Appeals</Title>
                <p>
                  Decisions made by our moderation team concerning onsite image generation are
                  subject to the same transparency and appeal processes as other content on Civitai.
                </p>
                <p>
                  Users can request an explanation or appeal a moderation decision using our{' '}
                  <a href="/appeal" target="_blank">
                    Appeal Form
                  </a>
                  .
                </p>
                <Title order={2} id="moderation">
                  How We Moderate Content
                </Title>
                <p>
                  As a platform, our goal is to foster an environment of openness and inclusivity
                  while empowering users with tools to see content that is the most interesting and
                  relevant to them. We do this through a combination of user controls, automated
                  content labeling, and content moderation.
                </p>
                <Title order={3}>User Control</Title>
                <p>
                  We prioritize user control and offer options to customize the content you see on
                  our platform, including:
                </p>
                <ul>
                  <li>
                    <strong>Tag-Based Filtering:</strong> Users can hide specific content based on
                    tags. For instance, if a user {`doesn't`} want to view anime content, they can
                    hide the anime tag.
                  </li>
                  <li>
                    <strong>Selective Hiding:</strong> Users can choose to hide specific images,
                    models, or even all models created by a specific user.
                  </li>
                  <li>
                    <strong>Content Categories:</strong> Users can opt-into which categories of
                    moderated content they wish to view, such as enabling nudity, but not explicit
                    nudity. Furthermore, moderated content remains hidden until a user registers an
                    account and sets their personal content visibility preferences.
                  </li>
                </ul>
                <Title order={3}>Automated Content Labeling and Moderation</Title>
                <p>
                  We facilitate this high degree of user control through a combination of
                  checkpoints:
                </p>
                <ul>
                  <li>
                    <strong>Automated Content Labeling</strong>: We use Amazon Rekognition as well
                    as an open-source image tagging system to automatically apply content labels and
                    screen images for moderated content.
                  </li>
                  <li>
                    <strong>Community-Driven Moderation</strong>: Users can vote on the content
                    labels applied to images, helping us refine our image classification system. We
                    encourage users to report content violations and reward their efforts through a{' '}
                    {`Guardian's`} leaderboard that highlights the most helpful community members.
                  </li>
                  <li>
                    <strong>Manual Reviews</strong>: Certain combinations of tags or resources
                    trigger a manual review before the content becomes publicly visible.
                  </li>
                </ul>
                <Title order={3}>Community Participation</Title>
                <p>
                  We are committed to continuous improvement and maintaining a user-oriented and
                  safe platform. As part of our community, we encourage you to contribute to these
                  efforts by accurately tagging the models you create, participating in tagging{' '}
                  {`others'`} models where possible, and promptly reporting any content that
                  violates our policies.
                </p>
                <Title order={3}>Policy Feedback and Suggestions</Title>
                <p>
                  We value your input. After all, this community is like a potluck – everyone brings
                  something to the table. If you have suggestions for improving the guidelines or
                  have spotted something we might have missed, please let us know by submitting
                  feedback or reaching out to us on Discord.
                </p>
                <p>
                  Remember, these guidelines are here to make sure that Civitai remains an
                  innovative, respectful, and constructive community. With your cooperation and
                  input, we can continue to make this community a shining example of how AI can be
                  harnessed responsibly and creatively.
                </p>
                <Title order={3}>Appeals Process</Title>
                <p>
                  If you believe your content has been removed unfairly, you can submit an appeal
                  for further review through our{' '}
                  <a href="/appeal" target="_blank">
                    Appeal Form
                  </a>
                  .
                </p>
                <Title order={3}>Reporting Violations</Title>
                <p>
                  If you find content that {`doesn't`} adhere to our guidelines, especially
                  concerning minors, please {`don't`} hesitate to report it. A {`"Report"`} button
                  is available on most images and models throughout the site.
                </p>
                <p>
                  If you need additional help, you can always reach out to our moderators on our
                  Discord server. Your vigilance helps us maintain a safe and respectful community.
                </p>
                <p>
                  Together we can better navigate the development of new AI content while upholding
                  the openness and inclusivity of this platform and community.
                </p>
              </article>
            </TypographyStylesProvider>
          </Grid.Col>
        </Grid>
      </Container>
    </>
  );
}

function AdditionalContent({ content }: { content: string }) {
  return (
    <Accordion
      variant="contained"
      styles={(theme) => ({
        item: {
          marginBottom: theme.spacing.xl,
        },
        control: {
          padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
        },
      })}
    >
      <Accordion.Item value="additional-content">
        <Accordion.Control>
          <Text weight={500}>View the full policy</Text>
        </Accordion.Control>
        <Accordion.Panel>
          <ReactMarkdown
            rehypePlugins={[rehypeRaw, remarkGfm]}
            className="markdown-content"
            components={{
              a: ({ node, ...props }) => {
                return (
                  <Link href={props.href as string}>
                    <a target={props.href?.includes('http') ? '_blank' : '_self'}>
                      {props.children?.[0]}
                    </a>
                  </Link>
                );
              },
              table: ({ node, ...props }) => {
                return (
                  <Table {...props} striped withBorder withColumnBorders>
                    {props.children}
                  </Table>
                );
              },
            }}
          >
            {content}
          </ReactMarkdown>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

const useStyles = createStyles((theme) => ({
  hero: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    marginTop: -theme.spacing.md,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
    marginBottom: theme.spacing.xl * 2,
    padding: `${theme.spacing.xl}px 0 ${theme.spacing.xl * 2}px`,
    containerType: 'inline-size',
    [containerQuery.largerThan('md')]: {
      padding: `${theme.spacing.xl}px 0 ${theme.spacing.xl * 3}px`,
    },
  },
  heroTitle: {
    fontSize: '2rem',
    fontWeight: 500,
    [containerQuery.largerThan('md')]: {
      fontSize: '4rem',
    },
  },
  heroText: {
    fontSize: theme.fontSizes.md,
    [containerQuery.largerThan('md')]: {
      fontSize: theme.fontSizes.lg,
    },
  },
  inlineSection: {
    border: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
    }`,
  },
  learnMoreButton: {
    color: theme.colorScheme === 'dark' ? theme.colors.blue[4] : theme.colors.blue[7],
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  content: {
    h2: {
      paddingBottom: theme.spacing.xs,
      marginTop: theme.spacing.xl * 2,
      borderBottom: `1px solid ${
        theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
      }`,
    },
    h3: {
      marginTop: theme.spacing.sm,
      marginBottom: 0,
    },
    h4: {
      marginTop: theme.spacing.sm,
      marginBottom: 0,
    },
    'h2+h3, h3+h4, h3+ul, h4+ul': {
      marginTop: 0,
    },
    'ul+h3': {
      marginTop: theme.spacing.xl,
    },
    '.mantine-Accordion-content h3': {
      fontSize: theme.fontSizes.md,
    },
  },
}));
