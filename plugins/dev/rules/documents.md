# Design Documents

The lifecycle of runbooks ([design-infra](../skills/design-infra/SKILL.md)) and architecture documents ([design-system](../skills/design-system/SKILL.md)). [artifact.md](artifact.md) owns their naming, prose language, and how their reviews run.

## Lifecycle

Each document is named under [artifact.md — Naming and language](artifact.md#naming-and-language) and is committed. Its design skill creates it; the main agent commits each change an agent makes to it, on the branch the project's convention names. Its header is `Key: value` lines before the first section heading, outside code fences, each key once:

```text
Status: draft
Spec: -
Issue: #N|none
```

| Status | Set by |
|---|---|
| `draft` | the design skill when it creates the document, `doc-review` with `needs-changes`, or the user returning an approved document for a change |
| `ready` | `node $DEV_LIB/bin/dev-stack.js doc-review <document> ready`, which the main agent runs on a passing review |
| `approved` | the user only, from `ready` |
| `executed` | a runbook only: the main agent, from `approved`, under [review-infra.md — After execution](../skills/review-infra/SKILL.md#after-execution) |

`Spec:` starts as `-` and holds the hash of the document without its `Status:` and `Spec:` lines, line-ending carriage returns, and trailing blank lines. `doc-review` sets it, or resets it to `-` with `needs-changes`; an agent may also reset a draft's `Spec:` to `-`. A review or approval holds only while `Spec:` equals that hash, so the user approves only a `ready` document whose Spec holds. After approval the document is frozen except for its Status line. `node $DEV_LIB/bin/dev-stack.js doc-check <document>` prints the Status and whether Spec holds, and exits 1 when a `ready` or later document's does not, or the header is malformed. The main agent runs it when it hands a `ready` document to the user for approval, and stops on exit 1. The main agent, before handing an approved runbook to the user to execute, and the agent running design-feature, before planning from an architecture document's `DC-n`, run it and stop on exit 1 or a Status below `approved`.

The [gate](../core/gate-check.js) refuses an agent's edit-tool call that changes a document's `Status:` or `Spec:` line, other than a runbook's `approved` to `executed` or a draft's `Spec:` reset to `-`, drops either line, repeats a header key, creates a document at a Status other than `draft` or a Spec other than `-`, or changes a frozen document, and one that writes a runbook's `log` below `approved` or changes an entry already in it. It never checks a shell command against documents, as they are tracked files that Git operations change: `doc-check` catches a shell change to a reviewed body or to `Spec:`, but nothing catches a shell command that sets `Status:`, such as an agent approving or executing a document itself, or that rewrites a runbook's `log`, and nothing gates an append or `executed` on a runbook whose Spec no longer holds.

## Runbook

A runbook lives at `docs/runbook/<issue>_<slug>/rb.md`; its section heading is a `## ` line. Its execution record is the `log` beside it, which is never committed: before its first entry, the main agent runs `git check-ignore -q <log>` and, when that fails, adds `/docs/runbook/*/log` to the file `git rev-parse --git-path info/exclude` names; no gate verifies it. The `log` takes `EX-n` entries, appended with an edit tool, only while the runbook is `approved` or `executed`. Before appending an after-execution audit's `EX-n` entry or setting `executed`, the main agent runs `doc-check`; on exit 1 or a Status below `approved`, it appends nothing to the `log` and never sets `executed`.

## Architecture

An architecture document lives at `docs/architecture/<issue>_<slug>.html`; its section heading is an `<h2>`, and it carries the header lines in a `<pre>` under its `<h1>`.
