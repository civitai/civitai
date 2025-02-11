const basePath = 'tests/auth';

export const testAuthData = {
  mod: {
    userId: 1,
    path: `${basePath}/mod.json`,
  },
  newbie: {
    userId: 2,
    path: `${basePath}/newbie.json`,
  },
  degen: {
    userId: 3,
    path: `${basePath}/degen.json`,
  },
  banned: {
    userId: 4,
    path: `${basePath}/banned.json`,
  },
  deleted: {
    userId: 5,
    path: `${basePath}/deleted.json`,
  },
  muted: {
    userId: 6,
    path: `${basePath}/muted.json`,
  },
};

export const authEmpty = { storageState: { cookies: [], origins: [] } };
export const authMod = { storageState: testAuthData.mod.path };
export const authNewbie = { storageState: testAuthData.newbie.path };
export const authDegen = { storageState: testAuthData.degen.path };
export const authBanned = { storageState: testAuthData.banned.path };
// export const authDeleted = { storageState: testAuthData.deleted.path };
export const authMuted = { storageState: testAuthData.muted.path };
