#!/usr/bin/env python3
"""
patch-groupchat-slash.py — group-room slash commands for the Hermes desktop app.

Local Protean Team patch (no upstream equivalent): the group composer bypasses the
shared slash dispatcher, so "/cmd" typed in a room fans out to every member
session as literal LLM text. This patches the built renderer bundle so
sendToGroupChat intercepts command-shaped input:

  /cmd [@agent ...]            -> command.dispatch against the targeted
                                  member session(s); results posted into the
                                  room thread as "Slash" entries.
  /cmd (no mention)            -> command.dispatch against the default
                                  profile's session; result posted as "Room".

The user's message is appended to the room log (so the command is visible),
the thread is minted as usual, and the round drive is never started (return s
early). Replies (thread composer) hit the same choke point via the same
function.

RE-DERIVED 2026-09-18 for the post-#111283 bundle (index-kkaHszuX.js, app 0.17.3;
evidence: hazen-brief-111283.md). Two structural changes vs the old patch:

1. QUEUE PATH, NOT DIRECT DRIVER. Upstream #111283 replaced sendToGroupChat's
   epoch-bump + delayed-handoff with queueGroupChatDrive: a module-level drive
   map serializes per-room drives, and the round driver gained a 4th param
   (shared failedMembers set) that ONLY the queue owner passes. The injected
   drive() therefore calls the queue owner (discovered at the function tail,
   `<queue>(e,t,s),s}`) — never the driver directly. The queue owner bumps the
   room epoch and sets `running` per drained thread itself, so the snippet
   drops its old epoch/running manipulation. The snippet keeps its own queued
   activity record because the early `return s` bypasses the real body's
   record statement.
2. UPSTREAM SLASH GUARD. sendToGroupChat now opens with
   rejectGroupSlashCommand(trimmed): command-shaped text is rejected with a
   warning toast BEFORE reaching the injection anchor, which made the feature
   dead-on-arrival. The patcher neutralizes that guard at its unique call
   site only for the cases the local snippet handles. The rewrite is
   `if(images&&images.length&&guard(trimmed))return null;` — the attachments
   check comes FIRST because the guard function has the toast as a side
   effect: `guard(a)&&i.length` would still notify on every intercepted
   command. Semantics preserved: command-shaped text WITH attachments keeps
   the upstream rejection (the snippet deliberately ignores those); the guard
   function itself stays untouched for any other entry door.

MINIFIED NAMES ARE NO LONGER HARDCODED. Letters shift on every rebuild, so the
patcher discovers every reference at runtime from structural probes (PROBES);
each probe must match exactly once or the patcher exits 3 (ALERT) without
writing. On index-kkaHszuX.js the probes resolve: fn=Dj guard=oMe mint=rje
upd=DA dur=GA app=OA act=nj queue=hMe store=Qk mk=NA gsk=FA hts=LA q=q
(roles per hazen-brief-111283.md §4).

Member-session lookup is thread-scoped (upstream d631ad5f5c): sessions are now
keyed groupSessionKey(thread, member) = `thread:<t>::<memberKey>`, with the bare
groupMemberKey valid only for rooms that never migrated. The snippet mirrors
stopGroupThread's own pattern: thread key first; bare-key fallback only when
hasThreadScopedGroupSession says the member has no scoped session anywhere.

Exit codes: 0 = patch present (applied or already applied); 1 = error;
3 = anchor/probe missing or ambiguous (build shape changed — ALERT).

Usage: patch-groupchat-slash.py [bundle_path]
"""
import glob
import os
import re
import sys

MARKER = "__GSPATCH"

# HEAD binds the function's own parameter letters; later probes reference them,
# so a parameter rename cannot alias two different roles. WINDOW probes search
# only inside the first 1500 chars of the function text (the body is ~520);
# global probes must stay unique across the whole bundle.
HEAD = (r"function (?P<fn>\w+)\((?P<e>\w+),(?P<t>\w+),(?P<n>\w+),(?P<r>\w+),(?P<i>\w+)\)"
        r"\{let (?P<a>\w+)=String\((?P=n)\|\|``\)\.trim\(\);"
        r"if\((?P<guard>\w+)\((?P=a)\)\)return null;"
        r"let (?P<o>\w+)=Array\.isArray\((?P=i)\)")

# (pattern, in_window, [(out_name, group), ...]) — placeholders {x} fill in
# discovered names (re.escape'd at use).
PROBES = [
    # anchor: `const target = thread || mintGroupThreadId()`
    (r"let (\w+)={r}\|\|(\w+)\(\);", True, [("s", 1), ("mint", 2)]),
    # $groupNeedsYou.set({...$groupNeedsYou.get(),[group]:!1}) — validation only
    (r"(\w+)\.set\(\{\.\.\.\1\.get\(\),\[{e}\]:!1\}\)", True, []),
    # updateGroupChat(group, r => (r.members = durableGroupChatMembers(members), r)
    (r"(\w+)\({e},(\w+)=>\(\2\.members=(\w+)\({t}\)", True, [("upd", 1), ("dur", 3)]),
    # appendGroupChatEntry(group, {kind:'user',name:'You'}, trimmed, thread, attached)
    (r"(\w+)\({e},\{kind:`user`,name:`You`\},", True, [("app", 1)]),
    # recordGroupActivity(group, {kind:'queued',member:'You',thread:...})
    (r"(\w+)\({e},\{kind:`queued`,member:`You`,thread:", True, [("act", 1)]),
    # queue owner call at the function tail: `...,queue(group,members,thread),thread}`
    (r"(\w+)\({e},{t},{s}\),{s}\}", True, [("queue", 1)]),
    # $groupChats store: queue owner opens `function q(e,t,n){let r=k(e,S.get()[e])`
    (r"function {queue}\(\w+,\w+,\w+\)\{let \w+=\w+\(\w+,(\w+)\.get\(\)\[\w+\]\)", False,
     [("store", 1)]),
    # groupMemberKey from the roster refresh `t.map(x=>K(x))`
    (r"\.map\((\w+)=>(\w+)\(\1\)\)", True, [("mk", 2)]),
    # host SDK: the empty-roster error notify inside the function
    (r"(\w+)\.notify\(\{kind:`error`", True, [("q", 1)]),
    # guard def shape check (defends against an accidental name collision)
    (r"function {guard}\(\w+\)\{return/\^\\/\[a-z\]\[\\w-\]\*\(\?:\\s\|\$\)/i"
     r"\.test\(\w+\)\?\({q}\.notify\(\{kind:`warning`", False, []),
    # groupSessionKey def: function G(t,m){return`${P}${t||`legacy`}::${K(m)}`}
    # — its inner member-key fn must equal the `mk` discovered above
    (r"function (?P<gsk>\w+)\((?P<t1>\w+),(?P<m1>\w+)\)\{return`\$\{(?P<pa>\w+)\}"
     r"\$\{(?P=t1)\|\|`legacy`\}::\$\{(?P<mk2>\w+)\((?P=m1)\)\}`", False,
     [("gsk", "gsk"), ("pa", "pa"), ("mkx", "mk2")]),
    # hasThreadScopedGroupSession def:
    # function H(e,k){return Object.keys(e||{}).some(x=>x.startsWith(P)&&I(x)===k)}
    (r"function (\w+)\((\w+),(\w+)\)\{return Object\.keys\(\2\|\|\{\}\)"
     r"\.some\((\w+)=>\4\.startsWith\({pa}\)&&(\w+)\(\4\)===\3\)", False, [("hts", 1)]),
]

SNIPPET = r"""if(!__O__.length&&/^\/([a-z][\w-]*)(\s|$)/i.test(__A__)){
  let __GSPATCH=1;
  let cmdName=__A__.trim().split(/\s+/)[0].slice(1).toLowerCase();
  let cmdArg=__A__.trim().replace(/^\/[\w-]*/,"").replace(/@([a-z0-9][a-z0-9._-]*)/gi,"").trim();
  let targets=[];
  for(let m of __A__.matchAll(/@([a-z0-9][a-z0-9._-]*)/gi)){
    let mn=m[1].toLowerCase();
    if(mn==="everyone"||mn==="all"||mn==="user")continue;
    for(let mem of __T__){
      if(String(mem.name||"").toLowerCase()===mn||String(mem.title||"").toLowerCase()===mn){targets.push(mem);break;}
    }
  }
  __APP__(__E__,{kind:"user",name:"You"},__A__,__S__,__O__);
  __UPD__(__E__,room=>({...room,members:__DUR__(__T__)}));
  let sessions=(__STORE__.get()[__E__]||{}).sessions||{};
  let post=(label,text)=>__APP__(__E__,{kind:"user",name:label},text,__S__,null);
  let drive=()=>{
    __ACT__(__E__,{kind:"queued",member:"You",thread:__S__});
    __QUEUE__(__E__,__T__,__S__);
  };
  if(targets.length){
    let memkey=__MK__(targets[0]);
    let sid=sessions[__GSK__(__S__,targets[0])]||(__HTS__(sessions,memkey)?null:sessions[memkey]);
    if(!sid){post(String(targets[0].name||"?"),"/"+cmdName+" skipped: no live session for this member");return __S__;}
    __Q__.request("command.dispatch",{session_id:sid,name:cmdName,arg:cmdArg}).then(res=>{
      let type=res&&res.type;
      if(type==="exec"||type==="plugin"){post(String(targets[0].name||"?"),(res.output||"").slice(0,3000));}
      else{drive();}
    }).catch(()=>{drive();});
  }else{
    __Q__.request("session.list",{}).then(lst=>{
      let row=Array.isArray(lst&&lst.sessions)?lst.sessions.find(x=>!x.profile||x.profile==="default"):null;
      let sid=row&&(row.resolved_id||row.id);
      if(!sid){drive();return;}
      __Q__.request("command.dispatch",{session_id:sid,name:cmdName,arg:cmdArg}).then(res=>{
        let type=res&&res.type;
        if(type==="exec"||type==="plugin"){post("Room",(res.output||"").slice(0,3000));}
        else{drive();}
      }).catch(()=>{drive();});
    }).catch(()=>{drive();});
  }
  return __S__;
}"""

SENTINELS = {"__E__": "e", "__T__": "t", "__A__": "a", "__O__": "o", "__S__": "s",
             "__APP__": "app", "__UPD__": "upd", "__DUR__": "dur", "__ACT__": "act",
             "__QUEUE__": "queue", "__STORE__": "store", "__MK__": "mk", "__Q__": "q",
             "__GSK__": "gsk", "__HTS__": "hts"}


def find_bundle(explicit=None):
    if explicit and os.path.isfile(explicit):
        return explicit
    cands = glob.glob(os.path.join(
        os.path.expanduser("~/.hermes/hermes-agent/apps/desktop/release/mac-arm64/"
                           "Hermes.app/Contents/Resources/app.asar.unpacked/dist/assets/index-*.js")))
    return cands[0] if cands else None


def fill(pat, names):
    """Substitute {token} placeholders with re.escape'd discovered names.
    NOT str.format: probe patterns contain literal `{` regex braces that
    str.format would try to parse (only exact {word} tokens are substituted)."""
    return re.sub(r"\{(\w+)\}", lambda m: re.escape(names[m.group(1)]), pat)


def discover(data):
    """Run HEAD + PROBES; return (names, None) or (None, reason)."""
    m = re.search(HEAD, data)
    if not m:
        return None, "sendToGroupChat head shape not found"
    names = dict(m.groupdict())
    window = data[m.start():m.start() + 1500]

    for pat, in_window, outs in PROBES:
        hits = list(re.finditer(fill(pat, names), window if in_window else data))
        if len(hits) != 1:
            return None, f"probe {pat[:34]}... -> {len(hits)} hits (need exactly 1)"
        for out_name, grp in outs:
            names[out_name] = hits[0].group(grp)

    # cross-check: groupSessionKey's inner member-key call == groupMemberKey
    if names["mkx"] != names["mk"]:
        return None, "member-key cross-check failed (mk != groupSessionKey inner call)"
    return names, None


def main():
    path = find_bundle(sys.argv[1] if len(sys.argv) > 1 else None)
    if not path:
        print("NO BUNDLE FOUND")
        return 1
    data = open(path, encoding="utf-8").read()
    base = path.split("/")[-1]

    if MARKER in data:
        print(f"ALREADY PATCHED ({base}) — no-op")
        return 0

    names, reason = discover(data)
    if names is None:
        print(f"ANCHOR MISSING in {base} — {reason}; build shape changed, slash patch unverified")
        return 3

    n = names  # all discovered names are JS identifiers — safe as literal text
    anchor = f"let {n['s']}={n['r']}||{n['mint']}();"
    guard = f"if({n['guard']}({n['a']}))return null;"
    guard_new = f"if({n['i']}&&{n['i']}.length&&{n['guard']}({n['a']}))return null;"

    if data.count(anchor) != 1:
        print(f"ANCHOR MISSING in {base} — anchor text not globally unique "
              f"({data.count(anchor)} hits); needs manual review")
        return 3
    if data.count(guard) != 1:
        print(f"ANCHOR MISSING in {base} — guard call not uniquely found "
              f"({data.count(guard)} hits); needs manual review")
        return 3

    snippet = SNIPPET
    for sent, key in SENTINELS.items():
        snippet = snippet.replace(sent, names[key])
    new = data.replace(anchor, anchor + snippet, 1)
    new = new.replace(guard, guard_new, 1)
    if new == data:
        print("patch produced no change — abort")
        return 1

    open(path, "w", encoding="utf-8").write(new)
    print(f"PATCHED {base} -> group slash commands enabled in {names['fn']} "
          f"(queue drive {names['queue']}; guard {names['guard']} now rejects only "
          f"command-shaped sends that carry attachments)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
