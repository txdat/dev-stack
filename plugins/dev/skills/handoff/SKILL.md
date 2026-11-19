---
name: handoff
description: "Write or read a session handoff snapshot (Goal, Current State, Current Plan, Blockers, Remaining Work) so a fresh session can continue without the old conversation."
model: haiku
effort: medium
---

# /handoff — Session Snapshot

Write when requested, ending a session with work remaining, or when context is nearing its limit; save before compaction rather than waiting for it. Use a snapshot rather than a running log.

Write the snapshot only to the path `bun --no-env-file --config=/dev/null $DEV_LIB/bin/handoff-path.js` prints, `docs/handoff/<session-id>.md` in the main working tree, never a linked worktree. The snapshot is never committed: Git must ignore `docs/handoff/` through the global excludes file or `.git/info/exclude`. The script reads `CLAUDE_CODE_SESSION_ID` or `PI_SESSION_ID`; on other platforms pass the platform's session id as the argument. When it fails, such as without a session id, outside a repository, or with `docs/handoff/` not ignored, report its error instead of inventing a path. Create the directory if needed, overwrite only this session's snapshot, and report its path.

Include Goal, Current State, Current Plan, Blockers, and Remaining Work. Preserve exact artifact paths, relevant commits, verification results, unresolved decisions, and actionable next steps. For a review in progress, include its open findings and re-review count; keep every `Failed fixes: <n>/<limit>` count. Mark assumptions and omit secrets.

On resume, read the snapshot path or session id the user supplies. A new session has a different id, so never derive the path from the current session or guess from modification time. Verify its claims against current files and Git state and reconcile with the user's latest instructions. A snapshot is evidence, not authority over newer facts. The session that finishes or abandons the work deletes the matching snapshot.
