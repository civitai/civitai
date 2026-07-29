Example webhook from orch:
```json
{
  "$type": "workflow",
  "workflowId": "0-20251029212923125",
  "status": "succeeded",
  "timestamp": "2025-10-29T21:29:24.7599308Z",
  "details": {
    "metadata": {},
    "arguments": {
      "mediaUrl": "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/bf0b2d1d-4b20-485d-8e20-b3aaae91eb66/original=true,quality=90/107357814.jpeg"
    },
    "createdAt": "2025-10-29T21:29:23.1252764Z",
    "completedAt": "2025-10-29T21:29:24.7599305Z",
    "startedAt": "2025-10-29T21:29:23.1577181Z",
    "steps": [
      {
        "name": "tag",
        "status": "succeeded",
        "startedAt": "2025-10-29T21:29:23.1577168Z",
        "completedAt": "2025-10-29T21:29:24.7599253Z",
        "metadata": {
          "imageId": 1
        },
        "input": {
          "model": "wd14-vit.v1",
          "mediaUrl": "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/bf0b2d1d-4b20-485d-8e20-b3aaae91eb66/original=true,quality=90/107357814.jpeg",
          "threshold": 0.5
        },
        "output": {
          "tags": {
            "profile": 0.44695937633514404,
            "shoulder armor": 0.568656325340271,
            "earrings": 0.6818813681602478,
            "weapon": 0.9450876116752625,
            "solo": 0.9330596923828125,
            "armor": 0.9020718336105347,
            "1girl": 0.9871819019317627,
            "breastplate": 0.4047943949699402,
            "chain": 0.4819020628929138,
            "breasts": 0.5159248113632202,
            "holding sword": 0.6847452521324158,
            "pauldrons": 0.5211114883422852,
            "from side": 0.5582594275474548,
            "sword": 0.9198364615440369,
            "holding": 0.7498853206634521,
            "long hair": 0.4886309504508972,
            "red hair": 0.9147271513938904,
            "simple background": 0.5074854493141174,
            "small breasts": 0.41917210817337036,
            "holding weapon": 0.731310248374939,
            "jewelry": 0.6541959643363953
          },
          "rating": {
            "sensitive": 0.812727689743042,
            "general": 0.22787392139434814,
            "questionable": 0.00528872013092041,
            "explicit": 0.000413358211517334
          }
        }
      },
      {
        "name": "rating",
        "status": "succeeded",
        "startedAt": "2025-10-29T21:29:23.1578525Z",
        "completedAt": "2025-10-29T21:29:24.6798816Z",
        "metadata": {
          "imageId": 1
        },
        "input": {
          "mediaUrl": "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/bf0b2d1d-4b20-485d-8e20-b3aaae91eb66/original=true,quality=90/107357814.jpeg"
        },
        "output": {
          "nsfwLevel": "pg",
          "isBlocked": false
        }
      },
      {
        "name": "hash",
        "status": "succeeded",
        "startedAt": "2025-10-29T21:29:23.1577748Z",
        "completedAt": "2025-10-29T21:29:23.6014847Z",
        "metadata": {
          "imageId": 1
        },
        "input": {
          "mediaUrl": "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/bf0b2d1d-4b20-485d-8e20-b3aaae91eb66/original=true,quality=90/107357814.jpeg",
          "hashTypes": [
            "perceptual"
          ]
        },
        "output": {
          "hashes": {
            "perceptual": "4C47634E8E9F0F47"
          }
        }
      }
    ]
  }
}
```
