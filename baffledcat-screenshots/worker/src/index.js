import { corsHeaders, withCors } from "./cors.js";
import {
  issueTicket,
  verifyTicket,
  consumeTicket,
  purgeExpiredTickets,
} from "./ticket.js";
import { validateImageBytes, sha256Hex } from "./image.js";
import { rateLimit } from "./ratelimit.js";

const ALLOWED_STATUS = new Set(["pending", "approved", "hidden"]);

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        const { headers, ok } = corsHeaders(env, request);
        return new Response(null, {
          status: ok ? 204 : 403,
          headers,
        });
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      let response;
      if (path === "/v1/ticket" && request.method === "POST") {
        response = await handleTicket(request, env);
      } else if (path === "/v1/shots" && request.method === "POST") {
        response = await handleUpload(request, env, ctx);
      } else if (path === "/v1/shots" && request.method === "GET") {
        response = await handleList(request, env, { admin: false });
      } else if (path.startsWith("/v1/shots/") && request.method === "GET") {
        response = await handleGet(path.slice("/v1/shots/".length), env, false);
      } else if (path === "/v1/admin/shots" && request.method === "GET") {
        response = await requireAdmin(request, env, () =>
          handleList(request, env, { admin: true })
        );
      } else if (path.startsWith("/v1/admin/shots/") && request.method === "DELETE") {
        response = await requireAdmin(request, env, () =>
          handleAdminDelete(path.slice("/v1/admin/shots/".length), env)
        );
      } else if (path.startsWith("/v1/admin/shots/") && request.method === "PATCH") {
        response = await requireAdmin(request, env, () =>
          handleAdminPatch(path.slice("/v1/admin/shots/".length), request, env)
        );
      } else if (path.startsWith("/i/") && request.method === "GET") {
        response = await handleAsset(path.slice(3), env);
      } else if (path === "/" || path === "/health") {
        response = json({ ok: true, service: "baffledcat-screenshots" });
      } else if (path === "/admin" || path.startsWith("/admin/")) {
        response = await serveAdmin(path, env);
      } else {
        response = json({ error: "not found" }, 404);
      }

      return withCors(env, request, response);
    } catch (err) {
      console.error(err);
      return withCors(
        env,
        request,
        json({ error: "internal error" }, 500)
      );
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function allowedApps(env) {
  return String(env.ALLOWED_APP_IDS || "mandelbrot")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function hashIp(ip, secret) {
  const data = new TextEncoder().encode(`${secret || "x"}:${ip}`);
  const dig = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(dig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

async function verifyTurnstile(env, token, ip) {
  if (env.DEV_BYPASS_TURNSTILE === "1") return true;
  if (!env.TURNSTILE_SECRET) return false;
  if (!token) return false;
  const body = new URLSearchParams();
  body.set("secret", env.TURNSTILE_SECRET);
  body.set("response", token);
  if (ip && ip !== "unknown") body.set("remoteip", ip);
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body }
  );
  const data = await res.json();
  return !!data.success;
}

async function handleTicket(request, env) {
  const { ok: originOk } = corsHeaders(env, request);
  if (!originOk) return json({ error: "origin not allowed" }, 403);

  const ip = clientIp(request);
  if (!rateLimit(`ticket:${ip}`, { limit: 30, windowMs: 60_000 })) {
    return json({ error: "rate limited" }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const appId = String(body.appId || "");
  if (!allowedApps(env).includes(appId)) {
    return json({ error: "unknown appId" }, 400);
  }

  const bytes = Number(body.bytes);
  const contentSha256 = String(body.contentSha256 || "");
  if (!Number.isFinite(bytes) || bytes < 1 || bytes > Number(env.MAX_UPLOAD_BYTES || 2_097_152)) {
    return json({ error: "invalid bytes" }, 400);
  }
  if (!/^[a-f0-9]{64}$/i.test(contentSha256)) {
    return json({ error: "invalid contentSha256" }, 400);
  }

  const turnstileOk = await verifyTurnstile(env, body.turnstileToken, ip);
  if (!turnstileOk) return json({ error: "turnstile failed" }, 403);

  if (!env.TICKET_HMAC_SECRET) {
    return json({ error: "server misconfigured" }, 500);
  }

  const ticket = await issueTicket(env, { appId, bytes, contentSha256 });
  return json({ ticket, expiresIn: Number(env.TICKET_TTL_SEC || 120) });
}

async function handleUpload(request, env, ctx) {
  const { ok: originOk } = corsHeaders(env, request);
  if (!originOk) return json({ error: "origin not allowed" }, 403);

  const ip = clientIp(request);
  if (!rateLimit(`upload:${ip}`, { limit: 15, windowMs: 60_000 })) {
    return json({ error: "rate limited" }, 429);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "expected multipart form" }, 400);
  }

  const ticket = String(form.get("ticket") || "");
  const appId = String(form.get("appId") || "");
  const pageUrl = String(form.get("pageUrl") || "").slice(0, 2048);
  const title = sanitizeText(form.get("title"), 120);
  const note = sanitizeText(form.get("note"), 500);
  let metaJson = form.get("meta") || form.get("meta_json") || "{}";
  if (typeof metaJson !== "string") metaJson = "{}";
  if (metaJson.length > 8000) return json({ error: "meta too large" }, 400);

  const imageFile = form.get("image");
  const thumbFile = form.get("thumb");
  if (!(imageFile instanceof File) || !(thumbFile instanceof File)) {
    return json({ error: "image and thumb required" }, 400);
  }

  const imageBuf = new Uint8Array(await imageFile.arrayBuffer());
  const thumbBuf = new Uint8Array(await thumbFile.arrayBuffer());

  const imgCheck = validateImageBytes(imageBuf, env, { expectSquare: false });
  if (!imgCheck.ok) return json({ error: imgCheck.error }, 400);
  const thumbCheck = validateImageBytes(thumbBuf, env, { expectSquare: true });
  if (!thumbCheck.ok) return json({ error: thumbCheck.error }, 400);

  const contentSha256 = await sha256Hex(imageBuf);
  const verified = await verifyTicket(env, ticket, {
    appId,
    bytes: imageBuf.length,
    contentSha256,
  });
  if (!verified.ok) return json({ error: verified.error }, 403);

  ctx.waitUntil(purgeExpiredTickets(env));
  const consumed = await consumeTicket(
    env,
    verified.payload.jti,
    verified.payload.exp
  );
  if (!consumed) return json({ error: "ticket already used" }, 403);

  if (!allowedApps(env).includes(appId)) {
    return json({ error: "unknown appId" }, 400);
  }

  const id = crypto.randomUUID().replace(/-/g, "");
  const ext = extForMime(imgCheck.mime);
  const imageKey = `shots/${appId}/${id}.${ext}`;
  const thumbKey = `shots/${appId}/${id}_thumb.jpg`;

  await env.BUCKET.put(imageKey, imageBuf, {
    httpMetadata: { contentType: imgCheck.mime, cacheControl: "public, max-age=31536000, immutable" },
  });
  await env.BUCKET.put(thumbKey, thumbBuf, {
    httpMetadata: {
      contentType: "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  const createdAt = Date.now();
  const ipHash = await hashIp(ip, env.TICKET_HMAC_SECRET);
  await env.DB.prepare(
    `INSERT INTO shots (
      id, app_id, created_at, image_key, thumb_key, width, height, bytes, mime,
      thumb_size, page_url, title, note, meta_json, status, ip_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)`
  )
    .bind(
      id,
      appId,
      createdAt,
      imageKey,
      thumbKey,
      imgCheck.width,
      imgCheck.height,
      imgCheck.bytes,
      imgCheck.mime,
      thumbCheck.width,
      pageUrl || null,
      title,
      note,
      metaJson,
      ipHash
    )
    .run();

  const base = (env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return json({
    id,
    imageUrl: `${base}/i/${imageKey}`,
    thumbUrl: `${base}/i/${thumbKey}`,
    width: imgCheck.width,
    height: imgCheck.height,
    status: "approved",
  });
}

function extForMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

function sanitizeText(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f<>]/g, "").trim();
  if (!s) return null;
  return s.slice(0, max);
}

async function handleList(request, env, { admin }) {
  const url = new URL(request.url);
  const appId = url.searchParams.get("app_id") || url.searchParams.get("appId");
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  const cursor = url.searchParams.get("cursor");
  const status = admin
    ? url.searchParams.get("status") || null
    : "approved";

  if (status && !ALLOWED_STATUS.has(status) && status !== "all") {
    return json({ error: "bad status" }, 400);
  }

  const params = [];
  let sql = `SELECT id, app_id, created_at, image_key, thumb_key, width, height, bytes, mime,
    thumb_size, page_url, title, note, meta_json, status
    FROM shots WHERE 1=1`;

  if (appId) {
    sql += " AND app_id = ?";
    params.push(appId);
  }
  if (status && status !== "all") {
    sql += " AND status = ?";
    params.push(status);
  }
  if (cursor) {
    const c = Number(cursor);
    if (Number.isFinite(c)) {
      sql += " AND created_at < ?";
      params.push(c);
    }
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  const { results } = await env.DB.prepare(sql)
    .bind(...params)
    .all();

  const base = (env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const shots = (results || []).map((row) => publicShot(row, base, admin));
  const nextCursor =
    shots.length === limit ? String(shots[shots.length - 1].createdAt) : null;

  return json({ shots, nextCursor });
}

async function handleGet(id, env, admin) {
  const clean = id.replace(/[^a-zA-Z0-9]/g, "");
  const row = await env.DB.prepare(
    `SELECT id, app_id, created_at, image_key, thumb_key, width, height, bytes, mime,
      thumb_size, page_url, title, note, meta_json, status
     FROM shots WHERE id = ?`
  )
    .bind(clean)
    .first();
  if (!row) return json({ error: "not found" }, 404);
  if (!admin && row.status !== "approved") return json({ error: "not found" }, 404);
  const base = (env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return json({ shot: publicShot(row, base, admin) });
}

function publicShot(row, base, admin) {
  let meta = null;
  try {
    meta = row.meta_json ? JSON.parse(row.meta_json) : null;
  } catch {
    meta = null;
  }
  const out = {
    id: row.id,
    appId: row.app_id,
    createdAt: row.created_at,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    mime: row.mime,
    thumbSize: row.thumb_size,
    pageUrl: row.page_url,
    title: row.title,
    note: row.note,
    meta,
    status: row.status,
    imageUrl: `${base}/i/${row.image_key}`,
    thumbUrl: `${base}/i/${row.thumb_key}`,
  };
  if (!admin) {
    // status always approved for public
  }
  return out;
}

async function handleAsset(key, env) {
  // key like shots/mandelbrot/….jpg — prevent path escape
  const clean = key.replace(/^\/+/, "");
  if (!clean.startsWith("shots/") || clean.includes("..")) {
    return json({ error: "not found" }, 404);
  }
  const obj = await env.BUCKET.get(clean);
  if (!obj) return json({ error: "not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}

async function requireAdmin(request, env, fn) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  return fn();
}

async function handleAdminDelete(id, env) {
  const clean = id.replace(/[^a-zA-Z0-9]/g, "");
  const hard = false; // soft-hide by default; hard via ?hard=1
  // read query from... we need request. Pass hard via id? Use soft hide.
  const row = await env.DB.prepare(
    "SELECT image_key, thumb_key FROM shots WHERE id = ?"
  )
    .bind(clean)
    .first();
  if (!row) return json({ error: "not found" }, 404);

  await env.DB.prepare("UPDATE shots SET status = 'hidden' WHERE id = ?")
    .bind(clean)
    .run();

  return json({ ok: true, id: clean, status: "hidden" });
}

async function handleAdminPatch(id, request, env) {
  const clean = id.replace(/[^a-zA-Z0-9]/g, "");
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const status = String(body.status || "");
  if (!ALLOWED_STATUS.has(status)) return json({ error: "bad status" }, 400);

  if (status === "hidden" && body.hardDelete) {
    const row = await env.DB.prepare(
      "SELECT image_key, thumb_key FROM shots WHERE id = ?"
    )
      .bind(clean)
      .first();
    if (!row) return json({ error: "not found" }, 404);
    await env.BUCKET.delete(row.image_key);
    await env.BUCKET.delete(row.thumb_key);
    await env.DB.prepare("DELETE FROM shots WHERE id = ?").bind(clean).run();
    return json({ ok: true, deleted: true });
  }

  const result = await env.DB.prepare("UPDATE shots SET status = ? WHERE id = ?")
    .bind(status, clean)
    .run();
  if (!result.meta?.changes) return json({ error: "not found" }, 404);
  return json({ ok: true, id: clean, status });
}

async function serveAdmin(path, env) {
  // Inline minimal admin HTML from ASSETS or embedded string
  if (path === "/admin" || path === "/admin/") {
    return new Response(ADMIN_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return json({ error: "not found" }, 404);
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Baffled Cat Shots — Admin</title>
  <style>
    :root { color-scheme: dark; --bg:#1c1812; --fg:#f6efe2; --muted:#b3a68e; --amber:#f2a544; --border:rgba(246,239,226,.12); }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, sans-serif; background:var(--bg); color:var(--fg); padding:1.25rem; }
    h1 { font-size:1.25rem; margin:0 0 1rem; }
    .row { display:flex; flex-wrap:wrap; gap:.75rem; align-items:center; margin-bottom:1rem; }
    input, select, button { font:inherit; padding:.45rem .65rem; border-radius:8px; border:1px solid var(--border); background:#262019; color:var(--fg); }
    button { cursor:pointer; background:var(--amber); color:#1c1812; border:none; font-weight:600; }
    button.secondary { background:transparent; color:var(--fg); border:1px solid var(--border); }
    button.danger { background:#a33; color:#fff; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:1rem; }
    .card { border:1px solid var(--border); border-radius:12px; overflow:hidden; background:#262019; }
    .card img { width:100%; aspect-ratio:1; object-fit:cover; display:block; background:#111; }
    .card .meta { padding:.65rem; font-size:.75rem; color:var(--muted); display:flex; flex-direction:column; gap:.35rem; }
    .card .meta a { color:var(--amber); word-break:break-all; }
    .actions { display:flex; gap:.35rem; flex-wrap:wrap; }
    .hidden { display:none !important; }
    #login { max-width:22rem; }
    .err { color:#f88; font-size:.85rem; }
  </style>
</head>
<body>
  <h1>Screenshot admin</h1>
  <section id="login">
    <div class="row">
      <input id="token" type="password" placeholder="Admin token" style="flex:1" />
      <button id="login-btn" type="button">Unlock</button>
    </div>
    <p class="err hidden" id="login-err"></p>
  </section>
  <section id="panel" class="hidden">
    <div class="row">
      <select id="app">
        <option value="">All apps</option>
        <option value="mandelbrot">mandelbrot</option>
      </select>
      <select id="status">
        <option value="all">All statuses</option>
        <option value="approved">approved</option>
        <option value="hidden">hidden</option>
        <option value="pending">pending</option>
      </select>
      <button id="refresh" type="button" class="secondary">Refresh</button>
      <button id="logout" type="button" class="secondary">Lock</button>
    </div>
    <div class="grid" id="grid"></div>
    <p class="err" id="list-err"></p>
  </section>
  <script>
    const apiBase = location.origin;
    const tokenKey = "bc_shots_admin";
    const $ = (id) => document.getElementById(id);

    function token() { return sessionStorage.getItem(tokenKey) || ""; }

    async function api(path, opts = {}) {
      const headers = Object.assign({}, opts.headers || {});
      if (token()) headers.Authorization = "Bearer " + token();
      const res = await fetch(apiBase + path, { ...opts, headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    function showPanel(on) {
      $("login").classList.toggle("hidden", on);
      $("panel").classList.toggle("hidden", !on);
    }

    $("login-btn").onclick = async () => {
      sessionStorage.setItem(tokenKey, $("token").value.trim());
      try {
        await api("/v1/admin/shots?limit=1");
        $("login-err").classList.add("hidden");
        showPanel(true);
        load();
      } catch (e) {
        sessionStorage.removeItem(tokenKey);
        $("login-err").textContent = e.message;
        $("login-err").classList.remove("hidden");
      }
    };

    $("logout").onclick = () => { sessionStorage.removeItem(tokenKey); showPanel(false); };
    $("refresh").onclick = () => load();
    $("app").onchange = () => load();
    $("status").onchange = () => load();

    async function load() {
      $("list-err").textContent = "";
      const q = new URLSearchParams();
      q.set("limit", "100");
      if ($("app").value) q.set("app_id", $("app").value);
      if ($("status").value) q.set("status", $("status").value);
      try {
        const data = await api("/v1/admin/shots?" + q);
        const grid = $("grid");
        grid.innerHTML = "";
        for (const s of data.shots || []) {
          const card = document.createElement("article");
          card.className = "card";
          const when = new Date(s.createdAt).toLocaleString();
          card.innerHTML = \`
            <img src="\${s.thumbUrl}" alt="" loading="lazy" />
            <div class="meta">
              <div><strong>\${s.appId}</strong> · \${s.status}</div>
              <div>\${when}</div>
              <div>\${s.width}×\${s.height}</div>
              \${s.pageUrl ? \`<a href="\${s.pageUrl}" target="_blank" rel="noopener">Open view</a>\` : ""}
              <div class="actions">
                <button type="button" class="secondary" data-act="hide">Hide</button>
                <button type="button" class="secondary" data-act="approve">Approve</button>
                <button type="button" class="danger" data-act="delete">Delete</button>
              </div>
            </div>\`;
          card.querySelector('[data-act="hide"]').onclick = () => patch(s.id, "hidden");
          card.querySelector('[data-act="approve"]').onclick = () => patch(s.id, "approved");
          card.querySelector('[data-act="delete"]').onclick = () => hardDelete(s.id);
          grid.appendChild(card);
        }
      } catch (e) {
        $("list-err").textContent = e.message;
      }
    }

    async function patch(id, status) {
      await api("/v1/admin/shots/" + id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      load();
    }

    async function hardDelete(id) {
      if (!confirm("Permanently delete this shot and its files?")) return;
      await api("/v1/admin/shots/" + id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "hidden", hardDelete: true }),
      });
      load();
    }

    if (token()) {
      showPanel(true);
      load();
    }
  </script>
</body>
</html>
`;
