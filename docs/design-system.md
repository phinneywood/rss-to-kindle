# Long Form visual system

Reference: `phinneywood/personal-site`, `src/pages/index.astro`, inspected alongside the production Long Form UI on 2026-09-26. The relationship is a shared visual language, not a shared homepage layout.

## Foundations

| Role | Token / treatment |
| --- | --- |
| Paper | `#f7f5f0` — one warm page background, including sheets |
| Ink | `#28342e` — green-charcoal headings and primary actions |
| Reading text | `#4d5650` |
| Supporting text | `#62675f` — readable metadata, not faint gray |
| Accent | `#913d30` — rust, reserved for orientation, focus, attention |
| Rules | `#d8d9ce` — structural separation, never a box around every group |
| Controls | `#858b7e` borders on `#faf9f5`; inputs stay clearly identifiable |
| Context surface | `#e9eddf` — flat, muted sage for useful notices |
| Error surface | `#f2e7e1`, with rust text and an explicit explanation |

Typography has three roles. System editorial serif (`Iowan Old Style`, Palatino, Georgia) carries major hierarchy at regular weight with modest negative tracking. System sans carries prose, forms, controls, and source names. System monospace is reserved for dates, counts, URLs, operational metadata, and short labels. No external font requests or font packages.

The spacing scale is 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64px. Mobile gutters are 24px (18px below 361px), expanding to 40px and 56px. Major headings scale fluidly; supporting UI does not become microscopic to fit. Text inputs are at least 16px to avoid focus zoom on iOS.

Edges are square. The only general radius is 2px on controls. Status dots are circular, but status text has no pill container. No gradients, glass, blur, decorative shadows, large-radius cards, or illustration dependency.

## Composition

The home remains a single ordered narrative: **Next issue → Sources → Customize your AI editor**. Its sections are unboxed. The issue date is the dominant serif heading; the source list stays collapsed initially, with Add source and Import OPML in that same section. The editor remains directly available on home, with a short guidance preview and explicit customization state.

Desktop extends this structure rather than introducing dashboard columns or rearranging its information architecture. Secondary issue actions and source controls can share horizontal space. Long article review uses a wider reading sheet; shorter interactions use a narrower sheet. Mobile sheets use the available width, with independent scrolling, safe-area padding, and full-height article review.

Sign-in, verification, starter packs, onboarding, source management, OPML review, editor settings, article browsing, delivery history, Kindle settings, system health, and the legal pages all use `styles.css`. Loading, empty, paused, failure, and setup-needed states use the same type and spacing rules.

## Interaction and accessibility

Filled ink buttons mean primary commitment. Ordinary actions are text with an underline or a directional affordance; they retain generous click/touch areas. Hover changes are subtle color/surface changes, enabled only on hover-capable devices. Transitions are 180ms and honor reduced-motion preferences.

Buttons retain a minimum 44px touch area. Inputs have visible borders, explicit labels, and a 2px rust focus outline. Native input semantics, keyboard operation, Escape, focus trapping, return focus, and unsaved-change confirmation remain intact. The modal focus trap includes native disclosure summaries and ignores hidden disclosure contents. Opening a sheet makes the underlying app inert and locks page scroll; closing restores both. A skip link and common main landmark serve every full-page flow. Forced-colors support remains explicit.

State is never conveyed by color alone. Error messages, paused sources, and delivery status retain explanatory text. Submitted delivery still means acceptance by the email provider, not verified Kindle arrival.

## Audit and replacement

The old interface had accumulated several inline redesign layers: repeated root tokens and component definitions, conventional white controls, heavily rounded containers, a blurred overlay, multiple competing rules, bold black hierarchy, tiny metadata, and bright-red decoration. This combination created the dashboard-template feeling even where the information architecture worked well.

The refactor removes the complete old inline stylesheet, not just its last layer. Presentation-only inline attributes in the application and OPML views become shared spacing/layout classes. The legal pages load the same stylesheet instead of their own inline styles. Redundant home labels are removed; meaningful source, delivery, and editor information remains.

Existing class and element IDs used by behavior are intentionally retained where useful. For example, `issue-card` is now an unboxed section, not a second visual component. New rules belong in the relevant foundation/control/pattern/composition section of the stylesheet, not at its end as a new theme.

No API payloads, database schemas, authentication contracts, scheduling rules, publishing logic, or email-delivery contracts change. The small JavaScript changes are presentation/accessibility fixes: landmarks, labels, disclosure focus handling, sheet scroll locking, and correct dialog state when entering Kindle setup or replacing an OPML/error dialog.

## Verification

`node --test tests/*.test.mjs` retains the existing behavioral regression suite. The previous bright-red CSS assertion is replaced by a shared-system/no-legacy-layer assertion.

`tests/browser.mjs` runs against the real HTML/CSS/JavaScript in Chromium and WebKit at 320, 390, 768, and 1440px. It intercepts all application API requests and uses a synthetic reader; no production account is accessed and no email is sent. It exercises email-code sign-in, disclosures, source editing, OPML selection, editor saving, browsing, article review, account navigation, and keyboard focus. Screenshots include scrollable-sheet bottoms. The report records automated WCAG A/AA checks and horizontal overflow across normal, empty, paused, loading, setup, and error states.

Automated checks complement visual inspection; they are not a claim of exhaustive accessibility certification or physical-device testing. Browser evidence is retained as CI artifacts. Run the browser workflow together with the existing full CI before merging changes to this system.
