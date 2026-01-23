import { env } from '~/env/server';
import { HttpCaller } from '~/server/http/httpCaller';
import { Ncmec } from '~/server/http/ncmec/ncmec.schema';
import { parseStringPromise, Builder } from 'xml2js';

// DOCUMENTATION
// https://report.cybertip.org/ispws/documentation

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
    return Ncmec.statusResponseSchema.parse(json);
  }

  async getSchema() {
    const response = await this.getRaw('/xsd');
    return await response.text();
  }

  async initializeReport(data: any) {
    const builder = new Builder({ renderOpts: { pretty: false } });
    const xmlInput = builder.buildObject(data);
    const response = await this.postRaw('/submit', {
      body: xmlInput,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    });
    const xmlResponse = await response.text();
    const json = await parseStringPromise(xmlResponse);
    if (!response.ok) {
      throw new Error(
        `Status: ${response.status}${response.statusText ? `\n${response.statusText}` : ''}`
      );
    }
    return Ncmec.reportResponseSchema.parse(json).reportResponse;
  }

  async uploadFile({
    reportId,
    file,
    fileName,
    fileDetails,
  }: {
    reportId: number;
    file: Blob;
    fileName?: string;
    fileDetails?: Ncmec.FileDetails;
  }) {
    const form = new FormData();
    form.append('id', String(reportId));
    form.append('file', file, fileName ?? fileDetails?.originalFileName ?? 'file');
    const uploadResponse = await this.postRaw('/upload', {
      body: form,
    });
    const uploadXmlResponse = await uploadResponse.text();
    const uploadResponseJson = await parseStringPromise(uploadXmlResponse);
    if (!uploadResponse.ok) {
      console.log('ncmec file upload failed'.toUpperCase());
      console.log({ xmlResponse: uploadXmlResponse });
      throw new Error('ncmec file upload failed');
    }
    const { fileId, hash } = Ncmec.uploadResponseSchema.parse(uploadResponseJson).reportResponse;

    if (fileDetails) {
      const filePayload = {
        fileDetails: {
          reportId,
          fileId,
          ...fileDetails,
        },
      };
      const builder = new Builder({ renderOpts: { pretty: false } });
      const xmlInput = builder.buildObject(filePayload);
      const response = await this.postRaw('/fileinfo', {
        body: xmlInput,
        headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      });
      if (!response.ok) {
        console.log('failed to upload ncmec fileinfo'.toUpperCase());
        console.log({ xmlResponse: await response.text() });
        throw new Error('failed to upload ncmec fileinfo');
      }
    }

    return { fileId, hash };
  }

  async finishReport(reportId: number) {
    const form = new FormData();
    form.append('id', String(reportId));
    const response = await this.postRaw('/finish', {
      body: form,
    });
    if (!response.ok) {
      console.log('failed to finish ncmec report'.toUpperCase());
      console.log({ xmlResponse: response.text() });
      throw new Error('failed to finish ncmec report');
    }
  }

  async retractReport(reportId: number) {
    const form = new FormData();
    form.append('id', String(reportId));
    const response = await this.postRaw('/retract', {
      body: form,
    });
    if (!response.ok) {
      console.log('failed to retract ncmec report'.toUpperCase());
      console.log({ xmlResponse: response.text() });
      throw new Error('failed to retract ncmec report');
    }
  }
}

export default NcmecCaller.getInstance;
