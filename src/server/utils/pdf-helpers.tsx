import React from 'react';
import ReactPDF from '@react-pdf/renderer';
import { ModelVersionDetailsPdfTemplate } from '~/server/utils/react-templates/ModelVersionDetailsPdfTemplate';

export const getModelVersionDetailsPDF = async (modelVersion: MixedObject) => {
  const stream = await ReactPDF.renderToStream(
    <ModelVersionDetailsPdfTemplate modelVersion={modelVersion} />
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return new Blob([new Uint8Array(Buffer.concat(chunks))], { type: 'application/pdf' });
};
