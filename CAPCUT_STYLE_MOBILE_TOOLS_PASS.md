# CapCut-Style Mobile Tools Pass

## Goal

Hook the iPhone Mobile Editor up with a larger CapCut-style toolset while keeping the existing one-folder editor and render pipeline intact.

## Tools added or expanded

### Real render/export-supported tools

- Filters
  - Clean
  - Glow
  - Film
  - Punch
  - Soft
  - Noir
  - Drama
  - Vivid

- Adjustments
  - Brightness
  - Contrast
  - Saturation
  - Blur
  - Opacity

- Transform
  - Rotate 90 degrees
  - Flip horizontal
  - Fit mode
  - Fill/cover mode
  - Reset transform

- Text and captions
  - Add text layer
  - Caption bar
  - Text presets
  - Hook title
  - Subtitle
  - Main title
  - Lower third
  - Background toggle
  - Shadow toggle
  - Uppercase toggle
  - Size and vertical position controls

- Stickers
  - Emoji sticker layer grid
  - Stickers are stored as text layers so they export with the render

- Canvas/aspect presets
  - 9:16
  - 1:1
  - 16:9
  - Original
  - TikTok/Reels shortcut
  - Square post shortcut

- Editing actions
  - Trim start/end
  - Split at playhead
  - Duplicate clip
  - Delete clip
  - Speed presets from 0.25x to 4x

- Export
  - Render mobile video
  - Download render

## Files changed

### `src/lib/opencut/types.ts`

Extended the clip and text layer models with properties for filters, adjustments, opacity, transforms, fit/fill, visual fades, text shadow, and uppercase styling.

### `src/lib/opencut/export.ts`

Updated the canvas export renderer so filter presets, brightness, contrast, saturation, blur, opacity, visual fades, rotate, flip, fit/fill, text shadow, and uppercase text are applied to the exported video frames.

### `src/components/opencut-mobile/MobileOpenCutStudio.tsx`

Expanded the mobile editor UI to include a larger CapCut-style bottom tool dock and tool panels for Filters, Adjust, Transform, Canvas, Captions, Stickers, Text, Audio, Speed, Trim, Split, and Export.

## Important limitation

The current in-browser export engine records canvas video frames. Audio volume affects mobile preview playback, but full audio export and audio mixing still need a separate render-engine pass.

## Verification checklist

After deployment:

1. Open `/studio` or `/mobile-editor` on iPhone Safari.
2. Import a video.
3. Apply each filter and verify the preview changes.
4. Adjust brightness, contrast, saturation, blur, and opacity.
5. Rotate, flip, and switch between Fit and Fill.
6. Add text, apply text presets, toggle background, shadow, and caps.
7. Add caption bar and sticker layers.
8. Change canvas aspect.
9. Render and confirm visual filters, transform, stickers, and text are included in the exported render.
10. Confirm the bottom tool dock stays usable above the iPhone home indicator.
