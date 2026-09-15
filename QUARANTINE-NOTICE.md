# Quarantined: `backup-2026-09-06/` removed from this branch

The directory `backup-2026-09-06/` is **not present on this branch**. It was a
dated snapshot of a single machine's Hermes install: a bulk copy of upstream
`hermes-agent` source plus local config, desktop plugins, skills and contact
details.

## Open licence question

The snapshot bulk-copies third-party upstream source whose licence and
redistribution status for this repository has **not been resolved**. Until that
is settled the material must not be published — or republished — here. This is
the reason for its removal, and it is an **open item** that also blocks any
future re-inclusion of the directory.

## State of this branch

- `backup-2026-09-06/` is absent from the branch tree
  (`git ls-tree -r <branch>` lists no such path).
- The files were never committed on this branch, so there is nothing to rewrite
  here.

## Where the snapshot still exists — and must be handled elsewhere

Removing files from a branch makes them appear as **deletions** in this pull
request's diff against `main`, and they remain in `main`'s history. This branch
therefore does **not**, by itself, take the material out of public view:

- `main` still contains the snapshot.
- This PR's diff renders the removed content.

Closing the exposure requires action on `main` — a history rewrite, or
repository recreation/rotation. That is deliberately outside the scope of this
branch and is flagged in the pull request body.

## Reversibility

The snapshot is preserved outside the repository tree (maintainer's local
quarantine), and its full contents remain in git history. If the licence
question is ever resolved, recover it with:

    git show <commit>^:backup-2026-09-06/README.md

    git checkout <commit>^ -- backup-2026-09-06
