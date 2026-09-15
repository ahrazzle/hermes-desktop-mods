# Quarantined: `backup-2026-09-06/` removed from the public tree

The directory `backup-2026-09-06/` was removed from the repository on this
branch. It was a dated snapshot of a single machine's Hermes install: a bulk
copy of upstream source (a vendored `hermes-agent` checkout) plus local
config, desktop plugins, and skills.

## Why it was removed

- **Licensing.** It packages a large amount of third-party (upstream) source
  whose license and redistribution status for this snapshot has not been
  resolved. Publishing it is a licensing question, not a branding one, and it
  is raised in the pull request body.
- **Instance material.** It also carries machine-specific configuration and
  skills that do not belong on a public surface.

## Reversibility

Nothing was deleted from `main`. This is a branch-only removal and is fully
reversible:

- The snapshot is preserved outside the repository tree, in the maintainer's
  local quarantine (not tracked, not published).
- Its full contents remain in git history. Recover with either:

      git show <commit>^:backup-2026-09-06/README.md

  or check the directory out from the commit that still contained it:

      git checkout <commit>^ -- backup-2026-09-06

The directory should not return to the public tree until the license question
is resolved.
