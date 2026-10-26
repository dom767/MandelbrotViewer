# Screenshots (ScreenGrabber)

Shared screenshot API, storage, SDK, and admin live in the sibling repo:

**[`../ScreenGrabber`](../../ScreenGrabber)** → `c:\Users\user\Documents\GitHub\ScreenGrabber`

Mandelbrot keeps:

- Capture / share UI (`js/ui/ScreenshotUI.js`, `js/ui/capture.js`)
- Shots side panel (`js/ui/ShotsPanel.js`)
- Map pins (`js/ui/ScreengrabMode.js`)
- App config (`js/shotsConfig.js`)
- Vendored SDK (`js/vendor/baffled-screenshots.js`) — checked in for source development, and pulled fresh from ScreenGrabber `master` by every export (`export-static.mjs`). The export fails if the pull fails; see [deploy.md](../deploy.md#screengrabber-sdk-pull-every-export).

## Ops

Deploy and secrets are owned by ScreenGrabber:

```powershell
cd ..\ScreenGrabber
.\DeployScreengrabber.ps1
```

Consumer sync is configured in ScreenGrabber `apps.json` (see `apps.example.json`).

- API: https://shots.baffledcat.com
- Admin: https://shots.baffledcat.com/admin
