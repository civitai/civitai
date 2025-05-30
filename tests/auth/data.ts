const baseAuthPath = 'tests/auth';

export const testAuthData = {
  mod: {
    userId: 1,
    path: `${baseAuthPath}/mod.json`,
  },
  newbie: {
    userId: 2,
    path: `${baseAuthPath}/newbie.json`,
  },
  degen: {
    userId: 3,
    path: `${baseAuthPath}/degen.json`,
  },
  banned: {
    userId: 4,
    path: `${baseAuthPath}/banned.json`,
  },
  deleted: {
    userId: 5,
    path: `${baseAuthPath}/deleted.json`,
  },
  muted: {
    userId: 6,
    path: `${baseAuthPath}/muted.json`,
  },
};

export const authEmpty = { storageState: { cookies: [], origins: [] } };
export const authMod = { storageState: testAuthData.mod.path };
export const authNewbie = { storageState: testAuthData.newbie.path };
export const authDegen = { storageState: testAuthData.degen.path };
export const authBanned = { storageState: testAuthData.banned.path };
// export const authDeleted = { storageState: testAuthData.deleted.path };
export const authMuted = { storageState: testAuthData.muted.path };
