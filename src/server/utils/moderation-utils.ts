import nlp from 'compromise';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { fromJson } from '~/utils/json-helpers';
import { logToAxiom } from '~/server/logging/client';

const wordReplace = (word: string) => {
  return word
    .replace(/i/g, '[i|l|1]')
    .replace(/o/g, '[o|0]')
    .replace(/s/g, '[s|z]')
    .replace(/e/g, '[e|3]')
    .replace(/a/g, '[a|@]');
};

function adjustModWordBlocklist(word: string) {
  const doc = nlp(word);

  if (doc.nouns().length > 0) {
    const plural = nlp(word).nouns().toPlural().text();
    return [
      { re: new RegExp(`\\b${wordReplace(word)}\\b`, 'i'), word },
      { re: new RegExp(`\\b${wordReplace(plural)}\\b`, 'i'), word: plural },
    ];
  }

  if (doc.verbs().length > 0) {
    const past = nlp(word).verbs().toPastTense().text();
    const present = nlp(word).verbs().toPresentTense().text();
    const gerund = nlp(word).verbs().toGerund().text();
    // @ts-ignore
    const participle = nlp(word).verbs().toPastParticiple().text() as string;

    return [
      { re: new RegExp(`\\b${wordReplace(word)}\\b`, 'i'), word },
      { re: new RegExp(`\\b${wordReplace(past)}\\b`, 'i'), word: past },
      { re: new RegExp(`\\b${wordReplace(present)}\\b`, 'i'), word: present },
      { re: new RegExp(`\\b${wordReplace(gerund)}\\b`, 'i'), word: gerund },
      { re: new RegExp(`\\b${wordReplace(participle)}\\b`, 'i'), word: participle },
    ];
  }

  return [{ re: new RegExp(`\\b${wordReplace(word)}\\b`, 'i'), word }];
}

export type ModWordBlocklist = Array<{ re: RegExp; word: string }>;

export async function getModWordBlocklist() {
  const wordlists =
    (await sysRedis
      .hGet(REDIS_SYS_KEYS.ENTITY_MODERATION.BASE, REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.WORDLISTS)
      .then((data) => (data ? fromJson<string[]>(data) : ([] as string[])))
      .catch(() => [] as string[])) ?? ([] as string[]);

  const blocklist = [] as ReturnType<typeof adjustModWordBlocklist>[];
  for (const wordlist of wordlists) {
    const words = await sysRedis.packed.hGet<string[]>(
      REDIS_SYS_KEYS.ENTITY_MODERATION.WORDLISTS.WORDS,
      wordlist
    );
    if (words) {
      for (const word of words) {
        blocklist.push(adjustModWordBlocklist(word));
      }
    } else {
      logToAxiom({
        name: 'wordlists',
        type: 'warning',
        message: `wordlist ${wordlist} not found`,
      }).catch();
    }
  }

  return blocklist.flat();
}

export async function getModURLBlocklist() {
  const urllists =
    (await sysRedis
      .hGet(REDIS_SYS_KEYS.ENTITY_MODERATION.BASE, REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.URLLISTS)
      .then((data) => (data ? fromJson<string[]>(data) : ([] as string[])))
      .catch(() => [] as string[])) ?? ([] as string[]);

  const blocklist = [] as ReturnType<typeof adjustModWordBlocklist>[];
  for (const urllist of urllists) {
    const urls = await sysRedis.packed.hGet<string[]>(
      REDIS_SYS_KEYS.ENTITY_MODERATION.WORDLISTS.URLS,
      urllist
    );
    if (urls) {
      for (const url of urls) {
        blocklist.push([{ re: new RegExp(`.*${url}.*`, 'i'), word: url }]);
      }
    } else {
      logToAxiom({
        name: 'wordlists',
        type: 'warning',
        message: `urllist ${urllist} not found`,
      }).catch();
    }
  }

  return blocklist.flat();
}

export async function getBlocklists() {
  const useBlocklist =
    (await sysRedis
      .hGet(
        REDIS_SYS_KEYS.ENTITY_MODERATION.BASE,
        REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.RUN_WORDLISTS
      )
      .then((data) => (data ? (JSON.parse(data) as boolean) : false))
      .catch(() => false)) ?? false;

  if (useBlocklist) {
    const modWordBlocklist = await getModWordBlocklist();
    const modURLBlocklist = await getModURLBlocklist();
    if (!modWordBlocklist.length && !modURLBlocklist.length) {
      throw new Error('No blocklists found');
    }
    return { use: true, modWordBlocklist, modURLBlocklist };
  } else {
    return {
      use: false,
      modWordBlocklist: [] as ModWordBlocklist,
      modURLBlocklist: [] as ModWordBlocklist,
    };
  }
}
