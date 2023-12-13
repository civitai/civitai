import { env } from '~/env/server.mjs';
import { HttpCaller } from '~/server/http/httpCaller';
import { Ncmec } from '~/server/http/ncmec/ncmec.schema';
import { parseStringPromise } from 'xml2js';

class NcmecCaller extends HttpCaller {
  private static instance: NcmecCaller;

  protected constructor(baseUrl: string, options?: { headers?: MixedObject }) {
    super(baseUrl, options);
  }

  static getInstance(): NcmecCaller {
    if (!env.NCMEC_URL) throw new Error('Missing NCMEC_URL env');
    if (!env.NCMEC_USERNAME) throw new Error('Missing NCMEC_USERNAME env');
    if (!env.NCMEC_PASSWORD) throw new Error('Missing NCMEC_PASSWORD env');

    if (!NcmecCaller.instance) {
      NcmecCaller.instance = new NcmecCaller(env.NCMEC_URL, {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${env.NCMEC_USERNAME}:${env.NCMEC_PASSWORD}`
          ).toString('base64')}`,
        },
      });
    }

    return NcmecCaller.instance;
  }

  async getStatus() {
    const response = await this.getRaw('/status');
    const xml = await response.text();
    const json = await parseStringPromise(xml);
  }

  async getSchema() {
    return this.get('/xsd');
  }

  async initializeReport(data: any) {
    const response = await this.postRaw('/submit', { body: JSON.stringify(data) }); // TODO - check if this needs to go as json or XML
    if (!response.ok) throw new Error('failed to initialize ncmec report');
    return (await response.json()) as Ncmec.ReportResponse; // TODO - check if this needs to be parsed as json or XML
  }

  async uploadFile({
    reportId,
    file,
    fileDetails,
  }: {
    reportId: number;
    file: Blob;
    fileDetails?: Ncmec.FileDetails;
  }) {
    const form = new FormData();
    form.append('id', String(reportId));
    form.append('file', file);

    const uploadResponse = await this.postRaw('/upload', { body: form });
    if (!uploadResponse.ok) throw new Error('ncmec file upload failed');
    // TODO - check if this needs to be parsed as json or XML
    const { fileId, hash } = (await uploadResponse.json()) as Ncmec.UploadResponse;

    if (fileDetails) {
      const filePayload = {
        fileDetails: {
          reportId,
          fileId,
          ...fileDetails,
        },
      };
      // TODO - check if this needs to go as json or XML
      const response = await this.postRaw('/fileinfo', { body: JSON.stringify(filePayload) });
      if (!response.ok) throw new Error('failed to upload ncmec fileinfo');
    }

    return { fileId, hash };
  }

  async finishReport(reportId: number) {
    const form = new FormData();
    form.append('id', String(reportId));
    await this.postRaw('/finish', { body: form });
  }

  async retractReport(reportId: number) {
    const form = new FormData();
    form.append('id', String(reportId));
    await this.postRaw('/retract', { body: form });
  }
}

export default NcmecCaller.getInstance();
