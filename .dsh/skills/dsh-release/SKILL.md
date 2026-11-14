---
name: dsh-release
description: Use for DSH Chapters issue branches, staging integration, release candidates, production hotfix preparation, or release verification.
---

# Deliver DSH Chapters changes

Follow the [project instructions](../../../AGENTS.md),
[Scaffold release workflow](../release-workflow/SKILL.md) and
[DSH verification](../dsh-verification/SKILL.md). Use the actual GitHub settings
and CI workflows for the candidate. This skill defines DSH conventions within
the user's authority.

## Feature and fix work

Adopt or create the issue with observable acceptance before editing. Start an
issue-numbered branch from the verified latest origin/staging. Keep commits
conventional, imperative and issue-linked. Resolve conflicts on the work branch.
Before opening or merging the PR, verify the intended base and update the work
branch from staging when needed. Refresh affected evidence after changes.

Open the PR to staging with an issue-linked title, scope, acceptance checklist
and actual testing evidence. Use a non-closing issue reference on staging.
Keep acceptance boxes accurate and cross-link the issue and PR. Record material
progress, decisions and blockers on the issue and update the PR with observed
CI results. Keep test and review feedback tied to the current candidate.
Integrate by squash when authorized and all applicable acceptance, checks and
review gates pass. Verify the merge on the fetched target and clean up only the
task-owned branch after checking for later work, open PRs and worktree use.

## Production release

Prepare an authorized candidate from staging to main. Include the version changes
in the reviewed candidate before merge, keeping the manifest, lock root and
plugin version source in agreement. Derive notes and any issue closure references
from the actual previous-release-to-candidate range. List unfinished criteria and
included deficits. Confirm closure eligibility and verified forge behavior.

Require current CI, review and relevant installed or live proof as defined by the
claims. Agents never approve PRs or merge to main. The maintainer controls
production merges and publication. For an explicitly authorized emergency hotfix,
prepare an isolated branch from main, use the applicable reviewed fast gate and
record the staging reconciliation step. Urgency alone provides no exception.
Sync the resulting main change back to staging under the maintainer's authority.

Use bare semantic versions, with major for breaking changes, minor for features
and patch for fixes, docs or chores. Development prereleases use the established `-dev.N`
suffix. The tag must match the package version and point to the
verified main commit. Pushed tags are immutable: never delete, move or reuse one.
A failed or incorrect published identity gets a new version, with the old one
recorded as superseded or failed. A tag that has remained local may be corrected
before publication.

Verify the authorized tag-triggered release and the actual registry tarball.
Distinguish build, publish, tarball availability, installed proof and the user's
loaded process. Verify environment parity for the intended host, then report any
drift and the authorized install or restart needed to deliver the fix.
