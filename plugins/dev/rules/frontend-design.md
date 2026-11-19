# Frontend Design

This file is guidance for UI work. The agent doing the work decides how to apply it and which checks to run for the change. A departure from it never blocks a review or a workflow step.

## Direction

- Use the project's existing design system, components, layout grid, and density. When the project has none but depends on a component library, build with that library before writing new components.
- Before designing a new view, read the project's existing screens.
- For a new view, or a change the existing screens do not already decide, pick the audience, the primary task, the information hierarchy, and any material visual direction from the existing screens and the requirement; ask the user only when a material product choice is open and blocks the work. Under autopilot, decide open choices under [autopilot.md — Decisions](../skills/autopilot/SKILL.md#decisions).
- For each new view, name its mode, which sets how far the design goes beyond the platform's conventions:
  - **Operate**, such as an app screen, dashboard, or settings: standard controls and navigation, and accent color only on the primary action, links, selection, and state;
  - **Read**, such as documentation or an article: body text at least 16 px on the web;
  - **Persuade**, such as a landing or marketing page: palette, type, and composition may carry the brand.
- When the project has no design system, the visual direction includes a palette (neutrals, one accent color, and colors for error, warning, and success), type roles such as heading, body, and label, a spacing scale, at most two font families, and a layout grid.
- In plan-backed work, design-feature records material visual choices that the requirement, the user, or autopilot establishes — including a new view's mode — as DDs. In a direct edit, the main agent reports any material visual choices with its result.

## States

- Design a layout for each screen or window size the product supports.
- Design each loading, empty, error, success, disabled, and focus state the flow can reach.
- Make an empty state say why it is empty, such as first use, no results, or a filter hiding results, and name the action that fills it when one exists.
- Validate forms. Retain user input after a recoverable failure.
- Preserve semantic roles, keyboard access, visible focus, accessible names, readable contrast, and reduced-motion preferences.

## Interface text

- Write in the user's domain terms. Never show internal identifiers, such as field names, error codes, or enum values, except a reference code the user quotes to support.
- Name an action control by its result, such as "Save changes" rather than "Submit", and keep that name through the flow, such as "Publish" confirming as "Published".
- Make an error message state what happened and how to fix it, or what the user can do next, such as retry later. Never put an apology in its place.
- Never present invented figures, reviews, quotes, customers, or names as real; label demonstration data as sample data. Never show filler text, such as lorem ipsum or `TODO`.
- Give each field a visible label; never use its placeholder as the label.
- Name the action on a destructive action's confirmation button, never "Yes" or "OK". When the action can be undone, offer undo instead.

## Visual

- Take sizes, colors, spacing, radii, and shadows from the design system or the chosen direction, never a one-off value.
- Make the content the information hierarchy ranks first the most prominent in its view. Give each form or dialog at most one primary action.
- Make space between groups larger than space within a group, and space above a heading larger than below it.
- Use borders, dividers, shadows, and gradients to mark grouping, boundary, order, or state, never as decoration alone.
- Never convey meaning by color alone. Set numbers that align in columns, such as in a table, in tabular figures. Number only ordered items, such as steps.
- Keep body text lines under 80 characters, and at most 75 on a Read view, unless the design system sets the measure.
- Never add these unless the user or the design system asks for one: a page of same-size icon, heading, and text cards; a card nested in a card; gradient text; a colored stripe on one side of a card; emoji in place of icons.
- Choose typography, spacing, imagery, and motion for the content and primary task. No particular aesthetic or signature effect is required.

## Motion

- Make motion that responds to a user action show what changed.
- Run motion the user did not trigger, such as an entrance animation, at most one sequence per view, and none on an Operate view. Loading and progress indicators do not count.
- Keep content visible when its animation does not run, such as under reduced motion.
- Never use bounce or elastic easing. Give motion the user did not trigger that runs longer than 5 seconds a control that pauses or hides it.

## Verification

When the agent doing the work verifies the UI, it verifies the rendered UI, not only its code, with checks it picks, such as:

- **Layout:** at each supported size, no changed view clips content its design does not truncate, scrolls in a direction its design does not, or lets one control hide another outside an open overlay, such as a dialog or menu.
- **States:** each changed state is reachable from the flow's entry; force a state that depends on an external result by simulating that result.
- **Access:** keyboard reach with visible focus, focus order that follows the visual order, accessible names and roles, and contrast that meets the platform's guideline, such as WCAG 2.2 AA on the web.
- **Interface text and Visual:** the rules above hold for changed views, judged from screenshots.

Use the project's UI test tooling, else a UI automation tool such as Playwright for a web app, run from a directory under `/tmp` with its caches there. Save screenshots, and verification scripts that are not the change's tests, under `/tmp`. Never add a test tool to the project's dependencies to run these checks. Report each check it picked but could not run, with the result.

Material behavior and visual commitments belong in the plan's ACs or DDs. A recorded AC or DD binds like any other; this file's guidance does not.
