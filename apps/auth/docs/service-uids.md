# Service uids

Each `services` entry in `OAUTH_EXCHANGE_RESOURCES` carries a `uid`. A service token carries it as `civitai_uid`, and
introspection answers with it. A uid names one service everywhere, so every allocation is recorded here.

- A uid is an int32 of -1000 or below. The registry's validation enforces both.
- Never reuse a uid, including one whose service has been retired.
- Only hub admins set uids, in the deploy config. Add the row here in the same change.

| uid   | app                                                        | since      |
| ----- | ---------------------------------------------------------- | ---------- |
| -1001 | image cacher                                               | 2026-11-15 |
| -1101 | app-index-go service identity on the registry-exp resource | 2026-11-22 |
