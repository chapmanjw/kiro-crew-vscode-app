// The VS Code layout setting the launcher writes into the server's Machine
// settings so the workbench's edges meet the pane card flush.
//
// VS Code 1.146 turns on the Modern UI by default
// (workbench.experimental.modernUI, default true,
// browser/workbench.contribution.ts:849-854). It draws the side bars and the
// bottom panel as floating cards with a 1px border, rounded corners and a 4px
// gutter on every edge facing window chrome, the status bar included
// (browser/media/floatingPanels.css: --modern-ui-floating-card-outer-margin and
// --modern-ui-floating-card-statusbar-margin = spacing-size40). Inside our pane
// card those outer cards sit 4px in from its own 16px-rounded border, so the
// bottom of each part shows a strip and a second rounded corner above the
// status bar. The gutter is also baked into the layout code
// (FLOATING_PANEL_MARGIN = 4, getFloatingPanelOuterMargin,
// services/layout/browser/layoutService.ts:80-103), so a stylesheet cannot
// remove it without desynchronising the parts' content sizes.
//
// The supported switch is the Modern UI layout density, window.density.layout
// "compact" (workbench.contribution.ts:275-284): "Removes the gaps between
// workbench parts", with COMPACT_FLOATING_PANEL_OUTER_MARGIN = 0 in code and
// radius 0 on .part.sidebar/.panel/.auxiliarybar and the editor in CSS. It is
// window-scoped, so the remote's Machine settings apply; a user setting still
// overrides it.
export function layoutSettings() {
  return { 'window.density.layout': 'compact' };
}
