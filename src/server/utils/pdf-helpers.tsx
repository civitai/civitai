import React from 'react';
import ReactPDF from '@react-pdf/renderer';
import streamToBlob from 'stream-to-blob';
import { ModelVersionDetailsPdfTemplate } from '~/server/utils/react-templates/ModelVersionDetailsPdfTemplate';

export const getModelVersionDetailsPDF = async (modelVersion: MixedObject) => {
  console.log(ReactPDF, ReactPDF.renderToBuffer);
  const stream = await ReactPDF.renderToStream(
    <ModelVersionDetailsPdfTemplate modelVersion={modelVersion} />
  );
  // stream.then

  return streamToBlob(stream, 'application/pdf');
};
