import jsSHA from 'jssha';

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

  const chunkSize = 100 * 1024 * 1024; // 100MB
  const buffer = new Uint8Array(chunkSize);

  while (true) {
    const { done, value } = await reader.read(buffer);
    if (done) break;
    shaObj.update(value.buffer);
  }
  return shaObj.getHash('HEX');
};

export const getFilesHash = async (files: File[]) => {
  return await Promise.all(
    files.map(async (file) => {
      const hashFn = file.size < 1000 * 1024 * 1024 ? computeSHA256 : computeSHA256jsSHA;
      return await hashFn(file);
    })
  );
};
