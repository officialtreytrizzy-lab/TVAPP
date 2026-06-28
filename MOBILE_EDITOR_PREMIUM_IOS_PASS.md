# Premium Mobile Editor iPhone Safari Pass

## Goal

Upgrade the existing Mobile Editor so it feels more premium, helps first-time users understand what to do, and fits cleanly inside an iPhone Safari viewport with safe-area handling.

## What changed

### `src/components/opencut-mobile/MobileOpenCutStudio.tsx`

- Reworked the Mobile Editor shell into a polished dark glass interface.
- Added a premium first-time onboarding screen before a clip is imported.
- Added a clear 3-step first-run flow: import, edit, export.
- Added trust/status chips for 9:16, safe-area tuning, and tap-first controls.
- Improved the editor header with clearer project naming, save, and export actions.
- Reworked the preview card with premium framing, status chips, visible metadata, and a larger play target.
- Reworked the timeline section with hidden scrollbars, larger thumb targets, and clearer clip cards.
- Reworked the active tool panel with a header, active tool icon, clearer controls, and larger touch targets.
- Moved the tool dock into a fixed iPhone-style bottom tray with safe-area padding.
- Kept the existing import, trim, split, text, volume, speed, aspect, render, save, and download functionality intact.

### `src/index.css`

- Added full-height background support for `html`, `body`, and `#root` so iPhone Safari does not flash a light background around the app.
- Kept the existing safe-area utilities.
- Added a `no-scrollbar` utility for horizontal tool/timeline rails.

## iPhone Safari notes

- The layout uses `100dvh` through the existing `min-h-dvh` utility.
- Header uses `pt-safe`.
- Main editor spacing uses `env(safe-area-inset-bottom)` so the fixed bottom dock clears the iPhone home indicator.
- Bottom tool dock uses `pb-safe`.
- Import and editor buttons are sized for thumb/tap use.
- The editor stays constrained to a phone-width max layout so it does not stretch awkwardly on desktop Safari.

## Verification checklist

After deployment, verify on iPhone Safari:

1. Open `/studio` or `/mobile-editor`.
2. Confirm the first-time screen appears before importing a video.
3. Confirm the import button opens the iOS file picker.
4. Import an MP4/MOV video.
5. Confirm the preview fits the visible Safari viewport without hiding under the address bar or home indicator.
6. Confirm the bottom tool dock remains reachable and does not overlap critical controls.
7. Test Trim, Split, Text, Audio, Speed, FX, and Export tabs.
8. Confirm Save still downloads the project JSON.
9. Confirm Render still produces an export and Download still works.

## Scope

This was a design and mobile layout pass only. The editor engine and export pipeline were not rewritten.
