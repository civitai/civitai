export {};
// import {
//   getModerationTags,
//   getSystemHiddenTags,
//   getSystemTags,
// } from '~/server/services/system-cache';
// import {
//   getHiddenImagesForUser,
//   getHiddenModelsForUser,
//   getHiddenTagsForUser,
//   getHiddenTagsForUser2,
//   getHiddenUsersForUser,
// } from '~/server/services/user-cache.service';
// import { AuthedEndpoint, PublicEndpoint } from '~/server/utils/endpoint-helpers';
// import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

// const getModerated = async () => {
//   const moderated = await getModerationTags();
//   return moderated.map((x) => x.id);
// };

// export default PublicEndpoint(
//   async function handler(req, res) {
//     const session = await getServerAuthSession({ req, res });
//     const user = session?.user;
//     const userId = session?.user?.id ?? -1;
//     const showNsfw = session?.user?.showNsfw ?? false;

//     switch (req.method) {
//       case 'GET':
//         if (!user) {
//           const [moderated, systemHidden] = await Promise.all([
//             getModerated(),
//             getSystemHiddenTags(),
//           ]);
//           return res.status(200).json({ moderated, systemHidden });
//         } else {
//           const [moderated, tags, models, images, users] = await Promise.all([
//             getModerated(),
//             getHiddenTagsForUser2({ userId }),
//             getHiddenModelsForUser({ userId }),
//             getHiddenImagesForUser({ userId }),
//             getHiddenUsersForUser({ userId }),
//           ]);
//           return res.status(200).json({ moderated, tags, models, images, users });
//         }
//       case 'POST':
//         break;
//     }

//     res.status(200);
//   },
//   ['GET', 'POST']
// );
