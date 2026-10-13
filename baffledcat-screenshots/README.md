# Baffled Cat Screenshots

Shared screenshot API, storage, SDK, and admin UI for baffledcat.com apps.

MandelbrotViewer vendors the SDK at [`../js/vendor/baffled-screenshots.js`](../js/vendor/baffled-screenshots.js) and integrates capture + screengrab map mode.

Homepage carousel (repo `Wooexperiments/baffledcat`) is **out of v1** — consume `GET /v1/shots?status=approved` when ready.

## Stack

| Piece | Tech |
| --- | --- |
| API | Cloudflare Worker (`worker/`) |
| Images | R2 bucket `baffledcat-shots` |
| Metadata | D1 database `baffledcat-shots` |
| Abuse dampening | CORS allowlist + Turnstile + one-time HMAC tickets + IP rate limits |
| Admin | Served at `/admin` from the Worker |

## Production deploy (recommended)

From the MandelbrotViewer repo root.

**Auth:** `DeployScreengrabber` runs Wrangler non-interactively, so **`wrangler login` (browser OAuth) is not enough**. Create an [API token](https://dash.cloudflare.com/profile/api-tokens) and put it in `baffledcat-screenshots/worker/.deploy-secrets.env` (gitignored):

```env
CLOUDFLARE_API_TOKEN=...
TURNSTILE_SECRET=...
```

Suggested token permissions: Workers Scripts Edit, D1 Edit, Account R2 Storage Edit, Account Settings Read.

```powershell
# Optional overrides for this session:
$env:CLOUDFLARE_API_TOKEN = "<token>"
$env:TURNSTILE_SECRET = "<turnstile-secret>"

.\DeployScreengrabber.cmd
# or: .\DeployScreengrabber.ps1
```

`DeployScreengrabber.ps1` will:

1. `npm install` in `worker/`
2. Create D1 `baffledcat-shots` + R2 `baffledcat-shots` if missing; write `database_id` into `wrangler.toml`
3. Apply **remote** D1 migrations
4. Add `shots.baffledcat.com` custom-domain route; set `PUBLIC_BASE_URL`
5. Set secrets `TICKET_HMAC_SECRET`, `ADMIN_TOKEN` (generated if unset), and `TURNSTILE_SECRET` if provided
6. Sync SDK → `js/vendor/baffled-screenshots.js`
7. `wrangler deploy` and smoke-test `/health`

Secrets are persisted locally (gitignored) at `worker/.deploy-secrets.env`.

Flags: `-SkipSecrets`, `-SkipDomain`, `-DryRun`.

### Manual / local setup

```bash
cd worker
npm install
# Create D1 + R2, paste IDs into wrangler.toml — or use DeployScreengrabber.ps1
npx wrangler d1 migrations apply baffledcat-shots --local
npx wrangler d1 migrations apply baffledcat-shots --remote

npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put TICKET_HMAC_SECRET
npx wrangler secret put ADMIN_TOKEN

# Local/dev without Turnstile:
# In wrangler.toml [vars]: DEV_BYPASS_TURNSTILE = "1"

npx wrangler dev
# or
npx wrangler deploy
```

### Turnstile

1. Create a Turnstile widget (invisible) for baffledcat.com.
2. Put the **secret** in `TURNSTILE_SECRET`.
3. Put the **site key** in Mandelbrot `js/shotsConfig.js` (`turnstileSiteKey`) and set `devBypassTurnstile: false`.

### CORS / apps

`ALLOWED_ORIGINS` — comma-separated browser origins allowed to call ticket/upload.  
`ALLOWED_APP_IDS` — e.g. `mandelbrot`.

## API contract

### `POST /v1/ticket`

JSON body:

```json
{
  "appId": "mandelbrot",
  "bytes": 123456,
  "contentSha256": "<hex sha256 of image bytes>",
  "turnstileToken": "..."
}
```

Returns `{ ticket, expiresIn }`.

### `POST /v1/shots` (multipart)

Fields: `ticket`, `appId`, `image` (file), `thumb` (file, **256×256 JPEG**), optional `pageUrl`, `title`, `note`, `meta` (JSON string).

Image must fit within **1920×1080**. Max bytes default 2 MiB.

Returns `{ id, imageUrl, thumbUrl, width, height, status }`.

### `GET /v1/shots?app_id=mandelbrot&limit=50&cursor=`

Public list of **approved** shots. Response:

```json
{
  "shots": [
    {
      "id": "...",
      "appId": "mandelbrot",
      "createdAt": 0,
      "imageUrl": "https://shots.baffledcat.com/i/shots/...",
      "thumbUrl": "https://shots.baffledcat.com/i/shots/...",
      "pageUrl": "https://...",
      "meta": {},
      "width": 1920,
      "height": 1080,
      "status": "approved"
    }
  ],
  "nextCursor": "..."
}
```

### Admin

- `GET /v1/admin/shots` — Bearer `ADMIN_TOKEN`
- `PATCH /v1/admin/shots/:id` — `{ "status": "hidden"|"approved"|"pending" }` or `{ "status":"hidden", "hardDelete": true }`
- `DELETE /v1/admin/shots/:id` — soft-hide
- UI: `https://shots.baffledcat.com/admin`

## SDK

```js
import { createBaffledScreenshots } from "./baffled-screenshots.js";

const shots = createBaffledScreenshots({
  apiBase: "https://shots.baffledcat.com",
  appId: "mandelbrot",
  turnstileSiteKey: "...",
  // devBypassTurnstile: true,
});

await shots.upload({ imageBlob, thumbBlob, pageUrl, meta });
const page = await shots.list({ limit: 50 });
```

## Mandelbrot capture behaviour

1. **Shot** always downloads a **native-resolution** JPEG at quality **0.85**.
2. Optional **Share to baffledcat.com** downscales to ≤1080p, JPEG **0.7**, plus 256² thumb, then uploads via the SDK.

## Homepage follow-up

In `Wooexperiments/baffledcat`, fetch approved shots and render `thumbUrl` in a carousel; link through `pageUrl` when present.
