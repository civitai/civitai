export const loadVideo = (src: string) => {
  const video = document.createElement('video');
  video.onloadedmetadata = function () {
    console.log({ this: this });
  };
};

export {};
