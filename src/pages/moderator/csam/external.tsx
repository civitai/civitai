import {
  Alert,
  Button,
  Card,
  Checkbox,
  Container,
  Divider,
  Group,
  Input,
  Radio,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconFolder, IconUpload } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import * as z from 'zod';

import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import {
  Form,
  InputCheckboxGroup,
  InputDateTimePicker,
  InputNumber,
  InputRadioGroup,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { csamContentsDictionary } from '~/server/schema/csam.schema';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

type Evidence = { bucketKey: string; filename: string };

// Free-form text fields (URLs) are entered one-per-line and split on submit.
const schema = z.object({
  userId: z.number({ message: 'User id is required' }),
  email: z.string().email(),
  screenName: z.string().optional(),
  reportedName: z.string().optional(),
  profileUrls: z.string().optional(),
  secondaryUserId: z.number().optional(),
  secondaryEmail: z.string().optional(),
  externalUrls: z.string().optional(),
  incidentDateTime: z.date().optional(),
  minorDepiction: z.enum(['real', 'non-real']).optional(),
  contents: z.array(z.string()).optional(),
  fileAnnotations: z.array(z.string()).optional(),
  chatPlatform: z.string().optional(),
  chatLogs: z.string().optional(),
  additionalInfo: z.string().optional(),
});

const fileAnnotationOptions = [
  { value: 'generativeAi', label: 'AI-generated (not a real photo)' },
  { value: 'infant', label: 'Depicts an infant' },
  { value: 'bestiality', label: 'Involves an animal' },
  { value: 'violenceGore', label: 'Graphic violence / gore' },
  { value: 'physicalHarm', label: 'Physical harm' },
];

const splitLines = (value?: string) => {
  const arr = (value ?? '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  return arr.length ? arr : undefined;
};

const annotationsToObject = (arr?: string[]) =>
  arr?.length ? arr.reduce((acc, key) => ({ ...acc, [key]: true }), {}) : undefined;

// Zips the selected folder in-browser and streams it to the secured CSAM bucket.
async function uploadFolder(files: File[], prefix: string): Promise<Evidence> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const file of files) {
    // Preserve the folder structure the moderator selected.
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    zip.file(path, file);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const filename = `${prefix}_${new Date().getTime()}.zip`;
  const res = await fetch(`/api/mod/csam-upload?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    body: blob,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? 'Upload failed');
  }
  return (await res.json()) as Evidence;
}

function FolderUpload({
  uploading,
  evidence,
  fileCount,
  emptyLabel,
  onFiles,
}: {
  uploading: boolean;
  evidence?: Evidence;
  fileCount: number;
  emptyLabel: string;
  onFiles: (files: File[]) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        type="file"
        multiple
        hidden
        ref={(node) => {
          ref.current = node;
          if (node) {
            node.setAttribute('webkitdirectory', '');
            node.setAttribute('directory', '');
          }
        }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          // Reset so re-selecting the same folder re-fires onChange.
          if (ref.current) ref.current.value = '';
        }}
      />
      <Group>
        <Button
          variant="default"
          leftSection={<IconFolder size={16} />}
          loading={uploading}
          onClick={() => ref.current?.click()}
        >
          Select folder
        </Button>
        {evidence ? (
          <Group gap={6}>
            <IconUpload size={16} />
            <Text size="sm">
              {fileCount} file(s) uploaded — {evidence.filename}
            </Text>
          </Group>
        ) : (
          <Text size="sm" c="dimmed">
            {emptyLabel}
          </Text>
        )}
      </Group>
    </>
  );
}

function ExternalCsamReportPage() {
  const features = useFeatureFlags();

  const [evidence, setEvidence] = useState<Evidence>();
  const [evidenceCount, setEvidenceCount] = useState(0);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);

  const [supplementalEvidence, setSupplementalEvidence] = useState<Evidence>();
  const [supplementalCount, setSupplementalCount] = useState(0);
  const [uploadingSupplemental, setUploadingSupplemental] = useState(false);

  const uploading = uploadingEvidence || uploadingSupplemental;

  const form = useForm({ schema, shouldUnregister: false });

  const { mutate, isPending: isLoading } = trpc.csam.createExternalReport.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'External CSAM report queued for NCMEC' });
      form.reset();
      setEvidence(undefined);
      setEvidenceCount(0);
      setSupplementalEvidence(undefined);
      setSupplementalCount(0);
    },
    onError: (error) => {
      showErrorNotification({ title: 'Failed to create report', error: new Error(error.message) });
    },
  });

  const handleEvidenceFiles = async (files: File[]) => {
    try {
      setUploadingEvidence(true);
      const result = await uploadFolder(files, 'csam');
      setEvidence(result);
      setEvidenceCount(files.length);
      showSuccessNotification({ message: `Uploaded ${files.length} CSAM file(s)` });
    } catch (err) {
      showErrorNotification({ title: 'Evidence upload failed', error: err as Error });
    } finally {
      setUploadingEvidence(false);
    }
  };

  const handleSupplementalFiles = async (files: File[]) => {
    try {
      setUploadingSupplemental(true);
      const result = await uploadFolder(files, 'chatlogs');
      setSupplementalEvidence(result);
      setSupplementalCount(files.length);
      showSuccessNotification({ message: `Uploaded ${files.length} chat-log file(s)` });
    } catch (err) {
      showErrorNotification({ title: 'Chat-log upload failed', error: err as Error });
    } finally {
      setUploadingSupplemental(false);
    }
  };

  const handleSubmit = (data: z.infer<typeof schema>) => {
    openConfirmModal({
      modalId: 'external-csam-confirm',
      centered: true,
      title: 'Confirm CSAM report',
      children: (
        <Text size="sm">
          This will queue a CyberTipline report to NCMEC for user <b>{data.userId}</b> ({data.email}
          ). Are you sure?
        </Text>
      ),
      labels: { cancel: 'Cancel', confirm: 'Yes, submit report' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        mutate({
          userId: data.userId,
          email: data.email,
          screenName: data.screenName || undefined,
          reportedName: data.reportedName || undefined,
          profileUrls: splitLines(data.profileUrls),
          secondaryUserId: data.secondaryUserId || undefined,
          secondaryEmail: data.secondaryEmail || undefined,
          externalUrls: splitLines(data.externalUrls),
          incidentDateTime: data.incidentDateTime,
          minorDepiction: data.minorDepiction,
          contents: data.contents?.length
            ? (data.contents as (keyof typeof csamContentsDictionary)[])
            : undefined,
          fileAnnotations: annotationsToObject(data.fileAnnotations),
          chatPlatform: data.chatPlatform || undefined,
          chatLogs: data.chatLogs || undefined,
          additionalInfo: data.additionalInfo || undefined,
          evidence,
          supplementalEvidence,
        }),
    });
  };

  if (!features.csamReports) return <NotFound />;

  return (
    <Container size="sm" py="md">
      <Stack>
        <div>
          <Title order={2}>External-Link CSAM Report</Title>
          <Text size="sm" c="dimmed">
            File a NCMEC report for CSAM hosted off-site. Upload the evidence a moderator downloaded
            and provide as much context as possible. Only user id and email are required.
          </Text>
        </div>

        <Form id="externalCsamForm" form={form} onSubmit={handleSubmit}>
          <Stack gap="lg">
            <Card withBorder>
              <Stack>
                <Text fw={600}>Reported user (required)</Text>
                <Group grow align="flex-start">
                  <InputNumber name="userId" label="Civitai user id" withAsterisk />
                  <InputText name="email" label="Email" withAsterisk />
                </Group>
              </Stack>
            </Card>

            <Card withBorder>
              <Stack>
                <Text fw={600}>Additional identity (optional)</Text>
                <Group grow align="flex-start">
                  <InputText name="screenName" label="Screen name / username" />
                  <InputText name="reportedName" label="Real name" />
                </Group>
                <InputTextArea
                  name="profileUrls"
                  label="Profile URLs"
                  description="One per line"
                  autosize
                  minRows={2}
                />
                <Divider label="Ban-evasion / secondary account" labelPosition="left" />
                <Group grow align="flex-start">
                  <InputNumber name="secondaryUserId" label="Secondary user id" />
                  <InputText name="secondaryEmail" label="Secondary email" />
                </Group>
              </Stack>
            </Card>

            <Card withBorder>
              <Stack>
                <Text fw={600}>Incident (optional)</Text>
                <InputTextArea
                  name="externalUrls"
                  label="External link(s) where the content was hosted"
                  description="One per line (e.g. the wormhole.app link)"
                  autosize
                  minRows={2}
                />
                <InputDateTimePicker
                  name="incidentDateTime"
                  label="Incident date/time"
                  description="Defaults to the report creation time if left blank"
                  clearable
                />
                <InputText
                  name="chatPlatform"
                  label="Chat platform"
                  description="Where the messages took place (e.g. Discord, Telegram)"
                />
                <InputTextArea
                  name="chatLogs"
                  label="Chat log transcript"
                  description="Paste any relevant chat log text"
                  autosize
                  minRows={3}
                />
              </Stack>
            </Card>

            <Card withBorder>
              <Stack>
                <Text fw={600}>Classification (optional)</Text>
                <InputRadioGroup name="minorDepiction" label="Minor depiction">
                  <Group>
                    <Radio value="real" label="Real" />
                    <Radio value="non-real" label="Non-real" />
                  </Group>
                </InputRadioGroup>
                <InputCheckboxGroup name="contents" label="The content in this report may involve:">
                  <Stack gap="xs">
                    {Object.entries(csamContentsDictionary).map(([key, value]) => (
                      <Checkbox key={key} value={key} label={value} />
                    ))}
                  </Stack>
                </InputCheckboxGroup>
                <InputCheckboxGroup name="fileAnnotations" label="File annotations (CSAM images)">
                  <Stack gap="xs">
                    {fileAnnotationOptions.map(({ value, label }) => (
                      <Checkbox key={value} value={value} label={label} />
                    ))}
                  </Stack>
                </InputCheckboxGroup>
                <InputTextArea
                  name="additionalInfo"
                  label="Additional notes"
                  autosize
                  minRows={2}
                />
              </Stack>
            </Card>

            <Card withBorder>
              <Stack>
                <Text fw={600}>Evidence (optional)</Text>
                <Text size="sm" c="dimmed">
                  Folders are zipped in your browser and uploaded to the secured CSAM storage — they
                  never touch the public CDN.
                </Text>

                <Input.Wrapper
                  label="CSAM images"
                  description="The downloaded abuse material. Reported to NCMEC as the basis of the report."
                >
                  <FolderUpload
                    uploading={uploadingEvidence}
                    evidence={evidence}
                    fileCount={evidenceCount}
                    emptyLabel="No CSAM images uploaded"
                    onFiles={handleEvidenceFiles}
                  />
                </Input.Wrapper>

                <Input.Wrapper
                  label="Chat-message screenshots"
                  description="Reported to NCMEC as supplemental (contextual) evidence, kept distinct from the abuse material."
                >
                  <FolderUpload
                    uploading={uploadingSupplemental}
                    evidence={supplementalEvidence}
                    fileCount={supplementalCount}
                    emptyLabel="No chat-log screenshots uploaded"
                    onFiles={handleSupplementalFiles}
                  />
                </Input.Wrapper>

                {!evidence && (
                  <Alert color="yellow">
                    No CSAM images uploaded. The report can still be sent with just the link and
                    context, but NCMEC strongly benefits from the actual files.
                  </Alert>
                )}
              </Stack>
            </Card>

            <Group justify="flex-end">
              <Button type="submit" color="red" loading={isLoading} disabled={uploading}>
                Submit report
              </Button>
            </Group>
          </Stack>
        </Form>
      </Stack>
    </Container>
  );
}

export default Page(ExternalCsamReportPage, { footer: null });
