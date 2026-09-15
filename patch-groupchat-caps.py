#!/usr/bin/env python3
"""
patch-groupchat-caps.py — detect and patch Hermes desktop group-chat caps.

The desktop app hardcodes group-chat coordination limits in the built renderer
bundle (apps/desktop/src/plugins/hermes-bots/group-chat.ts):
    GROUP_CHAT_MAX_ROUNDS        = 3   (round-robin rounds per user send)
    GROUP_CHAT_MAX_MESSAGES      = 10  (room messages posted per user send)
    GROUP_CHAT_MAX_CONTINUATIONS = 2   (extra rounds to answer unresolved @mentions)
    GROUP_CHAT_MAX_MEMBERS       = 6   (roster size — intentionally LEFT ALONE)

There is no config.yaml escape hatch for these (they are hardcoded const
exports). The Protean Team setup overrides rounds/messages/continuations to a value
large enough to be "effectively no cap" (9999) so long multi-agent coordination
is never cut short, while members stays at 6 (the roster the rooms are sized
for). The minifier (rolldown) INLINES the constants into the bundle, so they
appear as literal 3 / 10 / 2 in a handful of context-anchored sites rather than
one var declaration — the old watchdog regex (`var A=3,B=10,C=2,D=6;`) stopped
matching when the bundler changed shape.

This script:
  1. Locates the current renderer bundle (assets/index-*.js).
  2. Detects the group-chat cap sites by their surrounding STRUCTURAL anchor
     (stable against minifier variable renames, which are single letters that
     change every build).
  3. If the upstream 3/10/2 defaults are present, patches them to 9999/9999/9999
     (members stays 6). If the override is already applied, it is a no-op.
  4. If NO cap pattern matches at all, exits 3 (build shape changed beyond
     recognition) so the caller can ALERT instead of silently assuming.

Exit codes: 0 = override present (patched or already applied); 1 = error;
3 = no cap pattern matched (shape changed, needs manual review).

Usage: patch-groupchat-caps.py [bundle_path]
"""
import glob
import os
import re
import sys

TARGET = 9999  # effectively-unlimited; large enough no real coordination hits it

# ── Cap sites. Each regex captures the minified var name(s) with (\w+) so a
#    bundler variable rename still matches; the surrounding code is the stable
#    anchor (tied to the source, not to the minified name). `up_literals` are
#    the numeric cap literals present in the upstream regex, in replace order.
#    Replacement templates use sentinels __V0__/__V1__ (captured var names) and
#    __T__ (TARGET) with .replace() — braces stay literal, no format escaping.
# ────────────────────────────────────────────────────────────────────────────
SITES = [
    # SITE 1 — rounds loop:  s=`settled`;try{for(let c=0;c<3;c++){for(let r of t){
    {
        "regex": r"s=`settled`;try\{for\(let (\w+)=0;\1<3;\1\+\+\)\{for\(let",
        "up_literals": ["3"],
        "tpl": "s=`settled`;try{for(let __V0__=0;__V0__<__T__;__V0__++){for(let",
        "ngroups": 1,
    },
    # SITE 2 — message cap in member loop:  if(!i()||a>=10){i()?s=`capped`
    {
        "regex": r"!i\(\)\|\|(\w+)>=10\)\{i\(\)\?s=`capped`",
        "up_literals": ["10"],
        "tpl": "!i()||__V0__>=__T__){i()?s=`capped`",
        "ngroups": 1,
    },
    # SITE 3 — continuation increment gate:  if(o+=1,r.length&&o<=2){
    {
        "regex": r"if\((\w+)\+=1,r\.length&&\1<=2\)\{",
        "up_literals": ["2"],
        "tpl": "if(__V0__+=1,r.length&&__V0__<=__T__){",
        "ngroups": 1,
    },
    # SITE 4 — message cap before continuation loop:  s.length&&a<10){
    {
        "regex": r"s\.length&&(\w+)<10\)\{",
        "up_literals": ["10"],
        "tpl": "s.length&&__V0__<__T__){",
        "ngroups": 1,
    },
    # SITE 5 — combined msg+cont inside continuation loop:  if(!i()||a>=10||o>2)break
    {
        "regex": r"!i\(\)\|\|(\w+)>=10\|\|(\w+)>2\)break",
        "up_literals": ["10", "2"],
        "tpl": "!i()||__V0__>=__T__||__V1__>__T__)break",
        "ngroups": 2,
    },
    # SITE 6 — final close:  r.length&&(o>2||a>=10)&&(s=`capped`)
    {
        "regex": r"r\.length&&\((\w+)>2\|\|(\w+)>=10\)&&\(s=`capped`",
        "up_literals": ["2", "10"],
        "tpl": "r.length&&(__V0__>__T__||__V1__>=__T__)&&(s=`capped`",
        "ngroups": 2,
    },
]


def patched_regex(site):
    """Upstream regex with its cap literals replaced by TARGET -> patched detector."""
    r = site["regex"]
    for lit in site["up_literals"]:
        r = r.replace(lit, str(TARGET))
    return re.compile(r)


def render(site, m):
    out = site["tpl"].replace("__T__", str(TARGET))
    if site["ngroups"] == 1:
        out = out.replace("__V0__", m.group(1))
    else:
        out = out.replace("__V0__", m.group(1)).replace("__V1__", m.group(2))
    return out


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

    states = []
    for site in SITES:
        if re.search(site["regex"], data):
            states.append("upstream")
        elif patched_regex(site).search(data):
            states.append("patched")
        else:
            states.append("absent")

    if all(st == "patched" for st in states):
        print(f"ALREADY PATCHED ({base}) — no-op")
        return 0
    if any(st == "absent" for st in states):
        print(f"NO CAP PATTERN MATCHED in {base} — shape changed, caps unverified")
        print(f"site states: {states}")
        return 3

    new = data
    applied = []
    for i, site in enumerate(SITES, 1):
        m = re.search(site["regex"], new)
        if not m:
            print(f"patch site {i}: upstream pattern vanished mid-patch — abort, no write")
            return 1
        new = new[:m.start()] + render(site, m) + new[m.end():]
        applied.append(i)

    open(path, "w", encoding="utf-8").write(new)
    print(f"PATCHED {base} -> rounds/messages/continuations = {TARGET} "
          f"(members 6 kept); sites patched: {applied}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
