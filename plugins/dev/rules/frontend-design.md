# Frontend Design

## Direction

- Use the project's existing design system and component patterns.
- Whoever sets the direction, design-feature or the main agent, reads the project's existing screens first. A new view must use their tokens, components, layout grid, and density unless the user chooses otherwise.
- Whoever sets the direction names each view's mode, which sets how far the design may go beyond the platform's conventions:
  - **Operate**, such as an app screen, dashboard, or settings;
  - **Read**, such as documentation or an article;
  - **Persuade**, such as a landing or marketing page.
- Establish with the user the audience, the primary task, the information hierarchy, and any material visual direction. Record the decisions the implementation must preserve.
- When the project has no design system, the visual direction includes, each chosen for the audience and primary task:
  - a palette: neutrals, one accent color, more only when the user chooses them or for a Persuade view, and colors for error, warning, and success;
  - type roles, such as heading, body, and label, each with one size, weight, and line height per screen or window size;
  - a spacing scale, such as multiples of 4 px;
  - a radius scale and a shadow scale;
  - at most two font families, plus a monospace face for code, identifiers, and raw values;
  - a layout grid with its alignment;
  - a density, such as more rows per screen for a data tool than for a marketing page.
- When the project has no design system but depends on a component library, build with that library before writing new components.
- In plan-backed work, design-feature records these decisions as DDs before approval.
- In a direct edit, the main agent establishes them before writing any of the change's code, records them in the message of the commit that carries the change, not the test commit, and reports them with its result.

## States

- Design a layout for each screen or window size the product supports.
- Design each loading, empty, error, success, disabled, and focus state the flow can reach.
- When a user action can fill an empty state, the empty state must name that action.
- An empty state must say why it is empty, such as first use, no results, a filter hiding results, or no permission.
- Validate forms. Retain user input after a recoverable failure.
- Preserve semantic roles, keyboard access, visible focus, accessible names, readable contrast, and reduced-motion preferences.

## Interface text

- Write in the user's domain terms.
- Never show internal identifiers, such as field names, error codes, or enum values. The exception is a reference code the user needs to quote to support.
- An action control's label must name the result of using it, such as "Save changes" rather than "Submit".
- An action must keep one name through the flow, such as "Publish" confirming as "Published".
- An error message must state what happened. When the user can fix it, it must state how; otherwise, it must state what the user can do next, such as retry later.
- Never put an apology in place of what happened or what to do next.
- Never present invented figures, reviews, quotes, customers, or names as real; label demonstration data as sample data.
- Never show filler text, such as lorem ipsum, `[Company Name]`, `{{token}}`, or `TODO`.
- A link's text must name its destination out of context, never "Learn more" or "Click here".
- Every field must have a visible label; never use its placeholder as the label.
- A destructive action's confirmation must name the action on its button, never "Yes" or "OK". When the action can be undone, offer undo instead of a confirmation.
- Loading text must name what it loads, such as "Loading invoices".

## Visual

- Implement with existing tokens and components before adding variants.
- On an Operate view, use the platform's standard controls and navigation, and accent color only on the primary action, selection, state, and the ranked-first content.
- On a Read view, body text must be at least 16 px on the web.
- Take every size, color, spacing, radius, and shadow from the design system or the recorded direction, never a one-off value.
- The content the information hierarchy ranks first must be the most prominent in its view, by size, weight, or contrast.
- Each view must have at most one primary action, styled as its most prominent control.
- Spacing between groups must be larger than spacing between items within a group. Space above a heading must be larger than space below it.
- Elements of the same kind, such as table rows or cards, must share one style across views.
- Align each element to the layout grid.
- Use borders, dividers, shadows, gradients, accent color, and icons only to mark a grouping, boundary, order, or state in the content, or to make the ranked-first content or the primary action prominent. Never add them as decoration alone, except to carry the brand the design system or recorded direction defines on a Persuade view.
- Never convey meaning by color alone; pair it with text, shape, or position.
- When the product has a dark theme, design its colors; never invert the light theme's.
- Set numbers in tables and other aligned columns in tabular figures.
- Never use these patterns unless the user asks for one:
  - a page built from same-size cards of icon, heading, and text; a card nested in a card;
  - on a Persuade view, a row of large figures over small labels;
  - an eyebrow label above a heading, other than a breadcrumb;
  - a colored stripe on one side of a card;
  - emoji or text glyphs in place of icons; monospace text outside code, identifiers, or raw values.
- Number only ordered items, such as steps.
- Body text lines must stay under 80 characters, 45 to 75 on a Read view, unless the design system sets the measure.
- Choose typography, spacing, imagery, and motion for the content and primary task. No particular aesthetic or signature effect is required.

## Motion

- Motion that responds to a user action must show what changed.
- Motion the user did not trigger, such as an entrance or attention animation, must run at most one sequence per view, and none on an Operate view; content never fades or slides in as the page scrolls. Loading and progress indicators do not count.
- Content must be visible when its animation does not run, such as under reduced motion or before the animation's script loads.
- A hover effect never moves a neighboring element or the hovered element's own target area.
- On the web, animate transform, opacity, and color; never animate layout properties, such as width, height, or margin, except to expand or collapse a region.
- An exit animation must be shorter than its entrance. Use the design system's easing, or ease-out; never bounce or elastic easing.
- Motion the user did not trigger that runs longer than 5 seconds, other than a loading or progress indicator, must have a control that pauses, stops, or hides it.

## Verification

Verify the rendered UI, not only its code.

- **Who:** whoever runs execute-feature; in a direct edit or after a review-code repair, the main agent. Each verifies after integrating any chunks it delegated. A reviewer runs the same checks when its review skill says so.
- **Tool:** the project's UI test tooling that computes layout and captures screenshots, such as a browser or device test runner. Without one, use a UI automation tool, such as Playwright for a web app. The agent running the checks may run that tool from a fresh directory under `/tmp`, with its package and browser caches there, such as through `BUN_INSTALL_CACHE_DIR` and `PLAYWRIGHT_BROWSERS_PATH`. It must point the app's build and server caches at `/tmp` too, or serve a build output copied there, so the run writes nothing into the worktree or a linked dependency.
- **Coverage:** each screen or window size and each theme the product supports, each changed state, and keyboard use. Force each state that depends on an external result by simulating that result. Under the Layout check, stress each changed view at one size with text 30% longer and with a single word, with 100 items where the view lists items, and at 200% zoom on the web or the platform's largest text size elsewhere.
- **Review:** capture a full-view screenshot of each changed state at each size after entrance motion settles. Before judging a screenshot, confirm it shows the state and size its name claims, with no blank or half-loaded region; recapture one that does not. Check Layout, Visual, and Content against each screenshot, and against the code for values. Check Flow, Access, and Motion by driving the UI.

Checks:

- **Layout:** no changed view clips content its design does not truncate. No changed view scrolls in a direction its design does not scroll. No interactive element covers another outside an open overlay, such as a dialog or menu. Images and late-loading content must reserve their space; compare a screenshot taken before they load with one taken after.
- **Flow:** each changed state is reachable through the UI from the flow's entry. Focus order follows the visual order. The [States](#states) rules hold.
- **Access:** every changed control is reachable and operable by keyboard with visible focus. The platform's accessibility tree exposes each changed element's semantic role and each changed control's accessible name. Changed text, and each changed control's boundary, icon, and focus indicator, meets the platform's accessibility contrast guideline, such as WCAG 2.2 AA for a web app. Each changed touch or click target meets the platform's minimum size, such as WCAG 2.2 AA's 24 by 24 CSS px with its exceptions on the web, 44 by 44 pt on iOS, 48 by 48 dp on Android.
- **Visual:** the [Visual](#visual) rules hold for changed views. Changed views match the recorded direction, and the project's existing screens except where the recorded direction departs from them.
- **Content:** the [Interface text](#interface-text) rules hold for changed content.
- **Motion:** the [Motion](#motion) rules hold, including under the platform's reduced-motion preference.

The implementing agent **Who** names, never a reviewer, fixes each failed check and verifies again. It fixes every failure one round of screenshots shows before capturing again. A reviewer reports a failed check as its review skill specifies.

Save screenshots, and verification scripts that are not the change's tests, outside the project tree, such as under `/tmp`. Never add a test tool to the project's dependencies to run these checks. Report each check left unrun under [CORE.md — Work](CORE.md#work), naming each state and size no screenshot covered.

Material behavior and visual commitments belong in the plan's ACs or DDs.
