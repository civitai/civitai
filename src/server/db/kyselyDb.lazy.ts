// `kyselyDb` builds its pg pools when the module loads. Services that only reach Kysely behind a
// default-off flag load it on first use instead, so importing them builds no pool — many test
// graphs import these services with an `~/env/server` mock that carries no database URL.
export const loadKyselyDb = () => import('~/server/db/kyselyDb');
