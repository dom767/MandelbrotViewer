# Baffled Cat Screenshots

Shared screenshot API, storage, SDK, and admin UI for baffledcat.com apps.

MandelbrotViewer vendors the SDK at [`../js/vendor/baffled-screenshots.js`](../js/vendor/baffled-screenshots.js) and integrates capture + screengrab map mode.

Homepage carousel (repo `Wooexperiments/baffledcat`) is **out of v1** — consume `GET /v1/shots?status=approved` when ready.

## Stack

| Piece | Tech |
| --- | --- |
| API | AWS Lambda (Node 20) + API Gateway HTTP API (`api/`) |
| Images | S3 bucket `baffledcat-shots` (private; served via `/i/...`) |
| Metadata | DynamoDB `baffledcat-shots` (+ `baffledcat-shots-tickets` with TTL) |
| Abuse dampening | CORS allowlist + Turnstile + one-time HMAC tickets + IP rate limits |
| Admin | Served at `/admin` from the Lambda |
| Region | `eu-west-2` (same as other baffledcat AWS APIs) |

Public hostname: **`https://shots.baffledcat.com`** (ACM + API Gateway custom domain). Until DNS/ACM is ready, deploy uses the `execute-api` URL and writes it into `js/shotsConfig.js`.

## Production deploy

From the MandelbrotViewer repo root. Uses your normal **AWS CLI** credentials (`aws sts get-caller-identity`).

Optional secrets file: `baffledcat-screenshots/api/.deploy-secrets.env` (gitignored):

```env
AWS_REGION=eu-west-2
TURNSTILE_SECRET=...
# TICKET_HMAC_SECRET / ADMIN_TOKEN generated if omitted
# DEV_BYPASS_TURNSTILE=1
```

```powershell
.\DeployScreengrabber.cmd
# or: .\DeployScreengrabber.ps1
```

`DeployScreengrabber.ps1` will:

1. Tear down leftover Cloudflare Worker/D1 if `CLOUDFLARE_API_TOKEN` is set (or run `TearDownCloudflareScreengrabber.ps1`)
2. Pack + deploy Lambda `baffledcat-screenshots`
3. Ensure S3 bucket + DynamoDB tables + IAM role + HTTP API
4. Request/wire ACM for `shots.baffledcat.com` and print DNS CNAMEs
5. Sync SDK → `js/vendor/baffled-screenshots.js` and update `js/shotsConfig.js` `apiBase`
6. Smoke-test `/health`

Flags: `-SkipSecrets`, `-SkipDomain`, `-SkipCloudflareTeardown`, `-DryRun`.

### DNS for `shots.baffledcat.com`

1. **ACM validation** CNAME (printed by deploy; required once)
2. **API** CNAME: `shots.baffledcat.com` → the `d-….execute-api.eu-west-2.amazonaws.com` hostname printed after the cert is **ISSUED**

Use DNS-only (grey cloud) if the zone is on Cloudflare DNS.

After DNS propagates, re-run deploy so `PUBLIC_BASE_URL` switches to `https://shots.baffledcat.com`.

### Turnstile

Turnstile is only used as a bot check (not for hosting).

1. Create a Turnstile widget (invisible) for baffledcat.com.
2. Put the **secret** in `TURNSTILE_SECRET`.
3. Put the **site key** in Mandelbrot `js/shotsConfig.js` (`turnstileSiteKey`) and set `devBypassTurnstile: false`.
4. Set `DEV_BYPASS_TURNSTILE=` (empty) or remove it, then redeploy.

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

Public list of **approved** shots.

### Admin

- `GET /v1/admin/shots` — Bearer `ADMIN_TOKEN`
- `PATCH /v1/admin/shots/:id` — `{ "status": "hidden"|"approved"|"pending" }` or `{ "status":"hidden", "hardDelete": true }`
- `DELETE /v1/admin/shots/:id` — soft-hide
- UI: `https://shots.baffledcat.com/admin` (or the execute-api URL + `/admin`)

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
