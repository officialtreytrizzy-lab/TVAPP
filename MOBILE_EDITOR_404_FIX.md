# Mobile Editor 404 Fix

## Issue

Opening the Mobile Editor could return a 404 when the user visited the editor route directly or refreshed the page.

## Root cause

The app is a Vite React single-page app using React Router. The UI entry point labeled `Open mobile editor` points to `/studio`, and `src/App.tsx` already registered `/studio` to render `MobileStudio`.

The missing piece was the Vercel deployment fallback. Without rewrites, Vercel can treat `/studio` as a server/static path and return a platform 404 before React Router loads.

## Broken path traced

- Primary UI path: `/studio`
- Existing alternate path: `/opencut`
- Added compatibility path: `/mobile-editor`
- Added compatibility path: `/opencut/mobile`

## Files changed

1. `src/App.tsx`
   - Kept `/studio` wired to `MobileStudio`.
   - Kept `/opencut` wired to `MobileStudio`.
   - Added `/mobile-editor` as a direct Mobile Editor alias.
   - Added `/opencut/mobile` as a direct Mobile Editor alias.

2. `vercel.json`
   - Added Vercel rewrites for `/studio`, `/mobile-editor`, `/opencut`, and `/opencut/mobile` to serve `/index.html`.
   - This lets React Router resolve those routes after refresh or direct navigation.

## Verification checklist

After deployment, verify:

- Clicking `Open mobile editor` opens the editor instead of a 404.
- Directly visiting `/studio` opens the editor.
- Refreshing while on `/studio` stays on the editor.
- Directly visiting `/mobile-editor` opens the same editor.
- Directly visiting `/opencut` opens the same editor.
- Directly visiting `/opencut/mobile` opens the same editor.
- The root `/` route still opens the main app.

## Scope

This was a routing/deployment patch only. The Mobile Editor component was not rewritten or duplicated.
