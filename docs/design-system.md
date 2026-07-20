# Aisle visual system

The foundation uses an original “ink and electric iris” direction. Restrained surfaces and editorial typography keep dense marketplace information legible, while the aisle-rail motif shows multiple sources converging into one stack.

## Tokens

Tokens live in `app/globals.css` and are the source of truth.

- **Ink:** near-black page and raised-surface colors; never pure black-on-white dashboard chrome.
- **Electric iris:** primary action, focus, and provenance-rail accent.
- **Mint:** positive status only. It is not a blanket “safe” label.
- **Paper and muted:** primary and secondary text with AA contrast on their intended surfaces.
- **Line:** low-contrast structure; `line-strong` is reserved for interactive hover and selected states.
- **Radius:** small controls, medium cards, and large editorial surfaces.
- **Motion:** short feedback transitions using the shared ease-out curve. Reduced-motion preferences collapse animation durations.

Typography uses locally packaged Manrope Variable for editorial and interface copy, plus JetBrains Mono Variable for commands, metadata, and provenance labels. No build-time font network request is required.

## Component contract

- Buttons and interactive links provide a 44px minimum target.
- Focus rings remain visible and are not replaced by color-only hover states.
- Radix Dialog supplies focus management and escape behavior for global search and the mobile sheet.
- `CommandBlock` announces clipboard success/failure through a polite live region.
- Badges communicate text labels in addition to color.
- Empty, loading, not-found, and recoverable error states are first-class routes/components.
- Icons come from Lucide; decorative hand-authored SVGs are not part of the system.

## Product-shell boundary

The foundation includes navigation and honest route states but no fabricated catalog entries. Later product work should replace placeholders through server-rendered data contracts while retaining the shared header, footer, tokens, states, and accessibility behavior.
