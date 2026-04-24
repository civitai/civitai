# Top 100 Collections by All-Time Followers — Homepage Featuring Candidates

Generated: 2026-04-23T21:10:01.483Z

Source: Postgres read-replica via `postgres-query` skill. Filter: `read='Public'`, `availability='Public'`, owner <> civitai (id=-1). Ordered by `CollectionStat.followerCountAllTime` DESC.

**Sampling**: up to 5 most-recent ACCEPTED items per collection; item nsfwLevel pulled from the type-appropriate table (Model/Image/Post/Article).

**nsfwLevel is a bitwise flag**: PG=1, PG13=2, R=4, X=8, XXX=16, Blocked=32. Collection-level nsfwLevel aggregates across all items — e.g. a huge contest collection can have nsfwLevel=29 (PG+R+X+XXX) even if 99% of items are PG, because a handful of R/X submissions are included. **The per-item sample is a far better signal for homepage suitability than the collection aggregate.**

## Flag legend

- ⚠️ **flagged**: at least half of the 5 sampled items are R or above
- (blank): sample is majority PG/PG13 — plausible homepage candidate, still cover-image check recommended

## Top 100 Ranking

| # | Collection | Owner | Type | Followers | Items | Coll nsfwLevel | Sample (5 most recent) | Flag |
|--:|:----------|:------|:-----|----------:|------:|:--------------|:-----------------------|:---:|
| 1 | [Beggars Board](https://civitai.com/collections/3870938) | JustMaier | Image | 10112 | 13447 | 29 (PG+R+X+XXX) | all PG/PG13 (5) |  |
| 2 | [Nova Series](https://civitai.com/collections/9677464) | Crody | Model | 6966 | 24 | 29 (PG+R+X+XXX) | all NSFW (5): 2 X, 3 XXX | ⚠️ |
| 3 | [PornMaster-Pro](https://civitai.com/collections/6596928) | iamddtla | Model | 5754 | 61 | 28 (R+X+XXX) | mixed: 5 XXX, 4 Blocked | ⚠️ |
| 4 | [Smooth Collection](https://civitai.com/collections/7237154) | DigitalPastel | Model | 4904 | 17 | 29 (PG+R+X+XXX) | mixed: 1 X, 4 XXX, 1 Blocked | ⚠️ |
| 5 | [Models](https://civitai.com/collections/8501873) | janxd | Model | 4493 | 8 | 29 (PG+R+X+XXX) | mixed: 2 PG, 1 R, 2 XXX | ⚠️ |
| 6 | [METAFILM Ai Models](https://civitai.com/collections/6686272) | AiMetatron | Model | 3935 | 22 | 29 (PG+R+X+XXX) | all NSFW (5): 1 PG, 4 XXX, 1 Blocked | ⚠️ |
| 7 | [Erotic Video Collection (N)SFW](https://civitai.com/collections/10505430) | arkinson | Image | 3439 | 2340 | 29 (PG+R+X+XXX) | mixed: 1 PG13, 2 R, 2 X | ⚠️ |
| 8 | [Reij's ~ merged Checkpoints ](https://civitai.com/collections/4543901) | reijlita | Model | 2945 | 68 | 29 (PG+R+X+XXX) | all NSFW (5): 2 R, 3 X | ⚠️ |
| 9 | [Shiiro's Illustrious loras](https://civitai.com/collections/6734784) | Shiiro0 | Model | 2910 | 188 | 29 (PG+R+X+XXX) | mixed: 1 PG, 1 PG+PG13, 3 R | ⚠️ |
| 10 | [DaSiWa Collection](https://civitai.com/collections/13277112) | darksidewalker | Model | 2866 | 14 | 29 (PG+R+X+XXX) | mixed: 2 PG13, 1 PG+PG13, 1 R, 1 XXX |  |
| 11 | [Outstanding AI-Art ](https://civitai.com/collections/906833) | ArtifyAI | Image | 2516 | 20046 | 29 (PG+R+X+XXX) | all PG/PG13 (5) |  |
| 12 | [Legendary Landscapes Contest](https://civitai.com/collections/1044792) | Faeia | Image | 2494 | 9564 | 29 (PG+R+X+XXX) | all PG (5) |  |
| 13 | [Halloween Contest - Images](https://civitai.com/collections/5250356) | Faeia | Image | 2304 | 14355 | 29 (PG+R+X+XXX) | all PG (5) |  |
| 14 | [Illustrious XL - STYLES](https://civitai.com/collections/8304426) | YeiYeiArt | Model | 2199 | 69 | 29 (PG+R+X+XXX) | mixed: 2 PG+PG13, 3 R | ⚠️ |
| 15 | [Project Odyssey - Season 2](https://civitai.com/collections/6503138) | Matty_verse | Image | 2197 | 4507 | 29 (PG+R+X+XXX) | all PG/PG13 (5) |  |
| 16 | [Fantastic AI-Art ](https://civitai.com/collections/4192940) | Castr0 | Image | 1930 | 12170 | 29 (PG+R+X+XXX) | all PG/PG13 (5) |  |
| 17 | [Elemental Extravaganza Contest](https://civitai.com/collections/1495513) | Faeia | Image | 1903 | 7962 | 29 (PG+R+X+XXX) | all PG (5) |  |
| 18 | [Waifu Concepts](https://civitai.com/collections/11650723) | Charbel | Model | 1877 | 142 | 28 (R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 19 | [Maintenance Mode Contest](https://civitai.com/collections/3586545) | Faeia | Image | 1815 | 4507 | 29 (PG+R+X+XXX) | all PG (5) |  |
| 20 | [Shrekman Hentai Loras](https://civitai.com/collections/5978555) | Shrekman17 | Model | 1776 | 156 | 29 (PG+R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 21 | [In the Nude (NSFW)](https://civitai.com/collections/4976869) | PervyCat | Image | 1727 | 2353 | 29 (PG+R+X+XXX) | all NSFW (5): 1 X, 4 XXX | ⚠️ |
| 22 | [Celtic Creations Contest](https://civitai.com/collections/289584) | Faeia | Image | 1591 | 5656 | 29 (PG+R+X+XXX) | all PG/PG13 (5) |  |
| 23 | [Halloween Contest 2025](https://civitai.com/collections/13359482) | Faeia | Image | 1564 | 11350 | 1 (PG) | all PG/PG13 (5) |  |
| 24 | [Monster Girl Encyclopedia](https://civitai.com/collections/10832524) | Alfheimr | Model | 1532 | 210 | 29 (PG+R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 25 | [Rendered Romance Contest](https://civitai.com/collections/7545059) | Faeia | Image | 1507 | 7100 | 29 (PG+R+X+XXX) | all PG (5) |  |
| 26 | [Citron Styles](https://civitai.com/collections/10766871) | CitronLegacy | Model | 1413 | 202 | 29 (PG+R+X+XXX) | mixed: 1 R |  |
| 27 | [My Models](https://civitai.com/collections/8161130) | K112 | Model | 1371 | 244 | 29 (PG+R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 28 | [Vixon's Illustrious Styles](https://civitai.com/collections/6453691) | freckledvixon | Model | 1352 | 289 | 29 (PG+R+X+XXX) | mixed: 1 PG+PG13, 4 R | ⚠️ |
| 29 | [Failed Generations Contest](https://civitai.com/collections/162548) | Faeia | Image | 1325 | 2353 | 29 (PG+R+X+XXX) | all PG (5) |  |
| 30 | [Text-tacular Showdown](https://civitai.com/collections/4850901) | Faeia | Image | 1312 | 4522 | 29 (PG+R+X+XXX) | all PG (5) |  |
| 31 | [Winter Festival Contest 2025](https://civitai.com/collections/14147890) | Faeia | Image | 1273 | 5359 | 1 (PG) | all PG (5) |  |
| 32 | [Illustrious Styles by Guy90](https://civitai.com/collections/6032191) | guy90 | Model | 1258 | 123 | 29 (PG+R+X+XXX) | all NSFW (5): 1 R, 2 X, 2 XXX | ⚠️ |
| 33 | [Artful Beauty (N)SFW](https://civitai.com/collections/6640851) | roxin282 | Image | 1218 | 4752 | 29 (PG+R+X+XXX) | all PG/PG13 (5) |  |
| 34 | [The Precious.Art](https://civitai.com/collections/7162761) | fussypixel | Image | 1187 | 14560 | 29 (PG+R+X+XXX) | mixed: 4 PG, 1 R |  |
| 35 | [photography style-摄影风格](https://civitai.com/collections/161109) | iamddtla | Model | 1146 | 37 | 29 (PG+R+X+XXX) | mixed: 5 XXX, 3 Blocked | ⚠️ |
| 36 | [I ♥️ your pic ](https://civitai.com/collections/6473820) | Snilek_Robotka | Image | 1114 | 20386 | 29 (PG+R+X+XXX) | all PG/PG13 (5) |  |
| 37 | [Mai Character H Anime](https://civitai.com/collections/11464483) | 00x09901 | Model | 1087 | 252 | 29 (PG+R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 38 | [Models by DR34MSC4PE](https://civitai.com/collections/11986514) | ERA5ER | Model | 1056 | 13 | 29 (PG+R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 39 | [Style for Illustrious](https://civitai.com/collections/6547561) | sxus_Sw | Model | 1054 | 184 | 29 (PG+R+X+XXX) | all NSFW (5): 5 XXX | ⚠️ |
| 40 | [Other porn-其它色情](https://civitai.com/collections/161142) | iamddtla | Model | 1016 | 25 | 28 (R+X+XXX) | mixed: 5 XXX, 4 Blocked | ⚠️ |
| 41 | [Artist style](https://civitai.com/collections/7633447) | King_Dong | Model | 987 | 170 | 29 (PG+R+X+XXX) | mixed: 2 PG+PG13, 3 R | ⚠️ |
| 42 | [Haiper + Civitai Video Contest](https://civitai.com/collections/5861243) | theally | Image | 978 | 1728 | 29 (PG+R+X+XXX) | all PG (5) |  |
| 43 | [Pokemon Characters](https://civitai.com/collections/261) | CitronLegacy | Model | 971 | 232 | 29 (PG+R+X+XXX) | all NSFW (5): 4 R, 1 X | ⚠️ |
| 44 | [AIDMA Loras](https://civitai.com/collections/6414297) | AIDigitalMediaAgency | Model | 964 | 60 | 29 (PG+R+X+XXX) | mixed: 3 PG, 2 X |  |
| 45 | [Unreal Beauty (NSFW) ](https://civitai.com/collections/7334867) | VigorousMaximus | Image | 956 | 366 | 29 (PG+R+X+XXX) | all NSFW (5): 1 R, 4 X | ⚠️ |
| 46 | [Commissions](https://civitai.com/collections/140814) | nochekaiser881 | Model | 926 | 1901 | 29 (PG+R+X+XXX) | mixed: 2 PG, 2 PG+PG13, 1 XXX, 1 Blocked |  |
| 47 | [Artist Styles (NSFW)](https://civitai.com/collections/857547) | PulenKompot | Model | 895 | 72 | 29 (PG+R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 48 | [Arknights ALL](https://civitai.com/collections/7515143) | robertlu1021 | Model | 889 | 281 | 29 (PG+R+X+XXX) | all PG/PG13 (5) |  |
| 49 | [Umamusume in game style 3D](https://civitai.com/collections/10286991) | denny208 | Model | 888 | 139 | 29 (PG+R+X+XXX) | mixed: 1 PG, 4 XXX, 4 Blocked | ⚠️ |
| 50 | [Sexy Clothes](https://civitai.com/collections/11464359) | 00x09901 | Model | 875 | 201 | 28 (R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 51 | [Artist Style for PDXL/ILXL](https://civitai.com/collections/7284511) | Cell1310 | Model | 872 | 49 | 29 (PG+R+X+XXX) | all NSFW (5): 5 XXX | ⚠️ |
| 52 | [Yu-Gi-Oh ](https://civitai.com/collections/6349867) | Sqquirtle0007 | Model | 865 | 356 | 29 (PG+R+X+XXX) | all NSFW (5): 2 R, 3 XXX | ⚠️ |
| 53 | [Best of Sexy / Nude / Sex](https://civitai.com/collections/5369632) | ? | Image | 858 | 1512 | 29 (PG+R+X+XXX) | all NSFW (5): 1 X, 4 XXX | ⚠️ |
| 54 | [Female Model Lora](https://civitai.com/collections/9987134) | Midnightkidnaper | Model | 843 | 50 | 0 (Unrated) | mixed: 1 R, 4 XXX, 4 Blocked | ⚠️ |
| 55 | [Styles](https://civitai.com/collections/11175552) | KojiroNsfw | Model | 832 | 364 | 29 (PG+R+X+XXX) | all NSFW (5): 1 R, 1 X, 3 XXX | ⚠️ |
| 56 | [PornMaster-Anime](https://civitai.com/collections/6597372) | iamddtla | Model | 827 | 27 | 28 (R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 57 | [Movie Still Styles](https://civitai.com/collections/5168803) | ArsMachina | Model | 821 | 32 | 29 (PG+R+X+XXX) | mixed: 2 PG+PG13, 3 R | ⚠️ |
| 58 | [Illustration](https://civitai.com/collections/8044351) | Adel_AI | Model | 821 | 87 | 29 (PG+R+X+XXX) | all NSFW (5): 3 R, 2 X | ⚠️ |
| 59 | [Project Odyssey - Season 1](https://civitai.com/collections/2334016) | Matty_verse | Image | 807 | 1263 | 29 (PG+R+X+XXX) | all PG (5) |  |
| 60 | [URPM](https://civitai.com/collections/5013882) | saftle | Model | 773 | 2 | 28 (R+X+XXX) | mixed: 2 XXX, 2 Blocked | ⚠️ |
| 61 | [Niji style (By zoropaton)](https://civitai.com/collections/8196839) | Zoropaton | Model | 771 | 6 | 29 (PG+R+X+XXX) | mixed: 1 PG, 1 PG+PG13, 2 R, 1 XXX | ⚠️ |
| 62 | [MILFs](https://civitai.com/collections/8750684) | magnifique | Model | 768 | 139 | 29 (PG+R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 63 | [Civitai Flux Training Contest](https://civitai.com/collections/3991102) | Faeia | Model | 767 | 1365 | 29 (PG+R+X+XXX) | mixed: 2 PG, 2 PG+PG13, 1 R |  |
| 64 | [Fantasy Sex Concept Collection](https://civitai.com/collections/5211376) | Shrekman17 | Model | 751 | 28 | 28 (R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 65 | [Vixon's Pony Styles](https://civitai.com/collections/5597546) | freckledvixon | Model | 746 | 419 | 29 (PG+R+X+XXX) | mixed: 1 PG, 1 PG+PG13, 1 R, 2 X | ⚠️ |
| 66 | [Something Special](https://civitai.com/collections/13831379) | Cinnadust | Image | 732 | 2622 | 1 (PG) | all PG/PG13 (5) |  |
| 67 | [Valentine's Contest Images](https://civitai.com/collections/191639) | Faeia | Image | 721 | 1663 | 29 (PG+R+X+XXX) | all PG/PG13 (5) |  |
| 68 | [Styles](https://civitai.com/collections/11600880) | fr0p | Model | 720 | 378 | 29 (PG+R+X+XXX) | mixed: 1 R, 3 XXX | ⚠️ |
| 69 | [Styles - Human](https://civitai.com/collections/11792767) | toghashie441 | Model | 718 | 381 | 29 (PG+R+X+XXX) | mixed: 2 X, 2 XXX | ⚠️ |
| 70 | [Pony: People's Works](https://civitai.com/collections/8769046) | Dajiejiekong | Model | 710 | 7 | 29 (PG+R+X+XXX) | all NSFW (3): 1 R, 2 X | ⚠️ |
| 71 | [Zenless Zone Zero](https://civitai.com/collections/8537793) | Hoseki | Model | 702 | 22 | 29 (PG+R+X+XXX) | mixed: 5 XXX, 1 Blocked | ⚠️ |
| 72 | [Intimate/Racy Clothing](https://civitai.com/collections/14943175) | freckledvixon | Model | 701 | 493 | 29 (PG+R+X+XXX) | mixed: 1 PG+PG13, 3 R, 1 X | ⚠️ |
| 73 | [Workflows](https://civitai.com/collections/12410838) | Legendaer | Model | 682 | 9 | 29 (PG+R+X+XXX) | mixed: 2 PG, 2 R, 1 XXX | ⚠️ |
| 74 | [18+](https://civitai.com/collections/8296175) | Fasd800 | Model | 676 | 332 | 29 (PG+R+X+XXX) | mixed: 1 PG, 1 PG13, 1 PG+PG13, 2 R |  |
| 75 | [My tools](https://civitai.com/collections/8274233) | reakaakasky | Model | 668 | 14 | 29 (PG+R+X+XXX) | all PG/PG13 (5) |  |
| 76 | [Perfect Sex positions -S.P](https://civitai.com/collections/5391207) | sarahpeterson | Model | 654 | 172 | 28 (R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 77 | [Year of the Snake Collection](https://civitai.com/collections/7194213) | Faeia | Model | 654 | 339 | 29 (PG+R+X+XXX) | all PG (5) |  |
| 78 | [TeeKay's Titty Time](https://civitai.com/collections/6108077) | TeeKay | Model | 642 | 21 | 28 (R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 79 | [BDSM](https://civitai.com/collections/11580359) | 00x09901 | Model | 629 | 24 | 28 (R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 80 | [Asian Mix](https://civitai.com/collections/6360856) | hinablue | Model | 618 | 16 | 29 (PG+R+X+XXX) | all NSFW (5): 5 X | ⚠️ |
| 81 | [Real Pussy](https://civitai.com/collections/5047) | Lucifie | Model | 618 | 6 | 28 (R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 82 | [Lunar Contest Images](https://civitai.com/collections/191629) | Faeia | Image | 615 | 1474 | 29 (PG+R+X+XXX) | all PG/PG13 (5) |  |
| 83 | [Konan's Illustrious/Noob Style](https://civitai.com/collections/9834506) | Konan | Model | 601 | 138 | 29 (PG+R+X+XXX) | all NSFW (5): 4 R, 1 X | ⚠️ |
| 84 | [Furry Concepts](https://civitai.com/collections/96079) | BeerYeen | Model | 599 | 32 | 29 (PG+R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 85 | [NSFW pose collection](https://civitai.com/collections/9156640) | KegawaX | Model | 598 | 34 | 28 (R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 86 | [BDSM、sex toys-性虐待、性玩具](https://civitai.com/collections/161131) | iamddtla | Model | 597 | 21 | 28 (R+X+XXX) | mixed: 5 XXX, 4 Blocked | ⚠️ |
| 87 | [Taimanin girls](https://civitai.com/collections/7116526) | DanMogren | Model | 595 | 92 | 28 (R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 88 | [Pokedex](https://civitai.com/collections/23688) | CitronLegacy | Model | 594 | 264 | 29 (PG+R+X+XXX) | mixed: 4 PG, 1 R |  |
| 89 | [Recommended Collection](https://civitai.com/collections/8967832) | 81187 | Model | 586 | 172 | 0 (Unrated) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 90 | [[STYLES]](https://civitai.com/collections/7286451) | Praelatus | Model | 582 | 119 | 29 (PG+R+X+XXX) | all NSFW (5): 2 X, 3 XXX | ⚠️ |
| 91 | [Custom Styles](https://civitai.com/collections/3539664) | ArsMachina | Model | 582 | 68 | 29 (PG+R+X+XXX) | mixed: 2 PG, 2 PG+PG13, 1 X |  |
| 92 | [Disney - Illustrious XL -](https://civitai.com/collections/7446647) | YeiYeiArt | Model | 581 | 26 | 29 (PG+R+X+XXX) | mixed: 1 PG, 3 PG+PG13, 1 R |  |
| 93 | [The Downtime Doodles Contest](https://civitai.com/collections/12123326) | theally | Image | 580 | 1055 | 1 (PG) | all PG (5) |  |
| 94 | [Styles](https://civitai.com/collections/5954571) | DuramenoAFK | Model | 575 | 59 | 29 (PG+R+X+XXX) | all NSFW (5): 5 XXX | ⚠️ |
| 95 | [Freelance Artists Styles](https://civitai.com/collections/10807226) | SageWolf | Model | 565 | 147 | 29 (PG+R+X+XXX) | mixed: 1 X, 4 XXX, 4 Blocked | ⚠️ |
| 96 | [Fate Grand Order XL](https://civitai.com/collections/986066) | neclordx | Model | 564 | 167 | 29 (PG+R+X+XXX) | mixed: 1 PG, 2 PG+PG13, 1 X, 1 XXX |  |
| 97 | [majicFlus lora collection](https://civitai.com/collections/7047551) | Merjic | Model | 561 | 20 | 29 (PG+R+X+XXX) | mixed: 1 PG, 2 R, 2 X | ⚠️ |
| 98 | [Vidu x Civitai Contest](https://civitai.com/collections/9979111) | Faeia | Image | 561 | 1669 | 29 (PG+R+X+XXX) | all PG/PG13 (5) |  |
| 99 | [Well Dressed Futas](https://civitai.com/collections/5291818) | DarkModeOP | Model | 557 | 20 | 28 (R+X+XXX) | mixed: 5 XXX, 5 Blocked | ⚠️ |
| 100 | [Civitai World Morph Collection](https://civitai.com/collections/2930699) | Faeia | Model | 556 | 608 | 29 (PG+R+X+XXX) | mixed: 2 PG, 2 PG+PG13, 1 R |  |

## Candidate shortlist — sample is majority PG/PG13 (38)

These are the homepage-plausible picks. Still confirm the collection cover image and spot-check a wider slice before featuring.

| # | Collection | Owner | Type | Followers | Items | Sample |
|--:|:----------|:------|:-----|----------:|------:|:------|
| 1 | [Beggars Board](https://civitai.com/collections/3870938) | JustMaier | Image | 10112 | 13447 | all PG/PG13 (5) |
| 10 | [DaSiWa Collection](https://civitai.com/collections/13277112) | darksidewalker | Model | 2866 | 14 | mixed: 2 PG13, 1 PG+PG13, 1 R, 1 XXX |
| 11 | [Outstanding AI-Art ](https://civitai.com/collections/906833) | ArtifyAI | Image | 2516 | 20046 | all PG/PG13 (5) |
| 12 | [Legendary Landscapes Contest](https://civitai.com/collections/1044792) | Faeia | Image | 2494 | 9564 | all PG (5) |
| 13 | [Halloween Contest - Images](https://civitai.com/collections/5250356) | Faeia | Image | 2304 | 14355 | all PG (5) |
| 15 | [Project Odyssey - Season 2](https://civitai.com/collections/6503138) | Matty_verse | Image | 2197 | 4507 | all PG/PG13 (5) |
| 16 | [Fantastic AI-Art ](https://civitai.com/collections/4192940) | Castr0 | Image | 1930 | 12170 | all PG/PG13 (5) |
| 17 | [Elemental Extravaganza Contest](https://civitai.com/collections/1495513) | Faeia | Image | 1903 | 7962 | all PG (5) |
| 19 | [Maintenance Mode Contest](https://civitai.com/collections/3586545) | Faeia | Image | 1815 | 4507 | all PG (5) |
| 22 | [Celtic Creations Contest](https://civitai.com/collections/289584) | Faeia | Image | 1591 | 5656 | all PG/PG13 (5) |
| 23 | [Halloween Contest 2025](https://civitai.com/collections/13359482) | Faeia | Image | 1564 | 11350 | all PG/PG13 (5) |
| 25 | [Rendered Romance Contest](https://civitai.com/collections/7545059) | Faeia | Image | 1507 | 7100 | all PG (5) |
| 26 | [Citron Styles](https://civitai.com/collections/10766871) | CitronLegacy | Model | 1413 | 202 | mixed: 1 R |
| 29 | [Failed Generations Contest](https://civitai.com/collections/162548) | Faeia | Image | 1325 | 2353 | all PG (5) |
| 30 | [Text-tacular Showdown](https://civitai.com/collections/4850901) | Faeia | Image | 1312 | 4522 | all PG (5) |
| 31 | [Winter Festival Contest 2025](https://civitai.com/collections/14147890) | Faeia | Image | 1273 | 5359 | all PG (5) |
| 33 | [Artful Beauty (N)SFW](https://civitai.com/collections/6640851) | roxin282 | Image | 1218 | 4752 | all PG/PG13 (5) |
| 34 | [The Precious.Art](https://civitai.com/collections/7162761) | fussypixel | Image | 1187 | 14560 | mixed: 4 PG, 1 R |
| 36 | [I ♥️ your pic ](https://civitai.com/collections/6473820) | Snilek_Robotka | Image | 1114 | 20386 | all PG/PG13 (5) |
| 42 | [Haiper + Civitai Video Contest](https://civitai.com/collections/5861243) | theally | Image | 978 | 1728 | all PG (5) |
| 44 | [AIDMA Loras](https://civitai.com/collections/6414297) | AIDigitalMediaAgency | Model | 964 | 60 | mixed: 3 PG, 2 X |
| 46 | [Commissions](https://civitai.com/collections/140814) | nochekaiser881 | Model | 926 | 1901 | mixed: 2 PG, 2 PG+PG13, 1 XXX, 1 Blocked |
| 48 | [Arknights ALL](https://civitai.com/collections/7515143) | robertlu1021 | Model | 889 | 281 | all PG/PG13 (5) |
| 59 | [Project Odyssey - Season 1](https://civitai.com/collections/2334016) | Matty_verse | Image | 807 | 1263 | all PG (5) |
| 63 | [Civitai Flux Training Contest](https://civitai.com/collections/3991102) | Faeia | Model | 767 | 1365 | mixed: 2 PG, 2 PG+PG13, 1 R |
| 66 | [Something Special](https://civitai.com/collections/13831379) | Cinnadust | Image | 732 | 2622 | all PG/PG13 (5) |
| 67 | [Valentine's Contest Images](https://civitai.com/collections/191639) | Faeia | Image | 721 | 1663 | all PG/PG13 (5) |
| 74 | [18+](https://civitai.com/collections/8296175) | Fasd800 | Model | 676 | 332 | mixed: 1 PG, 1 PG13, 1 PG+PG13, 2 R |
| 75 | [My tools](https://civitai.com/collections/8274233) | reakaakasky | Model | 668 | 14 | all PG/PG13 (5) |
| 77 | [Year of the Snake Collection](https://civitai.com/collections/7194213) | Faeia | Model | 654 | 339 | all PG (5) |
| 82 | [Lunar Contest Images](https://civitai.com/collections/191629) | Faeia | Image | 615 | 1474 | all PG/PG13 (5) |
| 88 | [Pokedex](https://civitai.com/collections/23688) | CitronLegacy | Model | 594 | 264 | mixed: 4 PG, 1 R |
| 91 | [Custom Styles](https://civitai.com/collections/3539664) | ArsMachina | Model | 582 | 68 | mixed: 2 PG, 2 PG+PG13, 1 X |
| 92 | [Disney - Illustrious XL -](https://civitai.com/collections/7446647) | YeiYeiArt | Model | 581 | 26 | mixed: 1 PG, 3 PG+PG13, 1 R |
| 93 | [The Downtime Doodles Contest](https://civitai.com/collections/12123326) | theally | Image | 580 | 1055 | all PG (5) |
| 96 | [Fate Grand Order XL](https://civitai.com/collections/986066) | neclordx | Model | 564 | 167 | mixed: 1 PG, 2 PG+PG13, 1 X, 1 XXX |
| 98 | [Vidu x Civitai Contest](https://civitai.com/collections/9979111) | Faeia | Image | 561 | 1669 | all PG/PG13 (5) |
| 100 | [Civitai World Morph Collection](https://civitai.com/collections/2930699) | Faeia | Model | 556 | 608 | mixed: 2 PG, 2 PG+PG13, 1 R |

## Flagged — skip or review carefully (62)

Majority of sampled items are R or above. Most of these are NSFW-themed model collections that shouldn't front the homepage.

| # | Collection | Owner | Type | Followers | Sample |
|--:|:----------|:------|:-----|----------:|:------|
| 2 | [Nova Series](https://civitai.com/collections/9677464) | Crody | Model | 6966 | all NSFW (5): 2 X, 3 XXX |
| 3 | [PornMaster-Pro](https://civitai.com/collections/6596928) | iamddtla | Model | 5754 | mixed: 5 XXX, 4 Blocked |
| 4 | [Smooth Collection](https://civitai.com/collections/7237154) | DigitalPastel | Model | 4904 | mixed: 1 X, 4 XXX, 1 Blocked |
| 5 | [Models](https://civitai.com/collections/8501873) | janxd | Model | 4493 | mixed: 2 PG, 1 R, 2 XXX |
| 6 | [METAFILM Ai Models](https://civitai.com/collections/6686272) | AiMetatron | Model | 3935 | all NSFW (5): 1 PG, 4 XXX, 1 Blocked |
| 7 | [Erotic Video Collection (N)SFW](https://civitai.com/collections/10505430) | arkinson | Image | 3439 | mixed: 1 PG13, 2 R, 2 X |
| 8 | [Reij's ~ merged Checkpoints ](https://civitai.com/collections/4543901) | reijlita | Model | 2945 | all NSFW (5): 2 R, 3 X |
| 9 | [Shiiro's Illustrious loras](https://civitai.com/collections/6734784) | Shiiro0 | Model | 2910 | mixed: 1 PG, 1 PG+PG13, 3 R |
| 14 | [Illustrious XL - STYLES](https://civitai.com/collections/8304426) | YeiYeiArt | Model | 2199 | mixed: 2 PG+PG13, 3 R |
| 18 | [Waifu Concepts](https://civitai.com/collections/11650723) | Charbel | Model | 1877 | mixed: 5 XXX, 5 Blocked |
| 20 | [Shrekman Hentai Loras](https://civitai.com/collections/5978555) | Shrekman17 | Model | 1776 | mixed: 5 XXX, 5 Blocked |
| 21 | [In the Nude (NSFW)](https://civitai.com/collections/4976869) | PervyCat | Image | 1727 | all NSFW (5): 1 X, 4 XXX |
| 24 | [Monster Girl Encyclopedia](https://civitai.com/collections/10832524) | Alfheimr | Model | 1532 | mixed: 5 XXX, 5 Blocked |
| 27 | [My Models](https://civitai.com/collections/8161130) | K112 | Model | 1371 | mixed: 5 XXX, 5 Blocked |
| 28 | [Vixon's Illustrious Styles](https://civitai.com/collections/6453691) | freckledvixon | Model | 1352 | mixed: 1 PG+PG13, 4 R |
| 32 | [Illustrious Styles by Guy90](https://civitai.com/collections/6032191) | guy90 | Model | 1258 | all NSFW (5): 1 R, 2 X, 2 XXX |
| 35 | [photography style-摄影风格](https://civitai.com/collections/161109) | iamddtla | Model | 1146 | mixed: 5 XXX, 3 Blocked |
| 37 | [Mai Character H Anime](https://civitai.com/collections/11464483) | 00x09901 | Model | 1087 | mixed: 5 XXX, 5 Blocked |
| 38 | [Models by DR34MSC4PE](https://civitai.com/collections/11986514) | ERA5ER | Model | 1056 | mixed: 5 XXX, 5 Blocked |
| 39 | [Style for Illustrious](https://civitai.com/collections/6547561) | sxus_Sw | Model | 1054 | all NSFW (5): 5 XXX |
| 40 | [Other porn-其它色情](https://civitai.com/collections/161142) | iamddtla | Model | 1016 | mixed: 5 XXX, 4 Blocked |
| 41 | [Artist style](https://civitai.com/collections/7633447) | King_Dong | Model | 987 | mixed: 2 PG+PG13, 3 R |
| 43 | [Pokemon Characters](https://civitai.com/collections/261) | CitronLegacy | Model | 971 | all NSFW (5): 4 R, 1 X |
| 45 | [Unreal Beauty (NSFW) ](https://civitai.com/collections/7334867) | VigorousMaximus | Image | 956 | all NSFW (5): 1 R, 4 X |
| 47 | [Artist Styles (NSFW)](https://civitai.com/collections/857547) | PulenKompot | Model | 895 | mixed: 5 XXX, 5 Blocked |
| 49 | [Umamusume in game style 3D](https://civitai.com/collections/10286991) | denny208 | Model | 888 | mixed: 1 PG, 4 XXX, 4 Blocked |
| 50 | [Sexy Clothes](https://civitai.com/collections/11464359) | 00x09901 | Model | 875 | mixed: 5 XXX, 5 Blocked |
| 51 | [Artist Style for PDXL/ILXL](https://civitai.com/collections/7284511) | Cell1310 | Model | 872 | all NSFW (5): 5 XXX |
| 52 | [Yu-Gi-Oh ](https://civitai.com/collections/6349867) | Sqquirtle0007 | Model | 865 | all NSFW (5): 2 R, 3 XXX |
| 53 | [Best of Sexy / Nude / Sex](https://civitai.com/collections/5369632) | ? | Image | 858 | all NSFW (5): 1 X, 4 XXX |
| 54 | [Female Model Lora](https://civitai.com/collections/9987134) | Midnightkidnaper | Model | 843 | mixed: 1 R, 4 XXX, 4 Blocked |
| 55 | [Styles](https://civitai.com/collections/11175552) | KojiroNsfw | Model | 832 | all NSFW (5): 1 R, 1 X, 3 XXX |
| 56 | [PornMaster-Anime](https://civitai.com/collections/6597372) | iamddtla | Model | 827 | mixed: 5 XXX, 5 Blocked |
| 57 | [Movie Still Styles](https://civitai.com/collections/5168803) | ArsMachina | Model | 821 | mixed: 2 PG+PG13, 3 R |
| 58 | [Illustration](https://civitai.com/collections/8044351) | Adel_AI | Model | 821 | all NSFW (5): 3 R, 2 X |
| 60 | [URPM](https://civitai.com/collections/5013882) | saftle | Model | 773 | mixed: 2 XXX, 2 Blocked |
| 61 | [Niji style (By zoropaton)](https://civitai.com/collections/8196839) | Zoropaton | Model | 771 | mixed: 1 PG, 1 PG+PG13, 2 R, 1 XXX |
| 62 | [MILFs](https://civitai.com/collections/8750684) | magnifique | Model | 768 | mixed: 5 XXX, 5 Blocked |
| 64 | [Fantasy Sex Concept Collection](https://civitai.com/collections/5211376) | Shrekman17 | Model | 751 | mixed: 5 XXX, 5 Blocked |
| 65 | [Vixon's Pony Styles](https://civitai.com/collections/5597546) | freckledvixon | Model | 746 | mixed: 1 PG, 1 PG+PG13, 1 R, 2 X |
| 68 | [Styles](https://civitai.com/collections/11600880) | fr0p | Model | 720 | mixed: 1 R, 3 XXX |
| 69 | [Styles - Human](https://civitai.com/collections/11792767) | toghashie441 | Model | 718 | mixed: 2 X, 2 XXX |
| 70 | [Pony: People's Works](https://civitai.com/collections/8769046) | Dajiejiekong | Model | 710 | all NSFW (3): 1 R, 2 X |
| 71 | [Zenless Zone Zero](https://civitai.com/collections/8537793) | Hoseki | Model | 702 | mixed: 5 XXX, 1 Blocked |
| 72 | [Intimate/Racy Clothing](https://civitai.com/collections/14943175) | freckledvixon | Model | 701 | mixed: 1 PG+PG13, 3 R, 1 X |
| 73 | [Workflows](https://civitai.com/collections/12410838) | Legendaer | Model | 682 | mixed: 2 PG, 2 R, 1 XXX |
| 76 | [Perfect Sex positions -S.P](https://civitai.com/collections/5391207) | sarahpeterson | Model | 654 | mixed: 5 XXX, 5 Blocked |
| 78 | [TeeKay's Titty Time](https://civitai.com/collections/6108077) | TeeKay | Model | 642 | mixed: 5 XXX, 5 Blocked |
| 79 | [BDSM](https://civitai.com/collections/11580359) | 00x09901 | Model | 629 | mixed: 5 XXX, 5 Blocked |
| 80 | [Asian Mix](https://civitai.com/collections/6360856) | hinablue | Model | 618 | all NSFW (5): 5 X |
| 81 | [Real Pussy](https://civitai.com/collections/5047) | Lucifie | Model | 618 | mixed: 5 XXX, 5 Blocked |
| 83 | [Konan's Illustrious/Noob Style](https://civitai.com/collections/9834506) | Konan | Model | 601 | all NSFW (5): 4 R, 1 X |
| 84 | [Furry Concepts](https://civitai.com/collections/96079) | BeerYeen | Model | 599 | mixed: 5 XXX, 5 Blocked |
| 85 | [NSFW pose collection](https://civitai.com/collections/9156640) | KegawaX | Model | 598 | mixed: 5 XXX, 5 Blocked |
| 86 | [BDSM、sex toys-性虐待、性玩具](https://civitai.com/collections/161131) | iamddtla | Model | 597 | mixed: 5 XXX, 4 Blocked |
| 87 | [Taimanin girls](https://civitai.com/collections/7116526) | DanMogren | Model | 595 | mixed: 5 XXX, 5 Blocked |
| 89 | [Recommended Collection](https://civitai.com/collections/8967832) | 81187 | Model | 586 | mixed: 5 XXX, 5 Blocked |
| 90 | [[STYLES]](https://civitai.com/collections/7286451) | Praelatus | Model | 582 | all NSFW (5): 2 X, 3 XXX |
| 94 | [Styles](https://civitai.com/collections/5954571) | DuramenoAFK | Model | 575 | all NSFW (5): 5 XXX |
| 95 | [Freelance Artists Styles](https://civitai.com/collections/10807226) | SageWolf | Model | 565 | mixed: 1 X, 4 XXX, 4 Blocked |
| 97 | [majicFlus lora collection](https://civitai.com/collections/7047551) | Merjic | Model | 561 | mixed: 1 PG, 2 R, 2 X |
| 99 | [Well Dressed Futas](https://civitai.com/collections/5291818) | DarkModeOP | Model | 557 | mixed: 5 XXX, 5 Blocked |

## Caveats

- Sample size is only 5 items. A "all PG" sample is promising but not conclusive — always confirm the cover image and a wider sample before featuring.
- "no sample" rows had no ACCEPTED items that matched their type on the latest 5 — generally safe to skip.
- The `civitai` system user (id=-1) is excluded, so the "Featured" series and other staff-managed homepage collections don't appear.
- Consider cross-referencing with moderation notes before featuring any of the flagged collections in a PG/PG13 context.
