# Diagram Pages

This file owns the format of an HTML page that carries Mermaid diagrams, such as an architecture document ([design-system](../skills/design-system/SKILL.md)) or an explanation page ([explain](../skills/explain/SKILL.md)). The skill that writes a page owns its path, `<slug>`, language, and sections.

## Page

Write one HTML file, optionally with inline `<style>`, loading nothing but the Mermaid import shown; diagrams need network access to render:

```html
<!doctype html>
<html lang="{language code}"><head><meta charset="utf-8"><title>{title}</title></head><body>
<h1>{title}</h1>
<h2>{section}</h2>
<pre class="mermaid">sequenceDiagram
  Client->>Orders: POST /orders</pre>
<script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@{mmdc major}/dist/mermaid.esm.min.mjs";</script>
</body></html>
```

When `mmdc` is installed, pin the import to the major version of the local `mmdc --version`, such as `mermaid@12`, so the browser renders what the render check accepted; without it, a page under `/tmp` imports `https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.esm.min.mjs` unpinned.

## Diagrams

A diagram shows only what its text states. Open each with exactly `<pre class="mermaid">`. In its source, write `<` as `#lt;` and `&` as `#amp;`, never as raw characters or HTML entities.

## Render check

Render each diagram, numbered from 1 in page order, by piping its source unchanged to `mmdc -i - -o /tmp/<slug>-<n>.svg`; a nonzero exit is a rejection. Fix every rejected diagram.

Without `mmdc`, the agent delivers a page under `/tmp` and reports its diagrams unrendered; for any other page, such as an architecture document, the agent running the render check stops and reports that the diagrams are unrendered.
