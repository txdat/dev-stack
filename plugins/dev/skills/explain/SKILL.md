---
name: explain
description: "Explain how a codebase mechanism works, for questions such as \"how does X work\", \"why does X do Y\", or \"walk me through X\": the path from trigger to result traced step by step with file references, invariants, design reasons, and gotchas, and, for three or more steps, a diagram page under /tmp. Changes nothing outside /tmp."
model: sonnet
effort: medium
---

# /explain — How It Works

Answer how a part of the codebase works. Scope the answer to the question and change nothing outside `/tmp`; locate the code under [explore](../explore/SKILL.md).

Trace the mechanism from its trigger to its observable result: the entry point, each step of control and data flow in execution order, the state each step reads or writes, and how failures exit. Read each definition a step calls; never infer behavior from names. When reading leaves a claim open, settle it by running existing tests that write only under `/tmp`, or read-only commands. Take design reasons only from code, comments, tests, docs, or history, such as `git log -L` or `git blame`; list a design reason no source states as open, never infer it.

When the question spans two or more mechanisms, walk through only the top-level flow, then list each mechanism under it with its entry point for a follow-up question.

When the walk-through has three or more steps, write `/tmp/<slug>.html` as a diagram page under [diagrams.md](../../rules/diagrams.md), with one `<h2>` per diagram, in the language of the answer. Its `<slug>` is `explain-<repo>-<mechanism>`, with the repository's directory name and the mechanism's name, each as lowercase words joined by hyphens. Use a `sequenceDiagram` for calls between components and a `flowchart` for branching, and label each node or participant with its file and symbol.

Return the answer in one paragraph, then the steps in order, each with its `file:line`, then invariants, design reasons, and gotchas, then the diagram page's path when one was written. Separate what the code shows from inference under [CODING.md — Changes and evidence](../../rules/CODING.md#changes-and-evidence), and list what stays open. Stop when the question is answered.
