import React from 'react';
import { convert } from 'html-to-text';
import { Document, Page, Text, View, StyleSheet, Font } from '@react-pdf/renderer';
import { getDisplayName } from '~/utils/string-helpers';
import { formatDate } from '~/utils/date-helpers';
import { env } from '~/env/server.mjs';

Font.register({
  family: 'Montserrat',
  fonts: [
    {
      src: `${env.NEXT_PUBLIC_BASE_URL}/fonts/Montserrat-Regular.ttf`,
    },
    {
      src: `${env.NEXT_PUBLIC_BASE_URL}/fonts/Montserrat-Bold.ttf`,
      fontWeight: 'bold',
    },
  ],
});

Font.registerHyphenationCallback((word) => [word]);

// Create styles
const styles = StyleSheet.create({
  header: {
    fontSize: 24,
    marginBottom: 10,
    fontWeight: 'bold',
    paddingBottom: 4,
    borderBottom: '2px solid #cccccc',
  },
  list: {},
  listItem: {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 2,
    paddingTop: 2,
    borderBottom: '1px solid #cccccc',
  },
  page: {
    fontFamily: 'Montserrat',
    flexDirection: 'column',
    backgroundColor: '#E4E4E4',
    fontSize: 12,
  },
  section: {
    margin: 10,
    padding: 10,
    marginBottom: 5,
    fontFamily: 'Montserrat',
  },
});

// Create Document Component
export const ModelVersionDetailsPdfTemplate = ({ modelVersion }: { modelVersion: MixedObject }) => {
  const modelVersionSettings = (modelVersion.settings ?? {}) as MixedObject;
  const tableRows = [
    {
      header: 'Type',
      value: `${getDisplayName(modelVersion.model.type)} ${
        modelVersion.model.checkpointType ?? ''
      }`,
    },
    {
      header: 'Uploaded',
      value: formatDate(modelVersion.createdAt),
    },
    {
      header: 'Base Model',
      value: `${modelVersion.baseModel} ${
        modelVersion.baseModelType && modelVersion.baseModelType === 'Standard'
          ? ''
          : modelVersion.baseModelType ?? ''
      }`,
    },
    {
      header: 'Training',
      value: `${modelVersion.steps ? `${modelVersion.steps.toLocaleString()} steps` : ''}\n${
        modelVersion.epochs ? `${modelVersion.epochs.toLocaleString()} epochs` : ''
      }`,
      visible: !!modelVersion.steps || !!modelVersion.epochs,
    },
    {
      header: 'Usage Tips',
      value: `${
        modelVersion.clipSkip ? `Clip Skip: ${modelVersion.clipSkip.toLocaleString()}` : ''
      }\n${modelVersionSettings?.strength ? `Strength: ${modelVersionSettings.strength}` : ''}`,
      visible: !!modelVersion.clipSkip || !!modelVersionSettings?.strength,
    },
    {
      header: 'Trigger Words',
      value: modelVersion.trainedWords?.join(', ') ?? '',
      visible: !!modelVersion.trainedWords?.length,
    },
  ].filter((r) => r.visible === undefined || r.visible);

  const options = {
    wordwrap: 130,
    // ...
  };

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.section}>
          <Text style={styles.header}>
            {modelVersion.model.name} &ndash; {modelVersion.name}
          </Text>
        </View>
        <View style={styles.section}>
          <Text style={styles.header}>Details</Text>
          <View style={styles.list}>
            {tableRows.map((v) => (
              <View key={v.header} style={styles.listItem}>
                <Text style={{ maxWidth: '50%', fontWeight: 'bold' }}>{v.header}</Text>
                <Text style={{ maxWidth: '50%', textAlign: 'right' }}>{v.value}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={styles.section}>
          <Text style={styles.header}>Description</Text>
          <Text>
            {convert(
              modelVersion.description ?? modelVersion.model.description ?? '<p>N/A</p>',
              options
            )}
          </Text>
        </View>
      </Page>
    </Document>
  );
};
