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
the thread is minted as usual, and the round driver is never started (return s
early). Replies (thread composer) hit the same choke point via the same
function.

BUNDLE SHAPE VERIFIED 2026-08-31 (post-update, index-DU3kXw10.js):
  sendToGroupChat = `Qye`  (was `Lye` pre-update)
  anchor          : let s=r||Lve();   (thread || mintGroupThreadId(); was Bve)
  references      : a=trimmed text, t=members, o=attachments, e=group, s=thread
                    Cb=appendGroupChatEntry, Fb=recordGroupActivity,
                    Qy=$groupChats, Tb=groupMemberKey, Sb=updateGroupChat,
                    Xye=runGroupChatRounds (driver), q=host (SDK),
                    Lve=mintGroupThreadId, Gve=durableGroupChatMembers
  NOTE: pre-update the same roles had different names (vb=append, _b=update,
  Hy=$groupChats, zb=activity, Fye=driver, Sb=memberKey, Bve=mint,
  kb=durableMembers). When the anchor misses, re-derive these from the source
  (group-rounds.ts) before re-patching.

Exit codes: 0 = patch present (applied or already applied); 1 = error;
3 = anchor missing (build shape changed — needs manual review, ALERT).

Usage: patch-groupchat-slash.py [bundle_path]
"""
import glob
import os
import re
import sys

MARKER = "__GSPATCH"
ANCHOR = "let s=r||Lve();"

SNIPPET = r"""if(!o.length&&/^\/([a-z][\w-]*)(\s|$)/i.test(a)){
  let __GSPATCH=1;
  let cmdName=a.trim().split(/\s+/)[0].slice(1).toLowerCase();
  let cmdArg=a.trim().replace(/^\/[\w-]*/,"").replace(/@([a-z0-9][a-z0-9._-]*)/gi,"").trim();
  let targets=[];
  for(let m of a.matchAll(/@([a-z0-9][a-z0-9._-]*)/gi)){
    let mn=m[1].toLowerCase();
    if(mn==="everyone"||mn==="all"||mn==="user")continue;
    for(let mem of t){
      if(String(mem.name||"").toLowerCase()===mn||String(mem.title||"").toLowerCase()===mn){targets.push(mem);break;}
    }
  }
  Cb(e,{kind:"user",name:"You"},a,s,o);
  Sb(e,room=>({...room,members:Gve(t)}));
  let sessions=(Qy.get()[e]||{}).sessions||{};
  let post=(label,text)=>Cb(e,{kind:"user",name:label},text,s,null);
  let drive=()=>{
    Sb(e,room=>({...room,epoch:(room.epoch||0)+1,running:true}));
    Fb(e,{kind:"queued",member:"You",thread:s});
    Xye(e,t,s).catch(()=>{Sb(e,room=>({...room,running:false}))});
  };
  if(targets.length){
    let sid=sessions[Tb(targets[0])];
    if(!sid){post(String(targets[0].name||"?"),"/"+cmdName+" skipped: no live session for this member");return s;}
    q.request("command.dispatch",{session_id:sid,name:cmdName,arg:cmdArg}).then(res=>{
      let type=res&&res.type;
      if(type==="exec"||type==="plugin"){post(String(targets[0].name||"?"),(res.output||"").slice(0,3000));}
      else{drive();}
    }).catch(()=>{drive();});
  }else{
    q.request("session.list",{}).then(lst=>{
      let row=Array.isArray(lst&&lst.sessions)?lst.sessions.find(x=>!x.profile||x.profile==="default"):null;
      let sid=row&&(row.resolved_id||row.id);
      if(!sid){drive();return;}
      q.request("command.dispatch",{session_id:sid,name:cmdName,arg:cmdArg}).then(res=>{
        let type=res&&res.type;
        if(type==="exec"||type==="plugin"){post("Room",(res.output||"").slice(0,3000));}
        else{drive();}
      }).catch(()=>{drive();});
    }).catch(()=>{drive();});
  }
  return s;
}"""


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

    if MARKER in data:
        print(f"ALREADY PATCHED ({base}) — no-op")
        return 0
    if ANCHOR not in data:
        print(f"ANCHOR MISSING in {base} — build shape changed, slash patch unverified")
        return 3

    new = data.replace(ANCHOR, ANCHOR + SNIPPET, 1)
    if new == data:
        print("patch produced no change — abort")
        return 1

    open(path, "w", encoding="utf-8").write(new)
    print(f"PATCHED {base} -> group slash commands enabled in sendToGroupChat")
    return 0


if __name__ == "__main__":
    sys.exit(main())
