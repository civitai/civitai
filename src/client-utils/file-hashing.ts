import jsSHA from 'jssha';

const SIZE_100_MB = 100 * 1024 * 1024; // 100MB
const SIZE_1_GB = 1000 * 1024 * 1024; // 1 GB

const computeSHA256 = async (file: File) => {
  // Read the file as an ArrayBuffer
  const fileBuffer = await file.arrayBuffer();

  // Compute the hash
  const hashArrayBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);

  // Convert hash to hexadecimal
  const hashArray = Array.from(new Uint8Array(hashArrayBuffer));
  const hashHex = hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');

  return hashHex;
};

const computeSHA256jsSHA = async (file: File) => {
  const reader = file.stream().getReader({ mode: 'byob' });
  const shaObj = new jsSHA('SHA-256', 'ARRAYBUFFER');

  const buffer = new Uint8Array(SIZE_100_MB);

  while (true) {
    const { done, value } = await reader.read(buffer);
    if (done) break;
    shaObj.update(value.buffer);
  }
  return shaObj.getHash('HEX');
};

export const getFilesHash = (files: File[]) => {
  return Promise.all(
    files.map((file) => {
      const hashFn = file.size < SIZE_1_GB ? computeSHA256 : computeSHA256jsSHA;
      return hashFn(file);
    })
  );
};
