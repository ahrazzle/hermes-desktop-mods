#!/usr/bin/env python3
"""
patch-groupchat-caps.py — detect and patch Hermes desktop group-chat caps.

The desktop app hardcodes group-chat coordination limits in the built renderer
bundle (source: apps/desktop/src/plugins/hermes-bots/group-chat.ts):
    GROUP_CHAT_MAX_ROUNDS        = 3   (round-robin rounds per user send)
    GROUP_CHAT_MAX_MESSAGES      = 10  (room messages posted per user send)
    GROUP_CHAT_MAX_CONTINUATIONS = 2   (extra rounds to answer unresolved @mentions)
    GROUP_CHAT_MAX_MEMBERS       = 6   (roster size — intentionally LEFT ALONE)

There is no config.yaml escape hatch for these (they are hardcoded const
exports). The Protean Team setup overrides rounds/messages/continuations to a
value large enough to be "effectively no cap" (9999) so long multi-agent
coordination is never cut short, while members stays at 6. The minifier
(rolldown) INLINES the constants, so they appear as literal 3 / 10 / 2 in a
handful of context-anchored sites rather than one var declaration.

RE-DERIVED 2026-09-18 for the post-#111283 bundle (index-kkaHszuX.js; verdict
table: hazen-brief-111283.md §5). The constants themselves never moved, but
the round-loop restructure split the sites across TWO functions:
  - runGroupChatRounds (bundle pMe):    SITE 1 (rounds loop), SITE 2 (msg cap
    in member loop), SITE 6 (final close after continuations)
  - runGroupContinuationMembers (aMe):  SITE 3 (continuation gate — the old
    fused `if(o+=1,r.length&&o<=2)` shape is GONE: the increment split out to
    the driver with no cap literal; the gate `pending.length && continuations
    <= MAX_CONTINUATIONS` now lives in the continuation function), SITE 4 (msg
    cap before continuation loop), SITE 5 (combined msg+cont break)
The OLD regexes pinned minifier LETTERS (hardcoded `s=`, `i()`, `r.length`)
despite their rename-tolerant docstring and ALERTed (rc=3, 5/6 absent) on the
rebuild. Every letter position in the new regexes is a named capture, with
`(?P=x)` backreferences where the same identifier must repeat — so a rename
cannot alias two roles. Each cap literal is itself a capture group matching
`<upstream>|<TARGET>`, which gives state detection and patching from ONE
pattern per site (no string-mangling of regexes).

Detection contract: every site must match EXACTLY ONCE (upstream or patched
form). 0 = absent, >1 = ambiguous — either way exits 3 so the caller ALERTS
instead of silently mis-patching. After writing, the patcher re-detects and
requires all sites patched.

Exit codes: 0 = override present (patched or already applied); 1 = error;
3 = shape changed / ambiguous (needs manual review).

Usage: patch-groupchat-caps.py [bundle_path]
"""
import glob
import os
import re
import sys

TARGET = 9999  # effectively-unlimited; large enough no real coordination hits it

# Each site: a structural regex with named captures for every minified
# identifier and (?P<capN>UPSTREAM|{TARGET}) for each cap literal, plus the
# upstream literal per cap group. {TARGET} is filled at use (never str.format
# — the patterns contain literal regex braces).
SITES = [
    # SITE 1 — rounds loop (GROUP_CHAT_MAX_ROUNDS) in runGroupChatRounds:
    #   source ~ group-rounds.ts: `exitKind='settled'; try { for (round<GROUP_CHAT_MAX_ROUNDS)`
    #   bundle  `u=`settled`;try{for(let r=0;r<3;r++){for(let`
    {
        "name": "rounds loop",
        "regex": r"(?P<ek>\w+)=`settled`;try\{for\(let (?P<v>\w+)=0;(?P=v)<(?P<cap1>3|{TARGET});(?P=v)\+\+\)\{for\(let",
        "up": {"cap1": "3"},
    },
    # SITE 2 — message cap in member loop (GROUP_CHAT_MAX_MESSAGES):
    #   bundle  `if(!o()||c>=10){o()?u=`capped`:nj(...)`  — the (?P=cur)
    #   backreference pins both isCurrent() calls to the same function name.
    {
        "name": "msg cap in round loop",
        "regex": r"if\(!(?P<cur>\w+)\(\)\|\|(?P<pos>\w+)>=(?P<cap1>10|{TARGET})\)\{(?P=cur)\(\)\?(?P<ek>\w+)=`capped`",
        "up": {"cap1": "10"},
    },
    # SITE 3 — continuation gate (GROUP_CHAT_MAX_CONTINUATIONS) in
    #   runGroupContinuationMembers (moved here by #111283; fused increment+
    #   gate shape of the old bundle no longer exists):
    #   bundle  `if(t.length&&n<=2){`
    {
        "name": "continuation gate",
        "regex": r"if\((?P<pend>\w+)\.length&&(?P<cont>\w+)<=(?P<cap1>2|{TARGET})\)\{",
        "up": {"cap1": "2"},
    },
    # SITE 4 — message cap before continuation loop, in aMe
    #   (group-round-members.ts: `citedMembers.length && posted < MAX_MESSAGES`):
    #   bundle  `if(s.length&&r<10){`
    {
        "name": "msg cap before continuation loop",
        "regex": r"if\((?P<cited>\w+)\.length&&(?P<pos>\w+)<(?P<cap1>10|{TARGET})\)\{",
        "up": {"cap1": "10"},
    },
    # SITE 5 — combined msg+cont break, inside continuation loop
    #   (group-round-members.ts: `!isCurrent() || posted >= MAX_MESSAGES ||
    #   continuations > MAX_CONTINUATIONS`):
    #   bundle  `if(!a()||r>=10||n>2)break`
    {
        "name": "combined msg+cont break",
        "regex": r"if\(!(?P<cur>\w+)\(\)\|\|(?P<pos>\w+)>=(?P<cap1>10|{TARGET})\|\|(?P<cont>\w+)>(?P<cap2>2|{TARGET})\)break",
        "up": {"cap1": "10", "cap2": "2"},
    },
    # SITE 6 — final close after continuations, in pMe
    #   (group-rounds.ts: `pendingKeys.length && (continuations > MAX_CONTINUATIONS
    #   || posted >= MAX_MESSAGES)`):
    #   bundle  `r.length&&(l>2||c>=10)&&(u=`capped`);return}`
    {
        "name": "final close",
        "regex": r"(?P<pend>\w+)\.length&&\((?P<cont>\w+)>(?P<cap1>2|{TARGET})\|\|(?P<pos>\w+)>=(?P<cap2>10|{TARGET})\)&&\((?P<ek>\w+)=`capped`\)",
        "up": {"cap1": "2", "cap2": "10"},
    },
]


def site_regex(site):
    """Compiled site pattern with {TARGET} filled."""
    return re.compile(site["regex"].replace("{TARGET}", str(TARGET)))


def detect(data):
    """[(site, match|None, state)] where state in upstream|patched|absent|ambiguous|mixed."""
    out = []
    for site in SITES:
        hits = list(site_regex(site).finditer(data))
        if len(hits) == 0:
            out.append((site, None, "absent"))
        elif len(hits) > 1:
            out.append((site, None, "ambiguous"))
        else:
            caps = {g: hits[0].group(g) for g in site["up"]}
            if all(v == site["up"][g] for g, v in caps.items()):
                state = "upstream"
            elif all(v == str(TARGET) for g, v in caps.items()):
                state = "patched"
            else:
                state = "mixed"
            out.append((site, hits[0], state))
    return out


def apply_site(new, m, site):
    """Replace each not-yet-TARGET cap span with TARGET (reverse offset order)."""
    spans = sorted((m.span(g) for g in site["up"] if m.group(g) != str(TARGET)),
                   reverse=True)
    for s, e in spans:
        new = new[:s] + str(TARGET) + new[e:]
    return new


def find_bundle(explicit=None):
    if explicit and os.path.isfile(explicit):
        return explicit
    cands = glob.glob(os.path.join(
        os.path.expanduser("~/.hermes/hermes-agent/apps/desktop/release/mac-arm64/"
                           "Hermes.app/Contents/Resources/app.asar.unpacked/dist/assets/index-*.js")))
    return cands[0] if cands else None


def main():
    path = find_bundle(sys.argv[1] if len(sys.argv) > 1 else None)
    if not path:
        print("NO BUNDLE FOUND")
        return 1
    data = open(path, encoding="utf-8").read()
    base = path.split("/")[-1]

    found = detect(data)
    states = [st for _, _, st in found]
    if all(st == "patched" for st in states):
        print(f"ALREADY PATCHED ({base}) — no-op")
        return 0
    if any(st in ("absent", "ambiguous") for st in states):
        print(f"NO CAP PATTERN MATCHED in {base} — shape changed, caps unverified")
        print(f"site states: {list(zip([s['name'] for s, _, _ in found], states))}")
        return 3

    new = data
    applied = []
    for i, (site, m, st) in enumerate(found, 1):
        if st == "patched":
            continue
        if st == "mixed":
            print(f"patch site {i}: mixed cap literals ({site['name']}) — re-anchor, abort")
            return 1
        m = site_regex(site).search(new)  # re-search: earlier sites shifted offsets
        if not m:
            print(f"patch site {i}: upstream pattern vanished mid-patch — abort, no write")
            return 1
        new = apply_site(new, m, site)
        applied.append(site["name"])

    post = [st for _, _, st in detect(new)]
    if not all(st == "patched" for st in post):
        print(f"post-patch verification failed ({post}) — abort, no write")
        return 1

    open(path, "w", encoding="utf-8").write(new)
    print(f"PATCHED {base} -> rounds/messages/continuations = {TARGET} "
          f"(members 6 kept); sites patched: {applied}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
