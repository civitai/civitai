import { Box, Button, CloseButton, Table, Text, useMantineTheme } from '@mantine/core';
import { useLocalStorage, useSessionStorage } from '@mantine/hooks';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import React, {
  FC,
  Key,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { TypeOf, ZodAny, ZodArray, ZodEffects, ZodObject, ZodString, ZodTypeAny, z } from 'zod';
import { StoreApi, create, createStore } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { Announcement } from '~/components/Announcements/Announcement';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { IsClient } from '~/components/IsClient/IsClient';
import OnboardingWizard from '~/components/Onboarding/OnboardingWizard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form } from '~/libs/form';
import { Watch } from '~/libs/form/components/Watch';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import createSlots from '~/libs/slots/create-slots';
import { getRandomInt } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import LoginModal from '~/components/Login/LoginModal';
import { GenerationSettingsPopover } from '~/components/Generation/GenerationSettings';

const array = new Array(100).fill(0).map(() => getRandomInt(100, 400));

const { Slots, Slot } = createSlots(['header', 'footer']);

function Header({
  children,
  withCloseButton = true,
}: {
  children: React.ReactNode;
  withCloseButton?: boolean;
}) {
  return (
    <Slot name="header">
      <div className="flex items-center justify-between bg-red-400 p-2 text-white">
        <div>{children}</div>
        {withCloseButton && <CloseButton />}
      </div>
    </Slot>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <Slot name="footer">
      <div className="bg-green-400 p-2 text-white">{children}</div>
    </Slot>
  );
}

function ComponentWithSlots({ children }: { children: React.ReactNode }) {
  return (
    <Slots context={{ test: true }}>
      {(slots) => (
        <div className="container flex flex-col">
          {slots.header}
          <div className="bg-orange-400 text-white">{children}</div>
          {slots.footer}
        </div>
      )}
    </Slots>
  );
}

function Content() {
  return (
    <>
      <Header>This is my header</Header>
      This is my content
      <Footer>This is my Footer</Footer>
    </>
  );
}

const someObject = new Promise((resolve) =>
  resolve({
    test: true,
    array: [1, 2, 3, 4],
  })
);

const imagesAsPostsInfiniteProps = {
  model: {
    id: 404154,
    name: 'WAI-ANI-NSFW-PONYXL',
    description:
      '<p>If you want to use more my checkpoint online generation, please visit here.</p><p><a target="_blank" rel="ugc" href="https://tensor.art/u/762555264535746522">https://tensor.art/u/762555264535746522</a></p><p></p><p></p><p><span style="color:rgb(193, 194, 197)">You can run WAI-ANI-NSFW-PONYXL and use its API on SinkIn: </span></p><p><a target="_blank" rel="ugc" href="https://sinkin.ai/m/2zgReX9"><span style="color:#228be6">https://sinkin.ai/m/2zgReX9</span></a></p><p></p><hr /><p></p><h1 id="v13-released.-cmfacnep9"><span style="color:rgb(250, 82, 82)">V13 released.</span></h1><p></p><ul><li><p><strong><span style="color:rgb(250, 176, 5)">Increased body stability and accuracy.</span></strong></p></li><li><p><strong><span style="color:rgb(250, 176, 5)">overall balance adjustment.</span></strong></p></li></ul><p></p><p></p><h2 id="recommended-setting-r5u9n37oi"><span style="color:rgb(64, 192, 87)">Recommended Setting</span></h2><h3 id="steps:-30-bu7l5x30p"><span style="color:rgb(250, 82, 82)">Steps: 30</span></h3><h3 id="cfg-scale:-7-zem07zth6"><span style="color:rgb(250, 82, 82)">CFG scale: 7</span></h3><h3 id="sampler:-euler-adpm++-2m-karras-xrujbbyi4"><span style="color:rgb(250, 82, 82)">Sampler: Euler a/DPM++ 2M Karras</span></h3><h3 id="adetailer-face_yolov8ns.pt-use-can-fix-eyes-wn0ycim8m"><strong><span style="color:rgb(250, 82, 82)">ADetailer face_yolov8n/s.pt use can fix eyes</span></strong></h3><p></p><h3 id="for-the-example-images-69t3wtvze"><strong><span style="color:rgb(250, 176, 5)">For the example images</span></strong></h3><p><span style="color:rgb(250, 176, 5)">I used 1024x1360,</span></p><p><span style="color:rgb(250, 176, 5)">generated directly without AD or hires fix.</span></p><p></p><p>Positive Prompt</p><p></p><pre><code>score_9, score_8_up, score_7_up,source_anime,</code></pre><p></p><p>Negative Prompt</p><p></p><pre><code>worst quality,bad quality,jpeg artifacts, source_cartoon, \n3d, (censor),monochrome,blurry, lowres,watermark,</code></pre><p></p><p></p><hr /><h1 id="v12-released.-j4wdn66w0"><span style="color:rgb(250, 82, 82)">V12 released.</span></h1><p></p><ul><li><p><span style="color:rgb(250, 176, 5)">Style adjustment, background adjustment, and increased stability.</span></p></li><li><p><span style="color:rgb(250, 176, 5)">Added more compositions.</span></p></li></ul><p></p><p></p><h2 id="recommended-setting-9jp468rkv"><span style="color:rgb(64, 192, 87)">Recommended Setting</span></h2><h3 id="steps:-30-hyqhw5knr"><span style="color:rgb(250, 82, 82)">Steps: 30</span></h3><h3 id="cfg-scale:-7-2aghkdeys"><span style="color:rgb(250, 82, 82)">CFG scale: 7</span></h3><h3 id="sampler:-euler-adpm++-2m-karras-6b8c7bvli"><span style="color:rgb(250, 82, 82)">Sampler: Euler a/DPM++ 2M Karras</span></h3><h3 id="adetailer-face_yolov8ns.pt-use-can-fix-eyes-4mvryja1z"><strong><span style="color:rgb(250, 82, 82)">ADetailer face_yolov8n/s.pt use can fix eyes</span></strong></h3><p></p><p>Positive Prompt</p><p></p><pre><code>score_9, score_8_up, score_7_up,source_anime,</code></pre><p></p><p>Negative Prompt</p><p></p><pre><code>score_6, score_5, score_4, source_cartoon, \n3d, (censor),monochrome,blurry, lowres,watermark,</code></pre><p></p><p></p><hr /><h1 id="v11-7vuxd5pog">v11</h1><h3 id="-54uzv3f7h"></h3><h3 id="weight-adjustment-balancing-the-art-style-od13pwcmf"><strong><span style="color:rgb(190, 75, 219)">Weight adjustment, balancing the art style</span></strong></h3><p></p><p><strong><span style="color:rgb(250, 176, 5)">All example images(Except the cover) are generated at 1024x1360, without using AD and hires fix.</span></strong></p><p></p><h2 id="recommended-setting-v3lof4u6n"><span style="color:rgb(64, 192, 87)">Recommended Setting</span></h2><p><strong><span style="color:rgb(250, 82, 82)">Steps: 30</span></strong></p><p><strong><span style="color:rgb(250, 82, 82)">CFG scale: 7</span></strong></p><p><strong><span style="color:rgb(250, 82, 82)">Sampler: Euler a/DPM++ 2M Karras</span></strong></p><p><strong><span style="color:rgb(250, 82, 82)">ADetailer face_yolov8n/s.pt use can fix eyes</span></strong></p><p></p><p>Positive Prompt</p><p></p><pre><code>score_9, score_8_up, score_7_up,source_anime,</code></pre><p></p><p>Negative Prompt</p><p></p><pre><code>worst quality,bad quality,jpeg artifacts, source_cartoon, \n3d, (censor),monochrome,blurry, lowres,watermark, </code></pre><hr /><p></p><p></p><h1 id="v10-cfwojuaie"><span style="color:rgb(250, 82, 82)">V10</span></h1><ul><li><p><span style="color:rgb(250, 176, 5)">Better Background</span></p></li><li><p><span style="color:rgb(250, 176, 5)">Clothes details up</span></p></li><li><p><span style="color:rgb(250, 176, 5)">Better mature female</span></p><p></p></li></ul><p></p><h2 id="recommended-setting-wpjrqqpp6"><span style="color:rgb(64, 192, 87)">Recommended Setting</span></h2><p><strong><span style="color:rgb(250, 82, 82)">Steps: 30</span></strong></p><p><strong><span style="color:rgb(250, 82, 82)">CFG scale: 7</span></strong></p><p><strong><span style="color:rgb(250, 82, 82)">Sampler: Euler a/DPM++ 2M Karras</span></strong></p><p><strong><span style="color:rgb(250, 82, 82)">ADetailer face_yolov8n/s.pt use can fix eyes</span></strong></p><p></p><p>Positive Prompt</p><p></p><pre><code>score_9, score_8_up, score_7_up,source_anime,</code></pre><p></p><p>Negative Prompt</p><p></p><pre><code>worst quality,bad quality,jpeg artifacts, source_cartoon, \n3d, (censor),monochrome,blurry, lowres,watermark, </code></pre><p></p><p>++++++++++++++++++++++++++++++++++++++++++++++++++++++++++</p><h2 id="v9-hyper12step-c9pctz8xr"><span style="color:rgb(64, 192, 87)">V9 Hyper12step</span></h2><h3 id="please-refer-to-the-instructions-on-the-right-side-of-v9-hyper12step-for-usage.-h8nozk5wi"><span style="color:rgb(250, 176, 5)">Please refer to the instructions on the right side of V9 Hyper12step for usage.</span></h3><h1 id="v9-released.-mow6l4ma5"><span style="color:rgb(250, 82, 82)">V9 released.</span></h1><h3 id="v8-greaterv9-vlc9q9uxg"><span style="color:rgb(250, 176, 5)">v8-&gt;v9</span></h3><ul><li><p>adjusted the facial data to make it more versatile, allowing for easier generation of faces across various ages.</p></li><li><p>added more NSFW materials.</p></li><li><p>attempted to reduce the generation of some unnecessary details.</p></li></ul><p></p><h2 id="-f33n3l9ko"></h2><h2 id="recommended-setting-2qk0kxe8m"><span style="color:rgb(64, 192, 87)">Recommended Setting</span></h2><p><strong><span style="color:rgb(250, 82, 82)">Steps: 30</span></strong></p><p><strong><span style="color:rgb(250, 82, 82)">CFG scale: 7</span></strong></p><p><strong><span style="color:rgb(250, 82, 82)">Sampler: Euler a/DPM++ 2M Karras</span></strong></p><p><strong><span style="color:rgb(250, 82, 82)">ADetailer face_yolov8n/s.pt use can fix eyes</span></strong></p><p></p><p>Positive Prompt</p><p></p><pre><code>score_9, score_8_up, score_7_up,source_anime,</code></pre><p></p><p>Negative Prompt</p><p></p><pre><code>worst quality,bad quality,jpeg artifacts, source_cartoon, \n3d, (censor),monochrome,blurry, lowres,watermark, </code></pre><p></p><p></p><p>__________________________________________________________________________________________________</p><p></p><p></p><p></p><h3 id="hyper12step-released.-1y9c6x3wb"><span style="color:rgb(250, 176, 5)">hyper12step released.</span></h3><p><span style="color:rgb(250, 176, 5)">about size</span></p><p><span style="color:rgb(250, 176, 5)">Various combinations from 768x768 to 1360x1360 can produce good images.</span></p><p><span style="color:rgb(64, 192, 87)">Recommended Setting</span></p><p><span style="color:rgb(250, 82, 82)">Steps: </span><span style="color:rgb(250, 176, 5)">12</span></p><p><span style="color:rgb(250, 82, 82)">CFG scale: </span><span style="color:rgb(250, 176, 5)">3.5</span></p><p><span style="color:rgb(250, 82, 82)">Sampler: Euler a</span></p><p><span style="color:rgb(250, 82, 82)">Not very necessary to use ADetailer correction</span></p><p></p><p>Positive Prompt</p><p></p><pre><code>score_9, score_8_up, score_7_up,source_anime,</code></pre><p></p><p>Negative Prompt</p><p></p><pre><code>score_6, score_5, score_4, source_cartoon, \n3d, (censor),monochrome,blurry, lowres,watermark,</code></pre><p></p><h3 id="ps.the-example-images-use-a-size-of-896x1192.-no-ad-no-hires.-fix-9g3uf0f9b"><strong><span style="color:rgb(250, 82, 82)">PS.The example images use a size of 896x1192. no AD no Hires. fix</span></strong></h3><p>__________________________________________________________________________________________________</p><h3 id="version-8-released.-4kn6cmgsm"><span style="color:rgb(250, 176, 5)">Version 8 released.</span></h3><p><span style="color:rgb(250, 176, 5)">v7-&gt;v8</span></p><ul><li><p><span style="color:rgb(250, 176, 5)">Added some training related to camera angles and backgrounds.</span></p></li><li><p><span style="color:rgb(250, 176, 5)">Added more NSFW materials for additional training.</span></p></li><li><p><span style="color:rgb(250, 176, 5)">Added some training for special effects.</span></p></li><li><p><span style="color:rgb(250, 176, 5)">Optimization of overall composition logic.</span></p></li><li><p><span style="color:rgb(250, 176, 5)">Fixed some minor issues.</span></p></li><li><p><span style="color:rgb(250, 176, 5)">better eyes and hands.</span></p></li></ul><p></p><h3 id="recommended-setting-451od4oes"><span style="color:rgb(230, 73, 128)">Recommended Setting</span></h3><h1 id="same-as-v7-3g3nmr555"><span style="color:rgb(250, 176, 5)">Same as v7</span></h1><p></p><p></p><p>__________________________________________________________________________________________________</p><p></p><h3 id="version-7-7kajutodd"><span style="color:rgb(121, 80, 242)">Version 7</span></h3><p><span style="color:rgb(121, 80, 242)">v6-&gt;v7</span></p><ul><li><p><span style="color:rgb(121, 80, 242)">Fixed the issue where images appeared entirely covered with snowflakes.</span></p></li><li><p><span style="color:rgb(121, 80, 242)">Revised the composition logic to be more suitable for general scenarios.</span></p></li><li><p><span style="color:rgb(121, 80, 242)">Added new assets for backgrounds, mature women, and clothing.</span></p></li><li><p><span style="color:rgb(121, 80, 242)">Ensured consistency with the previous model and further fixed the issue of blurry eyes in medium and long shots.</span></p></li><li><p><span style="color:rgb(121, 80, 242)">Fixed some minor issues.</span></p></li></ul><p></p><h1 id="v7-recommended-setting-xs3astsbu"><span style="color:rgb(64, 192, 87)">V7 Recommended Setting</span></h1><h3 id="steps:-30-0xeeah0y4"><span style="color:rgb(250, 82, 82)">Steps: 30</span></h3><h3 id="cfg-scale:-7-4aip1oh76"><span style="color:rgb(250, 82, 82)">CFG scale: 7</span></h3><h3 id="sampler:-euler-adpm++-2m-karras-gkz7pes2d"><span style="color:rgb(250, 82, 82)">Sampler: Euler a/DPM++ 2M Karras</span></h3><h3 id="adetailer-face_yolov8ns.pt-use-can-fix-eyes-6a86c6wab"><strong><span style="color:rgb(250, 82, 82)">ADetailer face_yolov8n/s.pt use can fix eyes</span></strong></h3><p></p><p>Positive Prompt</p><p></p><pre><code>score_9, score_8_up, score_7_up,source_anime,</code></pre><p></p><p>Negative Prompt</p><p></p><pre><code>score_6, score_5, score_4, source_cartoon, \n3d, (censor),monochrome,blurry, lowres,watermark,</code></pre><p></p><p></p><p></p><p></p><p></p><p></p><p></p><p>________________________________________________________________________________________________</p><p><span style="color:rgb(250, 82, 82)">Regarding the 8step model, it is a lightweight model that can generate images in as few as 8 steps. However, the quality and text comprehension will be relatively lower. If speed is not a major concern for you, it is recommended to continue using version 6.0.</span></p><p></p><h3 id="8-step-setting-1549rn52c"><span style="color:rgb(230, 73, 128)">8 STEP Setting</span></h3><p>Steps: 8-12</p><p>CFG scale: 3</p><p>Sampler: Euler a</p><p><strong>ADetailer face_yolov8n/s.pt use can fix eyes</strong></p><p>Positive Prompt and Negative Prompt same 6.0</p><p>__________________________________________________________________________________________________</p><h3 id="6.0-9gi67fx11"><span style="color:rgb(34, 139, 230)">6.0</span></h3><h3 id="v5-greaterv6-change-point-g5vseeeev"><span style="color:rgb(34, 139, 230)">v5-&gt;v6 Change point</span></h3><ul><li><p><span style="color:rgb(34, 139, 230)">Better Background</span></p></li><li><p><span style="color:rgb(34, 139, 230)">better eyes</span></p></li><li><p><span style="color:rgb(34, 139, 230)">fix vae</span></p></li></ul><p></p><h1 id="recommended-setting-13ypuxz2f"><span style="color:rgb(64, 192, 87)">Recommended Setting</span></h1><h3 id="steps:-30-rwbxee67t">Steps: 30</h3><h3 id="cfg-scale:-7-0qxvc0tob">CFG scale: 7</h3><h3 id="sampler:-euler-adpm++-2m-karras(better-eyes)-234a5x0pe">Sampler: Euler a/<span style="color:rgb(250, 82, 82)">DPM++ 2M Karras(better eyes)</span></h3><h3 id="adetailer-face_yolov8ns.pt-use-can-fix-eyes-dy3xtuw14"><strong>ADetailer face_yolov8n/s.pt use can fix eyes</strong></h3><p></p><p>Positive Prompt</p><p></p><pre><code>score_9, score_8_up, score_7_up,source_anime,BREAK</code></pre><p></p><p>Negative Prompt</p><p></p><pre><code>score_6, score_5, score_4, source_cartoon, \n3d, (censor),monochrome,blurry, lowres,watermark,</code></pre><p></p><p></p><h3 id="you-can-view-the-supported-art-styles-from-https:civitai.comarticles5715-esf4998q3"><span style="color:rgb(250, 82, 82)">You can view the Supported art styles from </span><a target="_blank" rel="ugc" href="https://civitai.com/articles/5715"><span style="color:rgb(34, 139, 230)">https://civitai.com/articles/5715</span></a></h3><h3 id="thank-you-deepdark_fantasy514-for-providing-the-test.-g80ck3mhv"><span style="color:rgb(250, 82, 82)">Thank you, DeepDark_Fantasy514, for providing the test.</span></h3><h3 id="-huw6exhif"></h3><p></p><p><span style="color:rgb(250, 176, 5)">v4-&gt;v5 Change point</span></p><ul><li><p><span style="color:rgb(250, 176, 5)">Better Background</span></p></li><li><p><span style="color:rgb(250, 176, 5)">Clothes details up</span></p></li><li><p><span style="color:rgb(250, 176, 5)">Add some mature female</span></p></li><li><p><span style="color:rgb(250, 176, 5)">Little better hands and eyes</span></p><p></p><p></p></li></ul><p>Recommended Setting</p><ul><li><p>Steps: 30</p></li><li><p>CFG scale: 7</p></li><li><p>Sampler: Euler a</p></li><li><p><strong>ADetailer face_yolov8n/s.pt use can fix eyes</strong></p></li></ul><p></p><p>Positive Prompt</p><pre><code>score_9, score_8_up, score_7_up,</code></pre><p>Negative Prompt (<strong>THX for <span style="color:rgb(193, 194, 197)">snipsnapsnipsnap recommend </span></strong>)</p><ul><li><p>Base:score_6, score_5, score_4, source_cartoon</p></li><li><p>Optional: source_furry, source_pony <strong><span style="color:rgb(250, 82, 82)">can bleaches skin</span></strong></p></li><li><p>else: 3d, (censor),monochrome,blurry, lowres,watermark,</p></li></ul><p>I often use it now</p><p>[score_6, score_5, score_4, source_cartoon,</p><p>3d, (censor),monochrome,blurry, lowres,watermark, ]</p>',
    poi: false,
    minor: false,
    nsfwLevel: 31,
    nsfw: false,
    type: 'Checkpoint',
    uploadType: 'Created',
    updatedAt: '2025-01-28T00:49:17.757Z',
    deletedAt: null,
    deletedBy: null,
    status: 'Published',
    checkpointType: 'Merge',
    allowNoCredit: true,
    allowCommercialUse: ['RentCivit', 'Image'],
    allowDerivatives: true,
    allowDifferentLicense: true,
    licenses: [],
    publishedAt: '2024-04-16T18:08:14.688Z',
    locked: false,
    meta: {
      imageNsfw: 'None',
    },
    earlyAccessDeadline: null,
    mode: null,
    availability: 'Public',
    lockedProperties: [],
    reportStats: null,
    user: {
      id: 31176,
      image: 'https://cdn.discordapp.com/embed/avatars/2.png',
      username: 'WAI0731',
      deletedAt: null,
      rank: {
        leaderboardRank: 1,
      },
      profilePicture: {
        id: 12602654,
        name: '未标题-1.jpg',
        url: '89402b8c-e932-4076-b38a-c8ecff677bf6',
        nsfwLevel: 1,
        hash: 'UJBWe~WB00t7ofWBWBof00j[~qayj[ofofWB',
        userId: 31176,
        ingestion: 'Scanned',
        type: 'image',
        width: 1181,
        height: 1181,
        metadata: {
          hash: 'UJBWe~WB00t7ofWBWBof00j[~qayj[ofofWB',
          size: 156583,
          width: 1181,
          height: 1181,
          userId: 31176,
          profilePicture: true,
        },
      },
      cosmetics: [
        {
          data: null,
          cosmetic: {
            id: 184,
            data: {
              variant: 'gradient',
              gradient: {
                to: '#E8590C',
                deg: 180,
                from: '#FD7E14',
              },
            },
            type: 'NamePlate',
            source: 'Trophy',
            name: 'Legendary Nameplate',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 357,
            data: {
              glow: true,
              cssFrame:
                'linear-gradient(45deg, #fa91c1 10%, #f4c38b 25%, #FFFFBA 40%, #BAFFC9 55%, #BAE1FF 70%, #F2BAFF 85%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Unicorn Rainbow Frame',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 358,
            data: {
              glow: true,
              cssFrame: 'radial-gradient(circle, #FFD700 15%, #FF8C00 50%, #FF6347 100%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Topical Sunrise Frame',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 358,
            data: {
              glow: true,
              cssFrame: 'radial-gradient(circle, #FFD700 15%, #FF8C00 50%, #FF6347 100%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Topical Sunrise Frame',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 359,
            data: {
              glow: true,
              cssFrame: 'linear-gradient(90deg, #1E90FF 0%, #fff6c7 50%, #00BFFF 100%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Skyline Dawn Frame',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 359,
            data: {
              glow: true,
              cssFrame: 'linear-gradient(90deg, #1E90FF 0%, #fff6c7 50%, #00BFFF 100%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Skyline Dawn Frame',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 359,
            data: {
              glow: true,
              cssFrame: 'linear-gradient(90deg, #1E90FF 0%, #fff6c7 50%, #00BFFF 100%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Skyline Dawn Frame',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 360,
            data: {
              glow: true,
              cssFrame: 'linear-gradient(90deg, #8A2BE2 0%, #F8DE7E 50%, #3CB371 100%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Spring Blossom Frame',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 362,
            data: {
              glow: true,
              cssFrame:
                'linear-gradient(45deg, #6AE8F7 10%, #3699db 25%, #3177c1 40%, #9556F3 57%, #831ab0 75%, #8b0597 86%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Berry Fun Frame',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 364,
            data: {
              glow: true,
              cssFrame:
                'linear-gradient(315deg, #00e0ff 0%, #007FFF 33%, #80039f 33%, #FF00FF 66%, #ffd600 66%, #ffa94d 85%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Synthwave Frame',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 365,
            data: {
              glow: true,
              cssFrame:
                'linear-gradient(45deg, #0D3B66 10%, #FF006E 25%, #8338EC 40%, #2BD9FE 55%, #FF48C4 70%, #FFBE0B 85%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Cosmic Skies Frame',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 365,
            data: {
              glow: true,
              cssFrame:
                'linear-gradient(45deg, #0D3B66 10%, #FF006E 25%, #8338EC 40%, #2BD9FE 55%, #FF48C4 70%, #FFBE0B 85%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Cosmic Skies Frame',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 365,
            data: {
              glow: true,
              cssFrame:
                'linear-gradient(45deg, #0D3B66 10%, #FF006E 25%, #8338EC 40%, #2BD9FE 55%, #FF48C4 70%, #FFBE0B 85%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Cosmic Skies Frame',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 460,
            data: {
              glow: true,
              cssFrame:
                'radial-gradient(ellipse, rgb(223, 0, 17) 5%, rgb(223, 0, 17) 10%, rgb(255, 77, 77) 11%, rgb(255, 77, 77) 15%, rgb(255, 255, 255) 16%, rgb(255, 255, 255) 34%, rgb(255, 77, 77) 35%, rgb(255, 77, 77) 39%, rgb(223, 0, 17) 40%, rgb(223, 0, 17) 45%, rgb(255, 255, 255) 46%, rgb(255, 255, 255) 65%, rgb(255, 77, 77) 66%, rgb(255, 77, 77) 70%, rgb(223, 0, 17) 71%, rgb(223, 0, 17) 75%, rgb(255, 255, 255) 76%, rgb(255, 255, 255) 95%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Mushroom Spots',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 461,
            data: {
              glow: true,
              cssFrame:
                'radial-gradient(circle, #006400 10%,#006400 20%, #228b22 30%, #90ee90 40%, #ffffff 45%, #006400 50%, #228b22 60%, #90ee90 70%,#ffffff 75%, #006400 80%, #228b22 90%, #90ee90 100%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Dinosaur Egg',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 500,
            data: {
              glow: true,
              cssFrame: 'linear-gradient(125deg, rgb(255, 0, 150) 5%, rgb(30, 0, 50) 95%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Neon Noir',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 501,
            data: {
              glow: true,
              cssFrame: 'linear-gradient(125deg, rgb(0, 255, 122) 5%, rgb(0, 50, 30) 95%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Digital Forest',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 502,
            data: {
              glow: true,
              cssFrame: 'linear-gradient(45deg, rgb(255, 255, 102) 5%, rgb(40, 20, 40) 95%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Cyber Gold',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 503,
            data: {
              glow: true,
              cssFrame: 'linear-gradient(45deg, #b658ff 0%, #5d3bff 44%, rgba(9, 2, 19, 0.95) 95%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Ultra Violet',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 583,
            data: {
              glow: true,
              cssFrame:
                'linear-gradient(225deg, #ff0000 0%, #000000 24%, #ff0000 51%, #000000 66%, #d4083f 93%, #db3b3b 100%);',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Vampire Kitty Aura',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 591,
            data: {
              glow: true,
              cssFrame:
                'linear-gradient(45deg, #f8f9fa 15%, #dae4eb 30%, #6b7b82 55%, #4a5e6a 70%, #f8f9fa 85%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Ghost Aura ',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 593,
            data: {
              glow: true,
              cssFrame:
                'linear-gradient(45deg, #386325 15%, #a3d76d 30%, #ffcc66 50%, #ff9966 70%, #bb2f08 85%)',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Changing Leaves',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 618,
            data: {
              glow: true,
              cssFrame: 'linear-gradient(45deg, #f76f00 5%, #d938b9 47%, #ffc800 95%);',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Marigold Mist',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 704,
            data: {
              url: 'f10de41f-af06-4f38-a4a1-06fb4f516187',
              offset: '25%',
            },
            type: 'ProfileDecoration',
            source: 'Purchase',
            name: 'Orange Confetti Avatar',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 721,
            data: {
              glow: true,
              cssFrame:
                'linear-gradient(45deg, #1c0033 10%, #00aaff 40%, #6a00cc 60%, #00eaff 90%); ',
            },
            type: 'ContentDecoration',
            source: 'Purchase',
            name: 'Spinal Surge',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 808,
            data: {
              url: '168a1f76-a2ca-4d84-b282-24927fb4d721',
              type: 'video',
            },
            type: 'ProfileBackground',
            source: 'Purchase',
            name: 'New Years 2025 Background',
          },
        },
        {
          data: null,
          cosmetic: {
            id: 809,
            data: {
              url: 'f3242d40-1c87-44b3-b422-a0a6f39c1911',
              animated: true,
            },
            type: 'Badge',
            source: 'Purchase',
            name: 'New Years 2025 Badge',
          },
        },
      ],
    },
    modelVersions: [
      {
        id: 1295881,
        modelId: 404154,
        name: 'v13.0',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: null,
        createdAt: '2025-01-17T18:26:05.574Z',
        updatedAt: '2025-01-17T19:21:38.419Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: null,
        status: 'Published',
        publishedAt: '2025-01-17T19:21:38.410Z',
        meta: {
          imageNsfw: 'None',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 31,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 1200214,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANIHENTAIPONYXL13.qfgJ.safetensors',
            sizeKB: 6775430.384765625,
            name: 'WAI-ANI-HENTAI-PONYXL-13.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2025-01-17T18:54:16.133Z',
            modelVersionId: 1295881,
            hashes: [
              {
                type: 'AutoV1',
                hash: '088BED18',
              },
              {
                type: 'AutoV2',
                hash: 'BFA96353B7',
              },
              {
                type: 'SHA256',
                hash: 'BFA96353B76FCC1971DBA1FA98E4D9DBAD9965220104E3913A61B4EDA8143E3F',
              },
              {
                type: 'CRC32',
                hash: 'AFDE3508',
              },
              {
                type: 'BLAKE3',
                hash: 'C0FC0322048053E5514DD93F241B099780798EBE9F3088539CF72C163FB9E6FF',
              },
              {
                type: 'AutoV3',
                hash: 'CEA21DFF3DF9',
              },
            ],
          },
        ],
        generationCoverage: {
          covered: true,
        },
        recommendedResources: [],
        rank: {
          generationCountAllTime: 1205984,
          downloadCountAllTime: 17315,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 2006,
          thumbsDownCountAllTime: 5,
        },
        posts: [
          {
            id: 11741341,
          },
        ],
        hashes: ['bfa96353b76fcc1971dba1fa98e4d9dbad9965220104e3913a61b4eda8143e3f'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: true,
      },
      {
        id: 1177000,
        modelId: 404154,
        name: 'v12',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-12-18T10:23:59.036Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: null,
        status: 'Published',
        publishedAt: '2024-12-18T11:28:49.051Z',
        meta: {
          imageNsfw: 'None',
        },
        vaeId: null,
        settings: null,
        requireAuth: true,
        nsfwLevel: 31,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 1082392,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL12.rIem.safetensors',
            sizeKB: 6775430.353515625,
            name: 'WAI-ANI-NSFW-PONYXL-12.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-12-18T11:08:10.427Z',
            modelVersionId: 1177000,
            hashes: [
              {
                type: 'AutoV1',
                hash: '84D3DC2B',
              },
              {
                type: 'AutoV2',
                hash: '019371B92F',
              },
              {
                type: 'SHA256',
                hash: '019371B92F95EDB5D4C834AB1AEBA52B2CC099E69D83B59DDBDF05BBC765C7EC',
              },
              {
                type: 'CRC32',
                hash: '24C21DE3',
              },
              {
                type: 'BLAKE3',
                hash: 'B50553BEE18C54E2A950CA2681365089DA4DF137B892FFF96A7DF0A53FFBE686',
              },
              {
                type: 'AutoV3',
                hash: 'F54EE1586A11',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 1172461,
          downloadCountAllTime: 17445,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 2200,
          thumbsDownCountAllTime: 3,
        },
        posts: [
          {
            id: 10453393,
          },
          {
            id: 10453952,
          },
          {
            id: 10454048,
          },
          {
            id: 10454323,
          },
          {
            id: 10454432,
          },
        ],
        hashes: ['019371b92f95edb5d4c834ab1aeba52b2cc099e69d83b59ddbdf05bbc765c7ec'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 1085338,
        modelId: 404154,
        name: 'v11',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-11-21T16:27:21.469Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: null,
        status: 'Published',
        publishedAt: '2024-11-21T17:35:57.019Z',
        meta: {
          imageNsfw: 'None',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 31,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 990499,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL11.ulRL.safetensors',
            sizeKB: 6775430.384765625,
            name: 'WAI-ANI-NSFW-PONYXL-11.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-11-21T16:53:18.637Z',
            modelVersionId: 1085338,
            hashes: [
              {
                type: 'AutoV1',
                hash: '20846C08',
              },
              {
                type: 'AutoV2',
                hash: '6599B20430',
              },
              {
                type: 'SHA256',
                hash: '6599B204307A73F065B67E620F704E0E322A49400B17F421F66059489887FB3E',
              },
              {
                type: 'CRC32',
                hash: '066E588F',
              },
              {
                type: 'BLAKE3',
                hash: '73E696CB1A204C8D766F87D032870EF7B6664EBFCC0CCA35694359240F4FB2C7',
              },
              {
                type: 'AutoV3',
                hash: 'F4BDEDC709E0',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 734462,
          downloadCountAllTime: 18419,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 1625,
          thumbsDownCountAllTime: 2,
        },
        posts: [
          {
            id: 9414718,
          },
          {
            id: 9415520,
          },
          {
            id: 9416768,
          },
          {
            id: 9417011,
          },
          {
            id: 9417244,
          },
          {
            id: 9417337,
          },
          {
            id: 9417647,
          },
          {
            id: 9417809,
          },
          {
            id: 9417950,
          },
          {
            id: 9418166,
          },
        ],
        hashes: ['6599b204307a73f065b67e620f704e0e322a49400b17f421f66059489887fb3e'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 1065370,
        modelId: 404154,
        name: 'v10',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-11-15T20:25:10.015Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: null,
        status: 'Published',
        publishedAt: '2024-11-15T22:18:27.494Z',
        meta: {
          imageNsfw: 'None',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 31,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 970910,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL10.HXxV.safetensors',
            sizeKB: 6775430.353515625,
            name: 'WAI-ANI-NSFW-PONYXL-10.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-11-15T20:53:00.538Z',
            modelVersionId: 1065370,
            hashes: [
              {
                type: 'AutoV1',
                hash: 'DE0B3D7F',
              },
              {
                type: 'AutoV2',
                hash: 'F231C98165',
              },
              {
                type: 'SHA256',
                hash: 'F231C9816584A009DC4482672FA557A0F0931F0C40FD5733B325E7CBCC7260AA',
              },
              {
                type: 'CRC32',
                hash: '6CDC4284',
              },
              {
                type: 'BLAKE3',
                hash: '3815146FCC5F2A70C19C3FC9E7A350BA8B41894466555670638FE548467A6B1E',
              },
              {
                type: 'AutoV3',
                hash: 'E98E61D7A1F1',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 106665,
          downloadCountAllTime: 6393,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 661,
          thumbsDownCountAllTime: 1,
        },
        posts: [
          {
            id: 9189314,
          },
        ],
        hashes: ['f231c9816584a009dc4482672fa557a0f0931f0c40fd5733b325e7cbcc7260aa'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 931577,
        modelId: 404154,
        name: 'v9.0',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-10-07T13:50:24.720Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: {
          timeframe: 0,
          donationGoal: 200000,
          downloadPrice: 100,
          donationGoalId: 2658,
          generationPrice: 50,
          chargeForDownload: true,
          originalTimeframe: '15',
          chargeForGeneration: true,
          donationGoalEnabled: true,
          originalPublishedAt: '2024-10-07T15:40:54.512',
          generationTrialLimit: 10,
        },
        status: 'Published',
        publishedAt: '2024-10-09T18:42:30.207Z',
        meta: {
          imageNsfw: 'None',
          hadEarlyAccessPurchase: true,
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 31,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 838980,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL09.jm31.safetensors',
            sizeKB: 6775430.353515625,
            name: 'WAI-ANI-NSFW-PONYXL-09.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-10-07T14:18:54.473Z',
            modelVersionId: 931577,
            hashes: [
              {
                type: 'AutoV1',
                hash: '7EE0BBBB',
              },
              {
                type: 'AutoV2',
                hash: 'D4D392A02C',
              },
              {
                type: 'SHA256',
                hash: 'D4D392A02CFF5E8EA0788988CED0C24C425748B8BB447529293A9D066A21A4E9',
              },
              {
                type: 'CRC32',
                hash: '8446C3DA',
              },
              {
                type: 'BLAKE3',
                hash: '73A099B8190044C6B70B6852552BC9D48D9F61F528AF07C43677BB160C711514',
              },
              {
                type: 'AutoV3',
                hash: 'D66493DEBD19',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 1220874,
          downloadCountAllTime: 26671,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 2665,
          thumbsDownCountAllTime: 5,
        },
        posts: [
          {
            id: 7624783,
          },
          {
            id: 7625417,
          },
          {
            id: 7625720,
          },
          {
            id: 7625950,
          },
          {
            id: 7626044,
          },
          {
            id: 7626159,
          },
          {
            id: 7626248,
          },
          {
            id: 7626369,
          },
          {
            id: 7626536,
          },
          {
            id: 7626888,
          },
          {
            id: 7627019,
          },
          {
            id: 7627189,
          },
          {
            id: 7627427,
          },
          {
            id: 7628169,
          },
          {
            id: 7628864,
          },
          {
            id: 7628960,
          },
          {
            id: 7633093,
          },
          {
            id: 7633341,
          },
          {
            id: 7634584,
          },
          {
            id: 7635204,
          },
          {
            id: 7684862,
          },
          {
            id: 7704487,
          },
          {
            id: 7746970,
          },
          {
            id: 8028295,
          },
          {
            id: 8029070,
          },
          {
            id: 8141574,
          },
        ],
        hashes: ['d4d392a02cff5e8ea0788988ced0c24c425748b8bb447529293a9d066a21a4e9'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 827519,
        modelId: 404154,
        name: 'v8.0',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-09-10T16:02:46.607Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: {
          timeframe: 0,
          donationGoal: 200000,
          downloadPrice: 100,
          donationGoalId: 1630,
          generationPrice: 50,
          chargeForDownload: true,
          originalTimeframe: '7',
          chargeForGeneration: true,
          donationGoalEnabled: true,
          originalPublishedAt: '2024-09-10T17:52:00.57',
          generationTrialLimit: 10,
        },
        status: 'Published',
        publishedAt: '2024-09-14T15:46:18.364Z',
        meta: {
          imageNsfw: 'None',
          hadEarlyAccessPurchase: true,
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 31,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 741620,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL08.9JnL.safetensors',
            sizeKB: 6775430.384765625,
            name: 'WAI-ANI-NSFW-PONYXL-08.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-09-10T16:57:46.761Z',
            modelVersionId: 827519,
            hashes: [
              {
                type: 'AutoV1',
                hash: 'ED8093EA',
              },
              {
                type: 'AutoV2',
                hash: 'C09F285811',
              },
              {
                type: 'SHA256',
                hash: 'C09F285811F11AECDB6D8BA73057C3670A30752B25B835C1C2F8EC919F8F40CD',
              },
              {
                type: 'CRC32',
                hash: '82D82E25',
              },
              {
                type: 'BLAKE3',
                hash: '53F5038589C8C2D956798F5C9599B46A65FECB52D62158AA077F352F79DB31C5',
              },
              {
                type: 'AutoV3',
                hash: '5B333DF0F846',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 551096,
          downloadCountAllTime: 17680,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 1829,
          thumbsDownCountAllTime: 2,
        },
        posts: [
          {
            id: 6430705,
          },
          {
            id: 6431461,
          },
          {
            id: 6431784,
          },
          {
            id: 6431970,
          },
          {
            id: 6443867,
          },
          {
            id: 6444033,
          },
          {
            id: 6444141,
          },
          {
            id: 6444204,
          },
          {
            id: 6444425,
          },
          {
            id: 6444527,
          },
          {
            id: 6444832,
          },
          {
            id: 6444880,
          },
          {
            id: 6458114,
          },
          {
            id: 6458694,
          },
          {
            id: 6458802,
          },
          {
            id: 6458914,
          },
          {
            id: 6458983,
          },
          {
            id: 6460148,
          },
          {
            id: 6460265,
          },
          {
            id: 6460604,
          },
          {
            id: 6461726,
          },
          {
            id: 6462422,
          },
          {
            id: 6463615,
          },
          {
            id: 6464176,
          },
          {
            id: 6464584,
          },
          {
            id: 6465055,
          },
          {
            id: 6466204,
          },
          {
            id: 6466499,
          },
          {
            id: 6887113,
          },
          {
            id: 7035159,
          },
          {
            id: 7035701,
          },
          {
            id: 7036113,
          },
        ],
        hashes: ['c09f285811f11aecdb6d8ba73057c3670a30752b25b835c1c2f8ec919f8f40cd'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 938880,
        modelId: 404154,
        name: 'V9_hyper_12step',
        description:
          '<p><strong>The example images use a size of 896x1192. no Hires. fix</strong></p><p><strong>Recommended Setting</strong></p><p><strong>Steps: 12</strong></p><p><strong>CFG scale:3.5-5</strong></p><p><strong>Sampler: Euler a/DPM++ 2M Karras</strong></p><p><strong>ADetailer face_yolov8n/</strong><a target="_blank" rel="ugc" href="http://s.pt"><strong>s.pt</strong></a><strong> use can fix eyes</strong></p><p>Positive Prompt</p><pre><code>score_9, score_8_up, score_7_up,source_anime,</code></pre><p>Negative Prompt</p><pre><code>worst quality,bad quality,jpeg artifacts, source_cartoon, \n3d, (censor),monochrome,blurry, lowres,watermark, </code></pre>',
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-10-09T20:12:05.117Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: null,
        status: 'Published',
        publishedAt: '2024-10-09T20:37:43.908Z',
        meta: {
          imageNsfw: 'None',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 25,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 846269,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/0912stepFp16.vCm3.safetensors',
            sizeKB: 6775430.376953125,
            name: '09_12step.fp16.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-10-09T20:44:02.928Z',
            modelVersionId: 938880,
            hashes: [
              {
                type: 'AutoV1',
                hash: '088F35CF',
              },
              {
                type: 'AutoV2',
                hash: '0AFE0DE117',
              },
              {
                type: 'SHA256',
                hash: '0AFE0DE117C92566001E2074E5460202848B1C09FFB20E88B19D15445B6071CB',
              },
              {
                type: 'CRC32',
                hash: '26107FA5',
              },
              {
                type: 'BLAKE3',
                hash: 'A83F4AB5F34377C9CBB7AED2E432BE0A287D11B383798634745EE881A12C0304',
              },
              {
                type: 'AutoV3',
                hash: '66550A9F2BC2',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 0,
          downloadCountAllTime: 2020,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 149,
          thumbsDownCountAllTime: 0,
        },
        posts: [
          {
            id: 7710154,
          },
        ],
        hashes: ['0afe0de117c92566001e2074e5460202848b1c09ffb20e88b19d15445b6071cb'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 900070,
        modelId: 404154,
        name: 'V8_hyper_12step',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-09-28T11:02:43.128Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: null,
        status: 'Published',
        publishedAt: '2024-09-28T11:27:24.434Z',
        meta: {
          imageNsfw: 'None',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 23,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 808568,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/12sFp16.XC9D.safetensors',
            sizeKB: 6775430.376953125,
            name: '12s.fp16.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-09-28T11:28:39.936Z',
            modelVersionId: 900070,
            hashes: [
              {
                type: 'AutoV1',
                hash: 'A27F9C57',
              },
              {
                type: 'AutoV2',
                hash: 'F897355EB6',
              },
              {
                type: 'SHA256',
                hash: 'F897355EB6485A0E90FBF382F0331196E3127D964859EC05F6C16DE4C05689EA',
              },
              {
                type: 'CRC32',
                hash: 'FF940839',
              },
              {
                type: 'BLAKE3',
                hash: '86BC6A3437DD2283DC18899AEB1FE04CB99DA200DA5388FA35EA5033569B1FF1',
              },
              {
                type: 'AutoV3',
                hash: 'A8CBDA4B8D68',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 0,
          downloadCountAllTime: 1154,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 144,
          thumbsDownCountAllTime: 0,
        },
        posts: [
          {
            id: 7189933,
          },
          {
            id: 7190704,
          },
          {
            id: 7190776,
          },
          {
            id: 7190920,
          },
        ],
        hashes: ['f897355eb6485a0e90fbf382f0331196e3127d964859ec05f6c16de4c05689ea'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 700352,
        modelId: 404154,
        name: 'v7.0',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-08-06T06:58:26.314Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: null,
        status: 'Published',
        publishedAt: '2024-08-06T07:54:12.324Z',
        meta: {
          imageNsfw: 'None',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 23,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 615058,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL07.oVfb.safetensors',
            sizeKB: 6775430.353515625,
            name: 'WAI-ANI-NSFW-PONYXL-07.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-08-13T18:22:56.119Z',
            modelVersionId: 700352,
            hashes: [
              {
                type: 'AutoV1',
                hash: '0C1B4780',
              },
              {
                type: 'AutoV2',
                hash: 'C6A7945B02',
              },
              {
                type: 'SHA256',
                hash: 'C6A7945B021B1FF0B6AFEE79E9A18F6A1C92E171C83ED13EF68D587618C2C57C',
              },
              {
                type: 'CRC32',
                hash: '116CEC72',
              },
              {
                type: 'BLAKE3',
                hash: 'C699ABF1494A6B3E4230BF52FD3BD9FCF766CFE8FB0BF2B5B5CC248C9F9832B6',
              },
              {
                type: 'AutoV3',
                hash: 'D2E586C6C8EF',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 502422,
          downloadCountAllTime: 21487,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 2185,
          thumbsDownCountAllTime: 2,
        },
        posts: [
          {
            id: 5121910,
          },
          {
            id: 5122928,
          },
          {
            id: 5123102,
          },
          {
            id: 5123802,
          },
          {
            id: 5124391,
          },
          {
            id: 5124578,
          },
          {
            id: 5124641,
          },
          {
            id: 5124770,
          },
          {
            id: 5124882,
          },
          {
            id: 5124942,
          },
          {
            id: 5125019,
          },
          {
            id: 5125128,
          },
          {
            id: 5125275,
          },
          {
            id: 5125345,
          },
          {
            id: 5125714,
          },
          {
            id: 5125760,
          },
          {
            id: 5125809,
          },
          {
            id: 5125895,
          },
          {
            id: 5126128,
          },
          {
            id: 5126237,
          },
          {
            id: 5126667,
          },
          {
            id: 5126790,
          },
          {
            id: 5126896,
          },
          {
            id: 5126944,
          },
          {
            id: 5127032,
          },
          {
            id: 5127089,
          },
          {
            id: 5127154,
          },
          {
            id: 5127215,
          },
          {
            id: 5127302,
          },
          {
            id: 5247454,
          },
          {
            id: 5262715,
          },
          {
            id: 5265469,
          },
          {
            id: 5266873,
          },
          {
            id: 5267499,
          },
          {
            id: 5270548,
          },
          {
            id: 5271323,
          },
          {
            id: 5306891,
          },
          {
            id: 5307289,
          },
          {
            id: 5445994,
          },
          {
            id: 5609969,
          },
          {
            id: 6277249,
          },
          {
            id: 6277327,
          },
        ],
        hashes: ['c6a7945b021b1ff0b6afee79e9a18f6a1c92e171c83ed13ef68d587618c2c57c'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 627330,
        modelId: 404154,
        name: 'v6.0',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-07-07T15:21:09.616Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: {},
        status: 'Published',
        publishedAt: '2024-07-07T16:38:17.174Z',
        meta: {
          imageNsfw: 'Soft',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 31,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 542214,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL06.YKJj.safetensors',
            sizeKB: 6775430.384765625,
            name: 'WAI-ANI-NSFW-PONYXL-06.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-08-13T18:28:52.204Z',
            modelVersionId: 627330,
            hashes: [
              {
                type: 'AutoV1',
                hash: 'D37E2BE4',
              },
              {
                type: 'AutoV2',
                hash: '4A11DE18C7',
              },
              {
                type: 'SHA256',
                hash: '4A11DE18C79AD49036C54813B4C8EF0E3D9C92CB5BE1297B81509050AC5F486E',
              },
              {
                type: 'CRC32',
                hash: '7422CE29',
              },
              {
                type: 'BLAKE3',
                hash: '4071C89C09362832E0E0B9E772272D83D80444CA25568BD67DE5EDD453676854',
              },
              {
                type: 'AutoV3',
                hash: '55C61039DD5E',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 5471,
          downloadCountAllTime: 18267,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 1669,
          thumbsDownCountAllTime: 1,
        },
        posts: [
          {
            id: 4208873,
          },
          {
            id: 4209915,
          },
          {
            id: 4209942,
          },
          {
            id: 4210052,
          },
          {
            id: 4210065,
          },
          {
            id: 4210284,
          },
          {
            id: 4210620,
          },
          {
            id: 4210731,
          },
          {
            id: 4211290,
          },
          {
            id: 4211501,
          },
          {
            id: 4211888,
          },
          {
            id: 4211968,
          },
          {
            id: 4212246,
          },
          {
            id: 4212589,
          },
          {
            id: 4212865,
          },
          {
            id: 4229433,
          },
          {
            id: 4230356,
          },
          {
            id: 4230920,
          },
          {
            id: 4231205,
          },
          {
            id: 4248917,
          },
          {
            id: 4300416,
          },
          {
            id: 4300783,
          },
          {
            id: 4303845,
          },
          {
            id: 4331910,
          },
          {
            id: 4356504,
          },
          {
            id: 4358442,
          },
          {
            id: 4490283,
          },
          {
            id: 4592746,
          },
          {
            id: 4592857,
          },
          {
            id: 4754515,
          },
          {
            id: 4786908,
          },
          {
            id: 4943091,
          },
          {
            id: 4950875,
          },
        ],
        hashes: ['4a11de18c79ad49036c54813b4c8ef0e3d9c92cb5be1297b81509050ac5f486e'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 652905,
        modelId: 404154,
        name: '8step',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-07-17T21:47:10.286Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: {},
        status: 'Published',
        publishedAt: '2024-07-17T22:42:51.792Z',
        meta: {
          imageNsfw: 'None',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 29,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 567951,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL.MaiR.safetensors',
            sizeKB: 6775430.376953125,
            name: 'WAI-ANI-NSFW-PONYXL-8step.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-08-13T18:28:55.629Z',
            modelVersionId: 652905,
            hashes: [
              {
                type: 'AutoV1',
                hash: 'FF362F32',
              },
              {
                type: 'AutoV2',
                hash: 'FF300D1B77',
              },
              {
                type: 'SHA256',
                hash: 'FF300D1B77A658D1EEBA3DEBB17A2C0D57DFE859E9E398C05101492ABD84F866',
              },
              {
                type: 'CRC32',
                hash: '42B1E14E',
              },
              {
                type: 'BLAKE3',
                hash: '29908D937B02A2D7F4D4576DCCEAF9E9ED3607F0156028CEF6C517375B8D624E',
              },
              {
                type: 'AutoV3',
                hash: '33043B000EEA',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 540,
          downloadCountAllTime: 901,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 84,
          thumbsDownCountAllTime: 0,
        },
        posts: [
          {
            id: 4524596,
          },
          {
            id: 4528076,
          },
        ],
        hashes: ['ff300d1b77a658d1eeba3debb17a2c0d57dfe859e9e398c05101492abd84f866'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 519036,
        modelId: 404154,
        name: 'v5.0',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-05-20T16:29:29.889Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: {},
        status: 'Published',
        publishedAt: '2024-05-20T16:53:05.661Z',
        meta: {
          imageNsfw: 'None',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 31,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 436241,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL05.Cnt9.safetensors',
            sizeKB: 6775430.353515625,
            name: 'WAI-ANI-NSFW-PONYXL-05.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-08-13T18:22:49.090Z',
            modelVersionId: 519036,
            hashes: [
              {
                type: 'AutoV1',
                hash: '19385173',
              },
              {
                type: 'AutoV2',
                hash: 'D2E24883BE',
              },
              {
                type: 'SHA256',
                hash: 'D2E24883BEF51D13759128214CE497CE5A404EB70C9F181E717BE2204EECFC85',
              },
              {
                type: 'CRC32',
                hash: '65CA8412',
              },
              {
                type: 'BLAKE3',
                hash: '64296C5EEC34F8AFD358D0E4B174347FF9A32DC5326D13A0A4692B551606D6DB',
              },
              {
                type: 'AutoV3',
                hash: '3E1F2B680E0C',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 985,
          downloadCountAllTime: 10564,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 1217,
          thumbsDownCountAllTime: 0,
        },
        posts: [
          {
            id: 3540883,
          },
          {
            id: 3570510,
          },
          {
            id: 4079318,
          },
        ],
        hashes: ['d2e24883bef51d13759128214ce497ce5a404eb70c9f181e717be2204eecfc85'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 494190,
        modelId: 404154,
        name: 'v4.0',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-05-08T18:03:04.256Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: {},
        status: 'Published',
        publishedAt: '2024-05-08T19:10:43.291Z',
        meta: {
          imageNsfw: 'Soft',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 31,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 412117,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL04.Cbm9.safetensors',
            sizeKB: 6775430.376953125,
            name: 'WAI-ANI-NSFW-PONYXL-04.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-08-13T18:23:04.505Z',
            modelVersionId: 494190,
            hashes: [
              {
                type: 'AutoV1',
                hash: 'C7C95ADA',
              },
              {
                type: 'AutoV2',
                hash: '259DE9EC5E',
              },
              {
                type: 'SHA256',
                hash: '259DE9EC5E5B5D81AF3042A9B1490FE593A69E6226DBE6E029E0793B5942967B',
              },
              {
                type: 'CRC32',
                hash: '6C4254BE',
              },
              {
                type: 'BLAKE3',
                hash: '5EA5A07BAA042887ACA09900C92CBFD6A6783C6847986690970FE3551DB69821',
              },
              {
                type: 'AutoV3',
                hash: '34A008700A27',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 879,
          downloadCountAllTime: 3564,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 422,
          thumbsDownCountAllTime: 2,
        },
        posts: [
          {
            id: 2624879,
          },
          {
            id: 2641626,
          },
          {
            id: 2642146,
          },
          {
            id: 2643282,
          },
          {
            id: 2659932,
          },
          {
            id: 2668472,
          },
        ],
        hashes: ['259de9ec5e5b5d81af3042a9b1490fe593a69e6226dbe6e029e0793b5942967b'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 469973,
        modelId: 404154,
        name: 'v3.0',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: null,
        createdAt: '2024-04-26T21:43:16.152Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: {},
        status: 'Published',
        publishedAt: '2024-04-26T22:37:05.237Z',
        meta: {
          imageNsfw: 'None',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 25,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 388672,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL03.Hhqn.safetensors',
            sizeKB: 6775430.376953125,
            name: 'WAI-ANI-NSFW-PONYXL-03.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-08-13T18:22:48.384Z',
            modelVersionId: 469973,
            hashes: [
              {
                type: 'AutoV1',
                hash: '5F1AC6E5',
              },
              {
                type: 'AutoV2',
                hash: '00B8E6E752',
              },
              {
                type: 'SHA256',
                hash: '00B8E6E7527E51B17C7F4855A72B119E49FC96EA44CF4C31D2FEBFE78383C6D2',
              },
              {
                type: 'CRC32',
                hash: '02A2FCB6',
              },
              {
                type: 'BLAKE3',
                hash: 'F7AD89A8978F0465F1D7CC5410B79BFBECD376385C882F3ADAFBDC742B190C44',
              },
              {
                type: 'AutoV3',
                hash: 'AFF2CC1B352D',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 30,
          downloadCountAllTime: 2406,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 242,
          thumbsDownCountAllTime: 2,
        },
        posts: [
          {
            id: 2378138,
          },
          {
            id: 2388740,
          },
          {
            id: 2389154,
          },
          {
            id: 2389623,
          },
          {
            id: 2391012,
          },
        ],
        hashes: ['00b8e6e7527e51b17c7f4855a72b119e49fc96ea44cf4c31d2febfe78383c6d2'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 452526,
        modelId: 404154,
        name: 'v2.0',
        description:
          '<p><strong><em>Add VAE </em></strong></p><p><strong><em>quality improvement</em></strong></p><p>Recommended Setting</p><ul><li><p>Steps: 30</p></li><li><p>CFG scale: 7</p></li><li><p>Sampler: Euler a</p></li></ul><p>Positive Prompt</p><pre><code>score_9, score_8_up, score_7_up,</code></pre><p>Negative Prompt</p><pre><code>score_6,score_5,score_4, low quality, worst quality,blurry, lowres, bad anatomy, bad hands, missing fingers, 3d, monochrome, (censor), source_furry, source_pony, source_cartoon,</code></pre>',
        steps: null,
        epochs: null,
        clipSkip: null,
        createdAt: '2024-04-17T18:10:18.463Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: {},
        status: 'Published',
        publishedAt: '2024-04-17T18:38:41.091Z',
        meta: {
          imageNsfw: 'None',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 25,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 372126,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL02.nSo5.safetensors',
            sizeKB: 6775430.353515625,
            name: 'WAI-ANI-NSFW-PONYXL-02.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-08-13T18:28:25.143Z',
            modelVersionId: 452526,
            hashes: [
              {
                type: 'AutoV1',
                hash: '3EA6E148',
              },
              {
                type: 'AutoV2',
                hash: 'BEF14AAC0A',
              },
              {
                type: 'SHA256',
                hash: 'BEF14AAC0AB4A3938B369D0950F95FC4158CBCCDDD4890CE168B507BD8415592',
              },
              {
                type: 'CRC32',
                hash: '512B2131',
              },
              {
                type: 'BLAKE3',
                hash: 'F2B07498BC78DF82C4A8FDBD9FC3537002BFC954F3F6F7FDC18C2716AA7CB3C1',
              },
              {
                type: 'AutoV3',
                hash: '428FB69A90A8',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 15,
          downloadCountAllTime: 1617,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 215,
          thumbsDownCountAllTime: 1,
        },
        posts: [
          {
            id: 2203680,
          },
          {
            id: 2203955,
          },
          {
            id: 2204640,
          },
          {
            id: 2218507,
          },
          {
            id: 2218841,
          },
          {
            id: 2219224,
          },
          {
            id: 2277649,
          },
        ],
        hashes: ['bef14aac0ab4a3938b369d0950f95fc4158cbccddd4890ce168b507bd8415592'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
      {
        id: 450626,
        modelId: 404154,
        name: 'v1.0',
        description: null,
        steps: null,
        epochs: null,
        clipSkip: 2,
        createdAt: '2024-04-16T16:34:08.563Z',
        updatedAt: '2025-01-17T18:26:05.574Z',
        trainedWords: [],
        trainingStatus: null,
        trainingDetails: null,
        inaccurate: false,
        baseModel: 'Pony',
        baseModelType: 'Standard',
        earlyAccessEndsAt: null,
        earlyAccessConfig: {},
        status: 'Published',
        publishedAt: '2024-04-16T18:08:14.688Z',
        meta: {
          imageNsfw: 'None',
        },
        vaeId: null,
        settings: null,
        requireAuth: false,
        nsfwLevel: 21,
        uploadType: 'Created',
        usageControl: 'Download',
        files: [
          {
            id: 370429,
            url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL.BOhA.safetensors',
            sizeKB: 6775430.384765625,
            name: 'WAI-ANI-NSFW-PONYXL.safetensors',
            type: 'Model',
            visibility: 'Public',
            metadata: {
              fp: 'fp16',
              size: 'pruned',
              format: 'SafeTensor',
            },
            pickleScanResult: 'Success',
            pickleScanMessage: 'No Pickle imports',
            virusScanResult: 'Success',
            virusScanMessage: null,
            scannedAt: '2024-08-13T18:28:59.987Z',
            modelVersionId: 450626,
            hashes: [
              {
                type: 'AutoV1',
                hash: '4EB6FD15',
              },
              {
                type: 'AutoV2',
                hash: '2C1212046F',
              },
              {
                type: 'SHA256',
                hash: '2C1212046FF5207C2B19EA4F68A1145BC7F81346D791C092F50F8FCD0A09E229',
              },
              {
                type: 'CRC32',
                hash: '46AA7A31',
              },
              {
                type: 'BLAKE3',
                hash: '83B06A7369DB56D32173236B250100D9CC9EA64EBA716DE90E1A229C3E3235C4',
              },
              {
                type: 'AutoV3',
                hash: 'B7CA9430A339',
              },
            ],
          },
        ],
        generationCoverage: null,
        recommendedResources: [],
        rank: {
          generationCountAllTime: 25,
          downloadCountAllTime: 750,
          ratingCountAllTime: 0,
          ratingAllTime: 0,
          thumbsUpCountAllTime: 90,
          thumbsDownCountAllTime: 0,
        },
        posts: [
          {
            id: 2184996,
          },
        ],
        hashes: ['2c1212046ff5207c2b19ea4f68a1145bc7f81346d791c092f50f8fcd0a09e229'],
        earlyAccessDeadline: null,
        canDownload: true,
        canGenerate: false,
      },
    ],
    tagsOnModels: [
      {
        tag: {
          id: 4,
          name: 'anime',
          isCategory: false,
        },
      },
      {
        tag: {
          id: 190,
          name: 'sexy',
          isCategory: false,
        },
      },
      {
        tag: {
          id: 3673,
          name: 'style',
          isCategory: true,
        },
      },
    ],
    rank: {
      downloadCountAllTime: 166653,
      favoriteCountAllTime: 0,
      thumbsUpCountAllTime: 11690,
      thumbsDownCountAllTime: 20,
      commentCountAllTime: 225,
      ratingCountAllTime: 0,
      ratingAllTime: 0,
      tippedAmountCountAllTime: 433640,
      imageCountAllTime: 0,
      collectedCountAllTime: 3784,
      generationCountAllTime: 5501909,
    },
    canGenerate: true,
    hasSuggestedResources: false,
  },
  modelVersions: [
    {
      id: 1295881,
      modelId: 404154,
      name: 'v13.0',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: null,
      createdAt: '2025-01-17T18:26:05.574Z',
      updatedAt: '2025-01-17T19:21:38.419Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: null,
      status: 'Published',
      publishedAt: '2025-01-17T19:21:38.410Z',
      meta: {
        imageNsfw: 'None',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 31,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 1200214,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANIHENTAIPONYXL13.qfgJ.safetensors',
          sizeKB: 6775430.384765625,
          name: 'WAI-ANI-HENTAI-PONYXL-13.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2025-01-17T18:54:16.133Z',
          modelVersionId: 1295881,
          hashes: [
            {
              type: 'AutoV1',
              hash: '088BED18',
            },
            {
              type: 'AutoV2',
              hash: 'BFA96353B7',
            },
            {
              type: 'SHA256',
              hash: 'BFA96353B76FCC1971DBA1FA98E4D9DBAD9965220104E3913A61B4EDA8143E3F',
            },
            {
              type: 'CRC32',
              hash: 'AFDE3508',
            },
            {
              type: 'BLAKE3',
              hash: 'C0FC0322048053E5514DD93F241B099780798EBE9F3088539CF72C163FB9E6FF',
            },
            {
              type: 'AutoV3',
              hash: 'CEA21DFF3DF9',
            },
          ],
        },
      ],
      generationCoverage: {
        covered: true,
      },
      recommendedResources: [],
      rank: {
        generationCountAllTime: 1205984,
        downloadCountAllTime: 17315,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 2006,
        thumbsDownCountAllTime: 5,
      },
      posts: [
        {
          id: 11741341,
        },
      ],
      hashes: ['bfa96353b76fcc1971dba1fa98e4d9dbad9965220104e3913a61b4eda8143e3f'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: true,
    },
    {
      id: 1177000,
      modelId: 404154,
      name: 'v12',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-12-18T10:23:59.036Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: null,
      status: 'Published',
      publishedAt: '2024-12-18T11:28:49.051Z',
      meta: {
        imageNsfw: 'None',
      },
      vaeId: null,
      settings: null,
      requireAuth: true,
      nsfwLevel: 31,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 1082392,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL12.rIem.safetensors',
          sizeKB: 6775430.353515625,
          name: 'WAI-ANI-NSFW-PONYXL-12.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-12-18T11:08:10.427Z',
          modelVersionId: 1177000,
          hashes: [
            {
              type: 'AutoV1',
              hash: '84D3DC2B',
            },
            {
              type: 'AutoV2',
              hash: '019371B92F',
            },
            {
              type: 'SHA256',
              hash: '019371B92F95EDB5D4C834AB1AEBA52B2CC099E69D83B59DDBDF05BBC765C7EC',
            },
            {
              type: 'CRC32',
              hash: '24C21DE3',
            },
            {
              type: 'BLAKE3',
              hash: 'B50553BEE18C54E2A950CA2681365089DA4DF137B892FFF96A7DF0A53FFBE686',
            },
            {
              type: 'AutoV3',
              hash: 'F54EE1586A11',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 1172461,
        downloadCountAllTime: 17445,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 2200,
        thumbsDownCountAllTime: 3,
      },
      posts: [
        {
          id: 10453393,
        },
        {
          id: 10453952,
        },
        {
          id: 10454048,
        },
        {
          id: 10454323,
        },
        {
          id: 10454432,
        },
      ],
      hashes: ['019371b92f95edb5d4c834ab1aeba52b2cc099e69d83b59ddbdf05bbc765c7ec'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 1085338,
      modelId: 404154,
      name: 'v11',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-11-21T16:27:21.469Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: null,
      status: 'Published',
      publishedAt: '2024-11-21T17:35:57.019Z',
      meta: {
        imageNsfw: 'None',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 31,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 990499,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL11.ulRL.safetensors',
          sizeKB: 6775430.384765625,
          name: 'WAI-ANI-NSFW-PONYXL-11.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-11-21T16:53:18.637Z',
          modelVersionId: 1085338,
          hashes: [
            {
              type: 'AutoV1',
              hash: '20846C08',
            },
            {
              type: 'AutoV2',
              hash: '6599B20430',
            },
            {
              type: 'SHA256',
              hash: '6599B204307A73F065B67E620F704E0E322A49400B17F421F66059489887FB3E',
            },
            {
              type: 'CRC32',
              hash: '066E588F',
            },
            {
              type: 'BLAKE3',
              hash: '73E696CB1A204C8D766F87D032870EF7B6664EBFCC0CCA35694359240F4FB2C7',
            },
            {
              type: 'AutoV3',
              hash: 'F4BDEDC709E0',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 734462,
        downloadCountAllTime: 18419,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 1625,
        thumbsDownCountAllTime: 2,
      },
      posts: [
        {
          id: 9414718,
        },
        {
          id: 9415520,
        },
        {
          id: 9416768,
        },
        {
          id: 9417011,
        },
        {
          id: 9417244,
        },
        {
          id: 9417337,
        },
        {
          id: 9417647,
        },
        {
          id: 9417809,
        },
        {
          id: 9417950,
        },
        {
          id: 9418166,
        },
      ],
      hashes: ['6599b204307a73f065b67e620f704e0e322a49400b17f421f66059489887fb3e'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 1065370,
      modelId: 404154,
      name: 'v10',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-11-15T20:25:10.015Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: null,
      status: 'Published',
      publishedAt: '2024-11-15T22:18:27.494Z',
      meta: {
        imageNsfw: 'None',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 31,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 970910,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL10.HXxV.safetensors',
          sizeKB: 6775430.353515625,
          name: 'WAI-ANI-NSFW-PONYXL-10.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-11-15T20:53:00.538Z',
          modelVersionId: 1065370,
          hashes: [
            {
              type: 'AutoV1',
              hash: 'DE0B3D7F',
            },
            {
              type: 'AutoV2',
              hash: 'F231C98165',
            },
            {
              type: 'SHA256',
              hash: 'F231C9816584A009DC4482672FA557A0F0931F0C40FD5733B325E7CBCC7260AA',
            },
            {
              type: 'CRC32',
              hash: '6CDC4284',
            },
            {
              type: 'BLAKE3',
              hash: '3815146FCC5F2A70C19C3FC9E7A350BA8B41894466555670638FE548467A6B1E',
            },
            {
              type: 'AutoV3',
              hash: 'E98E61D7A1F1',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 106665,
        downloadCountAllTime: 6393,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 661,
        thumbsDownCountAllTime: 1,
      },
      posts: [
        {
          id: 9189314,
        },
      ],
      hashes: ['f231c9816584a009dc4482672fa557a0f0931f0c40fd5733b325e7cbcc7260aa'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 931577,
      modelId: 404154,
      name: 'v9.0',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-10-07T13:50:24.720Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: {
        timeframe: 0,
        donationGoal: 200000,
        downloadPrice: 100,
        donationGoalId: 2658,
        generationPrice: 50,
        chargeForDownload: true,
        originalTimeframe: '15',
        chargeForGeneration: true,
        donationGoalEnabled: true,
        originalPublishedAt: '2024-10-07T15:40:54.512',
        generationTrialLimit: 10,
      },
      status: 'Published',
      publishedAt: '2024-10-09T18:42:30.207Z',
      meta: {
        imageNsfw: 'None',
        hadEarlyAccessPurchase: true,
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 31,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 838980,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL09.jm31.safetensors',
          sizeKB: 6775430.353515625,
          name: 'WAI-ANI-NSFW-PONYXL-09.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-10-07T14:18:54.473Z',
          modelVersionId: 931577,
          hashes: [
            {
              type: 'AutoV1',
              hash: '7EE0BBBB',
            },
            {
              type: 'AutoV2',
              hash: 'D4D392A02C',
            },
            {
              type: 'SHA256',
              hash: 'D4D392A02CFF5E8EA0788988CED0C24C425748B8BB447529293A9D066A21A4E9',
            },
            {
              type: 'CRC32',
              hash: '8446C3DA',
            },
            {
              type: 'BLAKE3',
              hash: '73A099B8190044C6B70B6852552BC9D48D9F61F528AF07C43677BB160C711514',
            },
            {
              type: 'AutoV3',
              hash: 'D66493DEBD19',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 1220874,
        downloadCountAllTime: 26671,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 2665,
        thumbsDownCountAllTime: 5,
      },
      posts: [
        {
          id: 7624783,
        },
        {
          id: 7625417,
        },
        {
          id: 7625720,
        },
        {
          id: 7625950,
        },
        {
          id: 7626044,
        },
        {
          id: 7626159,
        },
        {
          id: 7626248,
        },
        {
          id: 7626369,
        },
        {
          id: 7626536,
        },
        {
          id: 7626888,
        },
        {
          id: 7627019,
        },
        {
          id: 7627189,
        },
        {
          id: 7627427,
        },
        {
          id: 7628169,
        },
        {
          id: 7628864,
        },
        {
          id: 7628960,
        },
        {
          id: 7633093,
        },
        {
          id: 7633341,
        },
        {
          id: 7634584,
        },
        {
          id: 7635204,
        },
        {
          id: 7684862,
        },
        {
          id: 7704487,
        },
        {
          id: 7746970,
        },
        {
          id: 8028295,
        },
        {
          id: 8029070,
        },
        {
          id: 8141574,
        },
      ],
      hashes: ['d4d392a02cff5e8ea0788988ced0c24c425748b8bb447529293a9d066a21a4e9'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 827519,
      modelId: 404154,
      name: 'v8.0',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-09-10T16:02:46.607Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: {
        timeframe: 0,
        donationGoal: 200000,
        downloadPrice: 100,
        donationGoalId: 1630,
        generationPrice: 50,
        chargeForDownload: true,
        originalTimeframe: '7',
        chargeForGeneration: true,
        donationGoalEnabled: true,
        originalPublishedAt: '2024-09-10T17:52:00.57',
        generationTrialLimit: 10,
      },
      status: 'Published',
      publishedAt: '2024-09-14T15:46:18.364Z',
      meta: {
        imageNsfw: 'None',
        hadEarlyAccessPurchase: true,
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 31,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 741620,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL08.9JnL.safetensors',
          sizeKB: 6775430.384765625,
          name: 'WAI-ANI-NSFW-PONYXL-08.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-09-10T16:57:46.761Z',
          modelVersionId: 827519,
          hashes: [
            {
              type: 'AutoV1',
              hash: 'ED8093EA',
            },
            {
              type: 'AutoV2',
              hash: 'C09F285811',
            },
            {
              type: 'SHA256',
              hash: 'C09F285811F11AECDB6D8BA73057C3670A30752B25B835C1C2F8EC919F8F40CD',
            },
            {
              type: 'CRC32',
              hash: '82D82E25',
            },
            {
              type: 'BLAKE3',
              hash: '53F5038589C8C2D956798F5C9599B46A65FECB52D62158AA077F352F79DB31C5',
            },
            {
              type: 'AutoV3',
              hash: '5B333DF0F846',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 551096,
        downloadCountAllTime: 17680,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 1829,
        thumbsDownCountAllTime: 2,
      },
      posts: [
        {
          id: 6430705,
        },
        {
          id: 6431461,
        },
        {
          id: 6431784,
        },
        {
          id: 6431970,
        },
        {
          id: 6443867,
        },
        {
          id: 6444033,
        },
        {
          id: 6444141,
        },
        {
          id: 6444204,
        },
        {
          id: 6444425,
        },
        {
          id: 6444527,
        },
        {
          id: 6444832,
        },
        {
          id: 6444880,
        },
        {
          id: 6458114,
        },
        {
          id: 6458694,
        },
        {
          id: 6458802,
        },
        {
          id: 6458914,
        },
        {
          id: 6458983,
        },
        {
          id: 6460148,
        },
        {
          id: 6460265,
        },
        {
          id: 6460604,
        },
        {
          id: 6461726,
        },
        {
          id: 6462422,
        },
        {
          id: 6463615,
        },
        {
          id: 6464176,
        },
        {
          id: 6464584,
        },
        {
          id: 6465055,
        },
        {
          id: 6466204,
        },
        {
          id: 6466499,
        },
        {
          id: 6887113,
        },
        {
          id: 7035159,
        },
        {
          id: 7035701,
        },
        {
          id: 7036113,
        },
      ],
      hashes: ['c09f285811f11aecdb6d8ba73057c3670a30752b25b835c1c2f8ec919f8f40cd'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 938880,
      modelId: 404154,
      name: 'V9_hyper_12step',
      description:
        '<p><strong>The example images use a size of 896x1192. no Hires. fix</strong></p><p><strong>Recommended Setting</strong></p><p><strong>Steps: 12</strong></p><p><strong>CFG scale:3.5-5</strong></p><p><strong>Sampler: Euler a/DPM++ 2M Karras</strong></p><p><strong>ADetailer face_yolov8n/</strong><a target="_blank" rel="ugc" href="http://s.pt"><strong>s.pt</strong></a><strong> use can fix eyes</strong></p><p>Positive Prompt</p><pre><code>score_9, score_8_up, score_7_up,source_anime,</code></pre><p>Negative Prompt</p><pre><code>worst quality,bad quality,jpeg artifacts, source_cartoon, \n3d, (censor),monochrome,blurry, lowres,watermark, </code></pre>',
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-10-09T20:12:05.117Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: null,
      status: 'Published',
      publishedAt: '2024-10-09T20:37:43.908Z',
      meta: {
        imageNsfw: 'None',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 25,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 846269,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/0912stepFp16.vCm3.safetensors',
          sizeKB: 6775430.376953125,
          name: '09_12step.fp16.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-10-09T20:44:02.928Z',
          modelVersionId: 938880,
          hashes: [
            {
              type: 'AutoV1',
              hash: '088F35CF',
            },
            {
              type: 'AutoV2',
              hash: '0AFE0DE117',
            },
            {
              type: 'SHA256',
              hash: '0AFE0DE117C92566001E2074E5460202848B1C09FFB20E88B19D15445B6071CB',
            },
            {
              type: 'CRC32',
              hash: '26107FA5',
            },
            {
              type: 'BLAKE3',
              hash: 'A83F4AB5F34377C9CBB7AED2E432BE0A287D11B383798634745EE881A12C0304',
            },
            {
              type: 'AutoV3',
              hash: '66550A9F2BC2',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 0,
        downloadCountAllTime: 2020,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 149,
        thumbsDownCountAllTime: 0,
      },
      posts: [
        {
          id: 7710154,
        },
      ],
      hashes: ['0afe0de117c92566001e2074e5460202848b1c09ffb20e88b19d15445b6071cb'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 900070,
      modelId: 404154,
      name: 'V8_hyper_12step',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-09-28T11:02:43.128Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: null,
      status: 'Published',
      publishedAt: '2024-09-28T11:27:24.434Z',
      meta: {
        imageNsfw: 'None',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 23,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 808568,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/12sFp16.XC9D.safetensors',
          sizeKB: 6775430.376953125,
          name: '12s.fp16.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-09-28T11:28:39.936Z',
          modelVersionId: 900070,
          hashes: [
            {
              type: 'AutoV1',
              hash: 'A27F9C57',
            },
            {
              type: 'AutoV2',
              hash: 'F897355EB6',
            },
            {
              type: 'SHA256',
              hash: 'F897355EB6485A0E90FBF382F0331196E3127D964859EC05F6C16DE4C05689EA',
            },
            {
              type: 'CRC32',
              hash: 'FF940839',
            },
            {
              type: 'BLAKE3',
              hash: '86BC6A3437DD2283DC18899AEB1FE04CB99DA200DA5388FA35EA5033569B1FF1',
            },
            {
              type: 'AutoV3',
              hash: 'A8CBDA4B8D68',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 0,
        downloadCountAllTime: 1154,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 144,
        thumbsDownCountAllTime: 0,
      },
      posts: [
        {
          id: 7189933,
        },
        {
          id: 7190704,
        },
        {
          id: 7190776,
        },
        {
          id: 7190920,
        },
      ],
      hashes: ['f897355eb6485a0e90fbf382f0331196e3127d964859ec05f6c16de4c05689ea'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 700352,
      modelId: 404154,
      name: 'v7.0',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-08-06T06:58:26.314Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: null,
      status: 'Published',
      publishedAt: '2024-08-06T07:54:12.324Z',
      meta: {
        imageNsfw: 'None',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 23,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 615058,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL07.oVfb.safetensors',
          sizeKB: 6775430.353515625,
          name: 'WAI-ANI-NSFW-PONYXL-07.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-08-13T18:22:56.119Z',
          modelVersionId: 700352,
          hashes: [
            {
              type: 'AutoV1',
              hash: '0C1B4780',
            },
            {
              type: 'AutoV2',
              hash: 'C6A7945B02',
            },
            {
              type: 'SHA256',
              hash: 'C6A7945B021B1FF0B6AFEE79E9A18F6A1C92E171C83ED13EF68D587618C2C57C',
            },
            {
              type: 'CRC32',
              hash: '116CEC72',
            },
            {
              type: 'BLAKE3',
              hash: 'C699ABF1494A6B3E4230BF52FD3BD9FCF766CFE8FB0BF2B5B5CC248C9F9832B6',
            },
            {
              type: 'AutoV3',
              hash: 'D2E586C6C8EF',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 502422,
        downloadCountAllTime: 21487,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 2185,
        thumbsDownCountAllTime: 2,
      },
      posts: [
        {
          id: 5121910,
        },
        {
          id: 5122928,
        },
        {
          id: 5123102,
        },
        {
          id: 5123802,
        },
        {
          id: 5124391,
        },
        {
          id: 5124578,
        },
        {
          id: 5124641,
        },
        {
          id: 5124770,
        },
        {
          id: 5124882,
        },
        {
          id: 5124942,
        },
        {
          id: 5125019,
        },
        {
          id: 5125128,
        },
        {
          id: 5125275,
        },
        {
          id: 5125345,
        },
        {
          id: 5125714,
        },
        {
          id: 5125760,
        },
        {
          id: 5125809,
        },
        {
          id: 5125895,
        },
        {
          id: 5126128,
        },
        {
          id: 5126237,
        },
        {
          id: 5126667,
        },
        {
          id: 5126790,
        },
        {
          id: 5126896,
        },
        {
          id: 5126944,
        },
        {
          id: 5127032,
        },
        {
          id: 5127089,
        },
        {
          id: 5127154,
        },
        {
          id: 5127215,
        },
        {
          id: 5127302,
        },
        {
          id: 5247454,
        },
        {
          id: 5262715,
        },
        {
          id: 5265469,
        },
        {
          id: 5266873,
        },
        {
          id: 5267499,
        },
        {
          id: 5270548,
        },
        {
          id: 5271323,
        },
        {
          id: 5306891,
        },
        {
          id: 5307289,
        },
        {
          id: 5445994,
        },
        {
          id: 5609969,
        },
        {
          id: 6277249,
        },
        {
          id: 6277327,
        },
      ],
      hashes: ['c6a7945b021b1ff0b6afee79e9a18f6a1c92e171c83ed13ef68d587618c2c57c'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 627330,
      modelId: 404154,
      name: 'v6.0',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-07-07T15:21:09.616Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: {},
      status: 'Published',
      publishedAt: '2024-07-07T16:38:17.174Z',
      meta: {
        imageNsfw: 'Soft',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 31,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 542214,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL06.YKJj.safetensors',
          sizeKB: 6775430.384765625,
          name: 'WAI-ANI-NSFW-PONYXL-06.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-08-13T18:28:52.204Z',
          modelVersionId: 627330,
          hashes: [
            {
              type: 'AutoV1',
              hash: 'D37E2BE4',
            },
            {
              type: 'AutoV2',
              hash: '4A11DE18C7',
            },
            {
              type: 'SHA256',
              hash: '4A11DE18C79AD49036C54813B4C8EF0E3D9C92CB5BE1297B81509050AC5F486E',
            },
            {
              type: 'CRC32',
              hash: '7422CE29',
            },
            {
              type: 'BLAKE3',
              hash: '4071C89C09362832E0E0B9E772272D83D80444CA25568BD67DE5EDD453676854',
            },
            {
              type: 'AutoV3',
              hash: '55C61039DD5E',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 5471,
        downloadCountAllTime: 18267,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 1669,
        thumbsDownCountAllTime: 1,
      },
      posts: [
        {
          id: 4208873,
        },
        {
          id: 4209915,
        },
        {
          id: 4209942,
        },
        {
          id: 4210052,
        },
        {
          id: 4210065,
        },
        {
          id: 4210284,
        },
        {
          id: 4210620,
        },
        {
          id: 4210731,
        },
        {
          id: 4211290,
        },
        {
          id: 4211501,
        },
        {
          id: 4211888,
        },
        {
          id: 4211968,
        },
        {
          id: 4212246,
        },
        {
          id: 4212589,
        },
        {
          id: 4212865,
        },
        {
          id: 4229433,
        },
        {
          id: 4230356,
        },
        {
          id: 4230920,
        },
        {
          id: 4231205,
        },
        {
          id: 4248917,
        },
        {
          id: 4300416,
        },
        {
          id: 4300783,
        },
        {
          id: 4303845,
        },
        {
          id: 4331910,
        },
        {
          id: 4356504,
        },
        {
          id: 4358442,
        },
        {
          id: 4490283,
        },
        {
          id: 4592746,
        },
        {
          id: 4592857,
        },
        {
          id: 4754515,
        },
        {
          id: 4786908,
        },
        {
          id: 4943091,
        },
        {
          id: 4950875,
        },
      ],
      hashes: ['4a11de18c79ad49036c54813b4c8ef0e3d9c92cb5be1297b81509050ac5f486e'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 652905,
      modelId: 404154,
      name: '8step',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-07-17T21:47:10.286Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: {},
      status: 'Published',
      publishedAt: '2024-07-17T22:42:51.792Z',
      meta: {
        imageNsfw: 'None',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 29,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 567951,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL.MaiR.safetensors',
          sizeKB: 6775430.376953125,
          name: 'WAI-ANI-NSFW-PONYXL-8step.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-08-13T18:28:55.629Z',
          modelVersionId: 652905,
          hashes: [
            {
              type: 'AutoV1',
              hash: 'FF362F32',
            },
            {
              type: 'AutoV2',
              hash: 'FF300D1B77',
            },
            {
              type: 'SHA256',
              hash: 'FF300D1B77A658D1EEBA3DEBB17A2C0D57DFE859E9E398C05101492ABD84F866',
            },
            {
              type: 'CRC32',
              hash: '42B1E14E',
            },
            {
              type: 'BLAKE3',
              hash: '29908D937B02A2D7F4D4576DCCEAF9E9ED3607F0156028CEF6C517375B8D624E',
            },
            {
              type: 'AutoV3',
              hash: '33043B000EEA',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 540,
        downloadCountAllTime: 901,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 84,
        thumbsDownCountAllTime: 0,
      },
      posts: [
        {
          id: 4524596,
        },
        {
          id: 4528076,
        },
      ],
      hashes: ['ff300d1b77a658d1eeba3debb17a2c0d57dfe859e9e398c05101492abd84f866'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 519036,
      modelId: 404154,
      name: 'v5.0',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-05-20T16:29:29.889Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: {},
      status: 'Published',
      publishedAt: '2024-05-20T16:53:05.661Z',
      meta: {
        imageNsfw: 'None',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 31,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 436241,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL05.Cnt9.safetensors',
          sizeKB: 6775430.353515625,
          name: 'WAI-ANI-NSFW-PONYXL-05.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-08-13T18:22:49.090Z',
          modelVersionId: 519036,
          hashes: [
            {
              type: 'AutoV1',
              hash: '19385173',
            },
            {
              type: 'AutoV2',
              hash: 'D2E24883BE',
            },
            {
              type: 'SHA256',
              hash: 'D2E24883BEF51D13759128214CE497CE5A404EB70C9F181E717BE2204EECFC85',
            },
            {
              type: 'CRC32',
              hash: '65CA8412',
            },
            {
              type: 'BLAKE3',
              hash: '64296C5EEC34F8AFD358D0E4B174347FF9A32DC5326D13A0A4692B551606D6DB',
            },
            {
              type: 'AutoV3',
              hash: '3E1F2B680E0C',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 985,
        downloadCountAllTime: 10564,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 1217,
        thumbsDownCountAllTime: 0,
      },
      posts: [
        {
          id: 3540883,
        },
        {
          id: 3570510,
        },
        {
          id: 4079318,
        },
      ],
      hashes: ['d2e24883bef51d13759128214ce497ce5a404eb70c9f181e717be2204eecfc85'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 494190,
      modelId: 404154,
      name: 'v4.0',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-05-08T18:03:04.256Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: {},
      status: 'Published',
      publishedAt: '2024-05-08T19:10:43.291Z',
      meta: {
        imageNsfw: 'Soft',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 31,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 412117,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL04.Cbm9.safetensors',
          sizeKB: 6775430.376953125,
          name: 'WAI-ANI-NSFW-PONYXL-04.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-08-13T18:23:04.505Z',
          modelVersionId: 494190,
          hashes: [
            {
              type: 'AutoV1',
              hash: 'C7C95ADA',
            },
            {
              type: 'AutoV2',
              hash: '259DE9EC5E',
            },
            {
              type: 'SHA256',
              hash: '259DE9EC5E5B5D81AF3042A9B1490FE593A69E6226DBE6E029E0793B5942967B',
            },
            {
              type: 'CRC32',
              hash: '6C4254BE',
            },
            {
              type: 'BLAKE3',
              hash: '5EA5A07BAA042887ACA09900C92CBFD6A6783C6847986690970FE3551DB69821',
            },
            {
              type: 'AutoV3',
              hash: '34A008700A27',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 879,
        downloadCountAllTime: 3564,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 422,
        thumbsDownCountAllTime: 2,
      },
      posts: [
        {
          id: 2624879,
        },
        {
          id: 2641626,
        },
        {
          id: 2642146,
        },
        {
          id: 2643282,
        },
        {
          id: 2659932,
        },
        {
          id: 2668472,
        },
      ],
      hashes: ['259de9ec5e5b5d81af3042a9b1490fe593a69e6226dbe6e029e0793b5942967b'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 469973,
      modelId: 404154,
      name: 'v3.0',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: null,
      createdAt: '2024-04-26T21:43:16.152Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: {},
      status: 'Published',
      publishedAt: '2024-04-26T22:37:05.237Z',
      meta: {
        imageNsfw: 'None',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 25,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 388672,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL03.Hhqn.safetensors',
          sizeKB: 6775430.376953125,
          name: 'WAI-ANI-NSFW-PONYXL-03.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-08-13T18:22:48.384Z',
          modelVersionId: 469973,
          hashes: [
            {
              type: 'AutoV1',
              hash: '5F1AC6E5',
            },
            {
              type: 'AutoV2',
              hash: '00B8E6E752',
            },
            {
              type: 'SHA256',
              hash: '00B8E6E7527E51B17C7F4855A72B119E49FC96EA44CF4C31D2FEBFE78383C6D2',
            },
            {
              type: 'CRC32',
              hash: '02A2FCB6',
            },
            {
              type: 'BLAKE3',
              hash: 'F7AD89A8978F0465F1D7CC5410B79BFBECD376385C882F3ADAFBDC742B190C44',
            },
            {
              type: 'AutoV3',
              hash: 'AFF2CC1B352D',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 30,
        downloadCountAllTime: 2406,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 242,
        thumbsDownCountAllTime: 2,
      },
      posts: [
        {
          id: 2378138,
        },
        {
          id: 2388740,
        },
        {
          id: 2389154,
        },
        {
          id: 2389623,
        },
        {
          id: 2391012,
        },
      ],
      hashes: ['00b8e6e7527e51b17c7f4855a72b119e49fc96ea44cf4c31d2febfe78383c6d2'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 452526,
      modelId: 404154,
      name: 'v2.0',
      description:
        '<p><strong><em>Add VAE </em></strong></p><p><strong><em>quality improvement</em></strong></p><p>Recommended Setting</p><ul><li><p>Steps: 30</p></li><li><p>CFG scale: 7</p></li><li><p>Sampler: Euler a</p></li></ul><p>Positive Prompt</p><pre><code>score_9, score_8_up, score_7_up,</code></pre><p>Negative Prompt</p><pre><code>score_6,score_5,score_4, low quality, worst quality,blurry, lowres, bad anatomy, bad hands, missing fingers, 3d, monochrome, (censor), source_furry, source_pony, source_cartoon,</code></pre>',
      steps: null,
      epochs: null,
      clipSkip: null,
      createdAt: '2024-04-17T18:10:18.463Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: {},
      status: 'Published',
      publishedAt: '2024-04-17T18:38:41.091Z',
      meta: {
        imageNsfw: 'None',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 25,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 372126,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL02.nSo5.safetensors',
          sizeKB: 6775430.353515625,
          name: 'WAI-ANI-NSFW-PONYXL-02.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-08-13T18:28:25.143Z',
          modelVersionId: 452526,
          hashes: [
            {
              type: 'AutoV1',
              hash: '3EA6E148',
            },
            {
              type: 'AutoV2',
              hash: 'BEF14AAC0A',
            },
            {
              type: 'SHA256',
              hash: 'BEF14AAC0AB4A3938B369D0950F95FC4158CBCCDDD4890CE168B507BD8415592',
            },
            {
              type: 'CRC32',
              hash: '512B2131',
            },
            {
              type: 'BLAKE3',
              hash: 'F2B07498BC78DF82C4A8FDBD9FC3537002BFC954F3F6F7FDC18C2716AA7CB3C1',
            },
            {
              type: 'AutoV3',
              hash: '428FB69A90A8',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 15,
        downloadCountAllTime: 1617,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 215,
        thumbsDownCountAllTime: 1,
      },
      posts: [
        {
          id: 2203680,
        },
        {
          id: 2203955,
        },
        {
          id: 2204640,
        },
        {
          id: 2218507,
        },
        {
          id: 2218841,
        },
        {
          id: 2219224,
        },
        {
          id: 2277649,
        },
      ],
      hashes: ['bef14aac0ab4a3938b369d0950f95fc4158cbccddd4890ce168b507bd8415592'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
    {
      id: 450626,
      modelId: 404154,
      name: 'v1.0',
      description: null,
      steps: null,
      epochs: null,
      clipSkip: 2,
      createdAt: '2024-04-16T16:34:08.563Z',
      updatedAt: '2025-01-17T18:26:05.574Z',
      trainedWords: [],
      trainingStatus: null,
      trainingDetails: null,
      inaccurate: false,
      baseModel: 'Pony',
      baseModelType: 'Standard',
      earlyAccessEndsAt: null,
      earlyAccessConfig: {},
      status: 'Published',
      publishedAt: '2024-04-16T18:08:14.688Z',
      meta: {
        imageNsfw: 'None',
      },
      vaeId: null,
      settings: null,
      requireAuth: false,
      nsfwLevel: 21,
      uploadType: 'Created',
      usageControl: 'Download',
      files: [
        {
          id: 370429,
          url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/31176/waiANINSFWPONYXL.BOhA.safetensors',
          sizeKB: 6775430.384765625,
          name: 'WAI-ANI-NSFW-PONYXL.safetensors',
          type: 'Model',
          visibility: 'Public',
          metadata: {
            fp: 'fp16',
            size: 'pruned',
            format: 'SafeTensor',
          },
          pickleScanResult: 'Success',
          pickleScanMessage: 'No Pickle imports',
          virusScanResult: 'Success',
          virusScanMessage: null,
          scannedAt: '2024-08-13T18:28:59.987Z',
          modelVersionId: 450626,
          hashes: [
            {
              type: 'AutoV1',
              hash: '4EB6FD15',
            },
            {
              type: 'AutoV2',
              hash: '2C1212046F',
            },
            {
              type: 'SHA256',
              hash: '2C1212046FF5207C2B19EA4F68A1145BC7F81346D791C092F50F8FCD0A09E229',
            },
            {
              type: 'CRC32',
              hash: '46AA7A31',
            },
            {
              type: 'BLAKE3',
              hash: '83B06A7369DB56D32173236B250100D9CC9EA64EBA716DE90E1A229C3E3235C4',
            },
            {
              type: 'AutoV3',
              hash: 'B7CA9430A339',
            },
          ],
        },
      ],
      generationCoverage: null,
      recommendedResources: [],
      rank: {
        generationCountAllTime: 25,
        downloadCountAllTime: 750,
        ratingCountAllTime: 0,
        ratingAllTime: 0,
        thumbsUpCountAllTime: 90,
        thumbsDownCountAllTime: 0,
      },
      posts: [
        {
          id: 2184996,
        },
      ],
      hashes: ['2c1212046ff5207c2b19ea4f68a1145bc7f81346d791c092f50f8fcd0a09e229'],
      earlyAccessDeadline: null,
      canDownload: true,
      canGenerate: false,
    },
  ],
  selectedVersionId: 1295881,
  generationOptions: {
    includeEditingActions: true,
  },
  showModerationOptions: true,
  showPOIWarning: false,
  canReview: true,
};

export default function Test() {
  const [count, setCount] = useState(0);

  // // useEffect(() => {
  // //   throw new Error('custom error for testing');
  // // }, []);

  const theme = useMantineTheme();

  // useEffect(() => {
  //   dialogStore.trigger({
  //     component: LoginModal,
  //   });
  // }, []);

  return (
    <IsClient>
      {/* <div className="container flex items-center gap-2 pb-2">
        <span>{count}</span>
        <Button
          onClick={() => {
            setCount((c) => c + 1);
          }}
        >
          Counter
        </Button>
      </div>
      <ComponentWithSlots>
        <Content />
      </ComponentWithSlots> */}
      {/* <div className="container flex max-w-sm flex-col gap-3">
        <GenerationSettingsPopover>
          <Button>Popover</Button>
        </GenerationSettingsPopover>
        <Button
          onClick={() =>
            dialogStore.trigger({
              component: LoginModal,
            })
          }
        >
          Log in
        </Button>
        <Button
          onClick={() =>
            dialogStore.trigger({
              component: LoginModal,
              props: {
                message: 'You must be logged in to perform this action',
              },
            })
          }
        >
          Log in with alert
        </Button>
        <Example />
        <ExampleSelect />

        <ExamplePopover />
      </div> */}
      <ImagesAsPostsInfinite {...imagesAsPostsInfiniteProps} />
    </IsClient>
  );
}

function ViewDuplicateHashLinks() {
  const [state, setState] = useState<Record<string, string[]> | null>();

  function handleLoad(files: FileList) {
    const reader = new FileReader();
    reader.onload = function (e) {
      if (!reader.result) return;
      const result = reader.result
        .toString()
        .split('\r\n')
        .reduce<Record<string, string[]>>((acc, value) => {
          const [hash, links] = value.replaceAll('"', '').split(',');

          if (!links?.startsWith('http')) return acc;

          if (!acc[hash]) acc[hash] = [];
          for (const link of links.split(';')) {
            acc[hash] = [...new Set([...acc[hash], link.trim()])];
          }

          return acc;
        }, {});
      setState(result);
    };
    reader.readAsText(files[0]);
  }

  return (
    <div className="container">
      <Link href="/moderator/test?test=true">Test link</Link>
      {!state ? (
        <input
          type="file"
          onChange={(e) => {
            if (e.target.files) handleLoad(e.target.files);
          }}
        ></input>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Hash</th>
              <th>Links</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(state).map(([hash, values]) => (
              <tr key={hash}>
                <td>{hash}</td>
                <td>
                  <div className="flex flex-col">
                    {values.map((link, i) => (
                      <ModelVersionLink key={i} url={link} />
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

const useClickedStore = create<{
  clicked: Record<string, boolean>;
  setClicked: (value: string) => void;
}>()(
  persist(
    immer((set) => ({
      clicked: {},
      setClicked: (value) =>
        set((state) => {
          state.clicked[value] = true;
        }),
    })),
    { name: 'duplicate-hashes-clicked' }
  )
);

function ModelVersionLink({ url }: { url: string }) {
  const clicked = useClickedStore(useCallback((state) => state.clicked[url], [url]));
  const setClicked = useClickedStore((state) => state.setClicked);
  return (
    <Text
      component="a"
      variant="link"
      className="cursor-pointer"
      href={url}
      target="_blank"
      rel="noreferrer"
      color={clicked ? 'yellow' : undefined}
      onClick={() => setClicked(url)}
    >
      {url}
    </Text>
  );
}

import { Radio, RadioGroup } from '@headlessui/react';
import clsx from 'clsx';

const memoryOptions = [
  { name: '4 GB', inStock: true },
  { name: '8 GB', inStock: true },
  { name: '16 GB', inStock: true },
  { name: '32 GB', inStock: true },
  { name: '64 GB', inStock: true },
  { name: '128 GB', inStock: false },
];

function Example() {
  const [mem, setMem] = useState(memoryOptions[2]);

  return (
    <fieldset aria-label="Choose a memory option">
      <div className="flex items-center justify-between">
        <div className="text-sm/6 font-medium text-dark-9">RAM</div>
        {/* <a href="#" className="text-sm/6 font-medium text-blue-7 hover:text-blue-6">
          See performance specs
        </a> */}
      </div>

      <RadioGroup
        value={mem}
        onChange={setMem}
        className="mt-2 grid grid-cols-3 gap-3 sm:grid-cols-6"
      >
        {memoryOptions.map((option) => (
          <Radio
            key={option.name}
            value={option}
            disabled={!option.inStock}
            className={clsx(
              option.inStock
                ? 'cursor-pointer focus:outline-none'
                : 'cursor-not-allowed opacity-25',
              'flex items-center justify-center rounded-md  p-3 text-sm font-semibold uppercase ring-1  data-[checked]:text-white   data-[checked]:ring-0 data-[focus]:data-[checked]:ring-2 data-[focus]:ring-2 data-[focus]:ring-offset-2  sm:flex-1  [&:not([data-focus])]:[&:not([data-checked])]:ring-inset  ',
              'bg-white text-dark-9 ring-gray-4 hover:bg-gray-1 data-[checked]:bg-blue-5 data-[focus]:ring-blue-5 ',
              'dark:bg-dark-5 dark:text-white dark:ring-dark-4 dark:hover:bg-dark-4 dark:data-[checked]:bg-blue-8 dark:data-[focus]:ring-blue-8 '
            )}
          >
            {option.name}
          </Radio>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

import { Label, Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { IconCheck, IconSelector } from '@tabler/icons-react';
import ImagesAsPostsInfinite from '~/components/Image/AsPosts/ImagesAsPostsInfinite';

const people = [
  {
    id: 1,
    name: 'Wade Cooper',
    avatar:
      'https://images.unsplash.com/photo-1491528323818-fdd1faba62cc?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 2,
    name: 'Arlene Mccoy',
    avatar:
      'https://images.unsplash.com/photo-1550525811-e5869dd03032?ixlib=rb-1.2.1&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 3,
    name: 'Devon Webb',
    avatar:
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2.25&w=256&h=256&q=80',
  },
  {
    id: 4,
    name: 'Tom Cook',
    avatar:
      'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 5,
    name: 'Tanya Fox',
    avatar:
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 6,
    name: 'Hellen Schmidt',
    avatar:
      'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 7,
    name: 'Caroline Schultz',
    avatar:
      'https://images.unsplash.com/photo-1568409938619-12e139227838?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 8,
    name: 'Mason Heaney',
    avatar:
      'https://images.unsplash.com/photo-1531427186611-ecfd6d936c79?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 9,
    name: 'Claudie Smitham',
    avatar:
      'https://images.unsplash.com/photo-1584486520270-19eca1efcce5?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
  {
    id: 10,
    name: 'Emil Schaefer',
    avatar:
      'https://images.unsplash.com/photo-1561505457-3bcad021f8ee?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
  },
];

function ExampleSelect() {
  const [selected, setSelected] = useState(people[3]);

  return (
    <Listbox value={selected} onChange={setSelected}>
      <div className="relative mt-2">
        <ListboxButton
          className={clsx(
            'grid w-full cursor-default grid-cols-1 rounded-md py-1.5 pl-3 pr-2 text-left outline outline-1 -outline-offset-1 focus:outline focus:outline-2 focus:-outline-offset-2  sm:text-sm/6',
            'bg-white text-dark-9 outline-gray-4 focus:outline-blue-5',
            'dark:bg-dark-6 dark:text-dark-0 dark:outline-dark-4 dark:focus:outline-blue-8'
          )}
        >
          <span className="col-start-1 row-start-1 flex items-center gap-3 pr-6">
            {/* <img alt="" src={selected.avatar} className="size-5 shrink-0 rounded-full" /> */}
            <span className="block truncate">{selected.name}</span>
          </span>
          <IconSelector
            aria-hidden="true"
            className={clsx(
              'col-start-1 row-start-1 size-5 self-center justify-self-end sm:size-4',
              'text-gray-6'
            )}
          />
        </ListboxButton>

        <ListboxOptions
          transition
          anchor="bottom start"
          portal
          className={clsx(
            'z-10 mt-1 max-h-56 w-[var(--button-width)]  overflow-auto rounded-md py-1 text-base shadow-lg ring-1 ring-black/5 focus:outline-none data-[closed]:data-[leave]:opacity-0 data-[leave]:transition data-[leave]:duration-100 data-[leave]:ease-in sm:text-sm',
            'bg-white',
            'dark:bg-dark-6'
          )}
        >
          {people.map((person) => (
            <ListboxOption
              key={person.id}
              value={person}
              className={clsx(
                'group relative cursor-default select-none py-2 pl-3 pr-9 data-[focus]:outline-none',
                'text-dark-9 data-[focus]:bg-blue-5 data-[focus]:text-white',
                'dark:text-dark-0 dark:data-[focus]:bg-blue-8 '
              )}
            >
              <div className="flex items-center">
                {/* <img alt="" src={person.avatar} className="size-5 shrink-0 rounded-full" /> */}
                <span className="ml-3 block truncate font-normal group-data-[selected]:font-semibold">
                  {person.name}
                </span>
              </div>

              <span
                className={clsx(
                  'absolute inset-y-0 right-0 flex items-center pr-4 group-[&:not([data-selected])]:hidden ',
                  'text-blue-5 group-data-[focus]:text-white',
                  'dark:text-blue-8'
                )}
              >
                <IconCheck aria-hidden="true" className="size-5" />
              </span>
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}

import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';

function ExamplePopover() {
  return (
    <div className="flex w-full justify-center pt-20">
      <div className="flex gap-8">
        <div className="text-sm/6 font-semibold text-white/50">Products</div>
        <Popover>
          <PopoverButton className="block text-sm/6 font-semibold text-white/50 focus:outline-none data-[active]:text-white data-[hover]:text-white data-[focus]:outline-1 data-[focus]:outline-white">
            Solutions
          </PopoverButton>
          <PopoverPanel
            transition
            anchor="bottom"
            className="divide-y divide-white/5 rounded-xl bg-white/5 text-sm/6 transition duration-200 ease-in-out [--anchor-gap:var(--spacing-5)] data-[closed]:-translate-y-1 data-[closed]:opacity-0"
          >
            <div className="p-3">
              <a className="block rounded-lg px-3 py-2 transition hover:bg-white/5" href="#">
                <p className="font-semibold text-white">Insights</p>
                <p className="text-white/50">Measure actions your users take</p>
              </a>
              <a className="block rounded-lg px-3 py-2 transition hover:bg-white/5" href="#">
                <p className="font-semibold text-white">Automations</p>
                <p className="text-white/50">Create your own targeted content</p>
              </a>
              <a className="block rounded-lg px-3 py-2 transition hover:bg-white/5" href="#">
                <p className="font-semibold text-white">Reports</p>
                <p className="text-white/50">Keep track of your growth</p>
              </a>
            </div>
            <div className="p-3">
              <a className="block rounded-lg px-3 py-2 transition hover:bg-white/5" href="#">
                <p className="font-semibold text-white">Documentation</p>
                <p className="text-white/50">Start integrating products and tools</p>
              </a>
            </div>
          </PopoverPanel>
        </Popover>
        <div className="text-sm/6 font-semibold text-white/50">Pricing</div>
      </div>
    </div>
  );
}
