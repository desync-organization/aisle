# Aisle visual system

The foundation uses a graphite marketplace direction with a blue interaction accent and semantic status colors. Layered surfaces, explicit active states, and editorial typography keep dense marketplace information legible, while the aisle-rail motif shows multiple sources converging into one stack.

## Tokens

Base tokens live in `app/globals.css`; the current marketplace palette and visibility overrides live in `app/visibility.css` and form the final rendered layer.

- **Graphite:** dark blue-black page, raised-surface, and elevated-surface colors provide visible depth without relying on shadows alone.
- **Action blue:** primary action, focus, current navigation, and selection accent.
- **Mint:** positive status only. It is not a blanket “safe” label.
- **Amber and coral:** warning and blocked/error states respectively.
- **Category accents:** a restrained non-purple set used only to improve package and category scanning.
- **Paper and muted:** primary and secondary text with AA contrast on their intended surfaces.
- **Line:** low-contrast structure; `line-strong` is reserved for interactive hover and selected states.
- **Radius:** small controls, medium cards, and large editorial surfaces.
- **Motion:** short feedback transitions using the shared ease-out curve. Reduced-motion preferences collapse animation durations.

Typography uses the locally packaged Geist Sans variable font for editorial and interface copy, plus JetBrains Mono Variable for commands, metadata, and provenance labels. No build-time font network request is required.

## Component contract

- Buttons and interactive links provide a 44px minimum target.
- Focus rings remain visible and are not replaced by color-only hover states.
- Radix Dialog supplies focus management and escape behavior for global search and the mobile sheet.
- `CommandBlock` announces clipboard success/failure through a polite live region.
- Badges communicate text labels in addition to color.
- Empty, loading, not-found, and recoverable error states are first-class routes/components.
- Icons come from Lucide; decorative hand-authored SVGs are not part of the system.

## Product boundary

The marketplace routes use server-rendered catalog, package, coverage, and install-plan contracts. Empty states remain honest: Aisle does not fabricate catalog entries or ship placeholder skills when public upstream data has not resolved.
