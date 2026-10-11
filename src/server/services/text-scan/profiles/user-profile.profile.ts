import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import {
  scamEligibleAuthors,
  scamSubject,
  scamTextFromHtml,
} from '~/server/services/text-scan/profiles/scam-text';

registerTextScanProfile({
  entityType: 'UserProfile',
  labels: ['scam'],
  load: async (userIds) => {
    const rows = await dbWrite.userProfile.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, bio: true, message: true, sfwBio: true, sfwMessage: true },
    });
    const eligible = await scamEligibleAuthors(rows.map((row) => row.userId));
    return new Map(
      rows
        .filter((row) => eligible.has(row.userId))
        .map((row) => [
          row.userId,
          scamSubject(row.userId, [
            { heading: 'Bio', text: scamTextFromHtml(row.bio) },
            { heading: 'Profile announcement', text: scamTextFromHtml(row.message) },
            { heading: 'Bio (SFW domain)', text: scamTextFromHtml(row.sfwBio) },
            {
              heading: 'Profile announcement (SFW domain)',
              text: scamTextFromHtml(row.sfwMessage),
            },
          ]),
        ])
    );
  },
});
