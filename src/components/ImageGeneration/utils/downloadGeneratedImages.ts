import pLimit from 'p-limit';
import type { BlobData } from '~/shared/orchestrator/workflow-data';
import { fetchBlob } from '~/utils/file-utils';
import { getJSZip } from '~/utils/lazy';

const limit = pLimit(10);

/** Zip the given outputs and trigger a single browser download. */
export async function downloadGeneratedImages(images: BlobData[]): Promise<void> {
  const zip = await getJSZip();

  await Promise.all(
    images.map((image, index) =>
      limit(async () => {
        if (!image.url) return;
        const blob = await fetchBlob(image.url);
        if (!blob) return;

        let name = image.id;
        const createdAt = image.workflow.createdAt;
        if (createdAt) {
          const dateString = createdAt.toISOString().replaceAll(':', '.').split('.');
          dateString.pop();
          name = `${dateString.join('.')}_${index + 1}`;
        }

        const file = new File([blob], name);
        const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        zip.file(`${name}.${ext}`, file);
      })
    )
  );

  const blob = await zip.generateAsync({ type: 'blob' });
  const ts = new Date().getTime();
  const blobFile = new File([blob], `images_${ts}.zip`, { type: 'application/zip' });

  const a = document.createElement('a');
  const href = URL.createObjectURL(blobFile);
  a.href = href;
  a.download = `images_${ts}.zip`;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(href);
}
