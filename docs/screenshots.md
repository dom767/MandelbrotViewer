# Screenshots (ScreenGrabber)

Shared screenshot API, storage, SDK, and admin live in the sibling repo:

**[`../ScreenGrabber`](../../ScreenGrabber)** → `c:\Users\user\Documents\GitHub\ScreenGrabber`

Mandelbrot keeps:

- Capture / share UI (`js/ui/ScreenshotUI.js`, `js/ui/capture.js`)
- Shots side panel (`js/ui/ShotsPanel.js`)
- Map pins (`js/ui/ScreengrabMode.js`)
- App config (`js/shotsConfig.js`)
- Vendored SDK (`js/vendor/baffled-screenshots.js`) — refreshed by ScreenGrabber deploy

## Ops

Deploy and secrets are owned by ScreenGrabber:

```powershell
cd ..\ScreenGrabber
.\DeployScreengrabber.ps1
```

Consumer sync is configured in ScreenGrabber `apps.json` (see `apps.example.json`).

- API: https://shots.baffledcat.com
- Admin: https://shots.baffledcat.com/admin
