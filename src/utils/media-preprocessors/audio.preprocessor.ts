import { AUDIO_SAMPLE_RATE } from '~/server/common/constants';
import { EXTENSION_BY_MIME_TYPE } from '~/server/common/mime-types';
import { AudioMetadata } from '~/server/schema/media.schema';

const getAudioPeaks = async (file: File) => {
  if (typeof window === 'undefined') return;

  // Set up audio context
  window.AudioContext = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContext();

  const buffer = await new Response(file)
    .arrayBuffer()
    .then((buffer) => audioContext.decodeAudioData(buffer));

  return normalizeData(filterData(buffer));
};

const filterData = (audioBuffer: AudioBuffer) => {
  const rawData = audioBuffer.getChannelData(0); // We only need to work with one channel of data
  const samples = AUDIO_SAMPLE_RATE; // Number of samples we want to have in our final data set
  const blockSize = Math.floor(rawData.length / samples); // the number of samples in each subdivision
  const filteredData = Array(samples);
  for (let i = 0; i < samples; i++) {
    const blockStart = blockSize * i; // the location of the first sample in the block
    let sum = 0;
    for (let j = 0; j < blockSize; j++) {
      sum = sum + Math.abs(rawData[blockStart + j]); // find the sum of all the samples in the block
    }
    filteredData[i] = sum / blockSize; // divide the sum by the block size to get the average
  }
  return filteredData;
};

const normalizeData = (filteredData: number[]) => {
  const multiplier = Math.pow(Math.max(...filteredData), -1);
  return filteredData.map((n) => n * multiplier);
};

async function getAudioData(src: string, file: File) {
  const peaks = await getAudioPeaks(file);

  return new Promise<AudioMetadata>((resolve) => {
    const audio = new Audio(src);
    audio.onloadedmetadata = () => {
      resolve({
        duration: Math.round(audio.duration * 1000) / 1000,
        peaks: peaks ? [peaks] : undefined,
        size: file.size,
        format: EXTENSION_BY_MIME_TYPE[file.type],
      });
    };
  });
}

export async function preprocessAudio(file: File) {
  const objectUrl = URL.createObjectURL(file);
  const metadata = await getAudioData(objectUrl, file);

  return {
    objectUrl,
    metadata,
  };
}
