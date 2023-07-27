const loadImage = async (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (...args) => reject(args);
    img.src = src;
  });

const getImageMetadata = (file: File) => {
  const objectUrl = URL.createObjectURL(file);
};

export const preprocessImage = (file: File) => {
  const objectUrl = URL.createObjectURL(file);
};
