#!/usr/bin/env python3
"""Read-only: can an OFFSITE listing be addressed by tRPC using its listing id?

The CLI refuses (exit 4) because it resolves listings through a block
submission and offsite apps have none. But the listing id is published on the
public list route, so the procs may be reachable directly. Read only — no
mutation here.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

LISTING_ID = sys.argv[1]

CONFIG_PATH = os.environ.get("CIVITAI_CONFIG") or os.path.expanduser(
    "~/.config/civitai/config.yaml"
)

cfg = {}
for line in open(CONFIG_PATH):
    if ":" in line:
        k, v = line.split(":", 1)
        cfg[k.strip()] = v.strip().strip('"')
TOKEN = cfg.get("token") or cfg.get("access_token")
BASE = cfg.get("base_url", "https://civitai.com")


def query(route, payload):
    q = urllib.parse.urlencode({"input": json.dumps({"json": payload})})
    req = urllib.request.Request(
        f"{BASE}/api/trpc/{route}?{q}",
        headers={"Authorization": f"Bearer {TOKEN}", "User-Agent": "Go-http-client/2.0"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


code, body = query("appListings.getMyListingForEdit", {"listingId": LISTING_ID})
print(f"getMyListingForEdit({LISTING_ID}) -> HTTP {code}")
if code == 200:
    d = json.loads(body)["result"]["data"]["json"]
    print(json.dumps({k: d.get(k) for k in ("parentId", "kind", "slug", "status",
                                            "hasPendingRevision", "shadowId")}, indent=2))
    a = d.get("assets", {})
    print("icon imageId :", (a.get("icon") or {}).get("imageId"))
    print("cover imageId:", (a.get("cover") or {}).get("imageId"))
    print("screenshots  :", len(a.get("screenshots") or []))
else:
    print(body[:500])
