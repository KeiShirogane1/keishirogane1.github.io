import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "npm:pg@8.16.3";
const { Pool } = pg;

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = String(process.env.DATABASE_URL || "");
const ADMIN_GITHUB_LOGIN = String(process.env.ADMIN_GITHUB_LOGIN || "keishirogane1").toLowerCase();
const BREVO_API_KEY = String(process.env.BREVO_API_KEY || "");
const BREVO_SENDER_EMAIL = String(process.env.BREVO_SENDER_EMAIL || "");
const BREVO_SENDER_NAME = String(process.env.BREVO_SENDER_NAME || "QwerNFC");
const PUBLIC_BASE = "https://keishirogane1.github.io/permanent-qr-manager";
const ALLOWED_ORIGINS = new Set([
  "https://keishirogane1.github.io"
]);

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
});

const json = (res, status, data, origin = "") => {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "Origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
};

const originAllowed = (origin) => {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    const hostname = String(url.hostname || "").toLowerCase();
    const localPreview =
      url.protocol === "http:" &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]");
    const codespacesPreview = url.protocol === "https:" && hostname.endsWith(".app.github.dev");
    return localPreview || codespacesPreview;
  } catch {
    return false;
  }
};

const corsOrigin = (req) => {
  const origin = String(req.headers.origin || "");
  return originAllowed(origin) ? origin : "";
};

const readBody = async (req, limit = 32 * 1024) => {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request too large."), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON."), { status: 400 });
  }
};

const normalizeText = (value, max) => String(value || "").trim().slice(0, max);
const allowedFields = new Set(["store", "phone", "email", "location", "managedLink", "storeImage"]);
const CUSTOMER_STORE_IMAGE_MAX_BYTES = 512 * 1024;

function normalizePayload(raw) {
  const id = String(raw?.id || "").toUpperCase();
  if (raw?.type !== "customer-info-update" || Number(raw?.version) !== 1 || !/^QR-\d+$/.test(id)) {
    throw Object.assign(new Error("Invalid customer update request."), { status: 400 });
  }

  const reason = normalizeText(raw.reason, 500);
  if (reason.length < 3) throw Object.assign(new Error("Reason is required."), { status: 400 });

  const changes = {};
  for (const [field, value] of Object.entries(raw.changes || {})) {
    if (!allowedFields.has(field)) continue;
    const max = field === "managedLink" ? 2048 : field === "location" ? 180 : field === "email" ? 120 : field === "store" ? 80 : field === "storeImage" ? 16 : 32;
    const normalized = normalizeText(value, max);
    if (!normalized) continue;
    if (field === "storeImage") {
      if (!["replace", "remove"].includes(normalized)) {
        throw Object.assign(new Error("Storefront image action is invalid."), { status: 400 });
      }
      changes[field] = normalized;
    } else if (field === "managedLink") {
      let url;
      try { url = new URL(normalized); } catch { throw Object.assign(new Error("Managed link is invalid."), { status: 400 }); }
      if (!["http:", "https:"].includes(url.protocol)) throw Object.assign(new Error("Managed link is invalid."), { status: 400 });
      changes[field] = url.href;
    } else {
      changes[field] = normalized;
    }
  }
  if (!Object.keys(changes).length) throw Object.assign(new Error("No changes were submitted."), { status: 400 });
  if (!changes.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(changes.email)) {
    throw Object.assign(new Error("A valid customer email is required."), { status: 400 });
  }

  let storeImage = null;
  if (Object.prototype.hasOwnProperty.call(changes, "storeImage")) {
    const action = changes.storeImage;
    if (action === "remove") {
      storeImage = { action: "remove" };
    } else {
      const source = raw.storeImage && typeof raw.storeImage === "object" && !Array.isArray(raw.storeImage)
        ? raw.storeImage
        : {};
      const mimeType = String(source.mimeType || "").toLowerCase();
      const base64 = String(source.base64 || "").replace(/\s/g, "");
      if (mimeType !== "image/webp" || !base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        throw Object.assign(new Error("Storefront image data is invalid."), { status: 400 });
      }
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.length || bytes.length > CUSTOMER_STORE_IMAGE_MAX_BYTES) {
        throw Object.assign(new Error("Storefront image must be 512 KB or smaller."), { status: 413 });
      }
      if (
        bytes.length < 12 ||
        bytes.subarray(0,4).toString("ascii") !== "RIFF" ||
        bytes.subarray(8,12).toString("ascii") !== "WEBP"
      ) {
        throw Object.assign(new Error("Storefront image must be a valid WebP image."), { status: 400 });
      }
      storeImage = { action: "replace", mimeType: "image/webp", base64 };
    }
  }

  let locationPin = null;
  if (Object.prototype.hasOwnProperty.call(changes, "location") && raw.locationPin) {
    const latitude = Number(raw.locationPin.latitude);
    const longitude = Number(raw.locationPin.longitude);
    if (
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -85.05112878 || latitude > 85.05112878 ||
      longitude < -180 || longitude > 180
    ) {
      throw Object.assign(new Error("Location pin is invalid."), { status: 400 });
    }
    locationPin = {
      latitude,
      longitude,
      googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(latitude.toFixed(7) + "," + longitude.toFixed(7))
    };
  }

  return {
    type: "customer-info-update",
    version: 1,
    id,
    requestedAt: new Date().toISOString(),
    reason,
    changes,
    ...(locationPin ? { locationPin } : {}),
    ...(storeImage ? { storeImage } : {})
  };
}

const requestBuckets = new Map();
function rateLimit(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const key = forwarded || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const minute = 60_000;
  const current = requestBuckets.get(key);
  if (!current || now - current.startedAt >= minute) {
    requestBuckets.set(key, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > 12;
}

async function verifyAdmin(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) throw Object.assign(new Error("Authentication required."), { status: 401 });
  const token = auth.slice(7).trim();
  if (!token) throw Object.assign(new Error("Authentication required."), { status: 401 });

  const response = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "user-agent": "QwerNFC-Live-Requests"
    },
    cache: "no-store"
  });
  if (!response.ok) throw Object.assign(new Error("GitHub authentication failed."), { status: 401 });
  const viewer = await response.json();
  const login = String(viewer?.login || "").toLowerCase();
  if (login !== ADMIN_GITHUB_LOGIN) throw Object.assign(new Error("Not authorized for QwerNFC admin requests."), { status: 403 });
  return login;
}

const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
})[char]);

function restorePortalUrl(qrId) {
  const id = String(qrId || "").toUpperCase();
  return `${PUBLIC_BASE}/recover/${encodeURIComponent(id)}/`;
}

async function sendApprovalEmail(payload) {
  const to = String(payload?.changes?.email || "").trim();
  if (!to) return { configured: Boolean(BREVO_API_KEY && BREVO_SENDER_EMAIL), sent: false, reason: "missing_email" };
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    return { configured: false, sent: false, reason: "not_configured" };
  }

  const qrId = String(payload.id || "").toUpperCase();
  const portalUrl = restorePortalUrl(qrId);
  const changedFields = Object.keys(payload.changes || {})
    .map((field) => ({
      store: "Store name",
      phone: "Phone number",
      email: "Email address",
      location: "Location",
      managedLink: "Managed link",
      storeImage: "Storefront image"
    })[field] || field)
    .join(", ");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#102016">
      <h2 style="margin-bottom:8px">Your QwerNFC information changes were approved</h2>
      <p>Your requested changes for <strong>${escapeHtml(qrId)}</strong> have been approved by the QwerNFC administrator and the replacement customer app is now ready.</p>
      <p><strong>Approved fields:</strong> ${escapeHtml(changedFields || "Customer information")}</p>
      <p><strong>Uninstall the old QwerNFC Restore app from your phone first.</strong> Then open your store's recovery page and download/install the newly published APK.</p>
      <p style="margin:24px 0">
        <a href="${escapeHtml(portalUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#0b7a39;color:white;text-decoration:none;font-weight:700">Open updated QwerNFC Restore page</a>
      </p>
      <p style="font-size:12px;color:#607065">This email is sent only after the new QR-bound APK is published. Your permanent QR identity remains unchanged and private routing data is not included.</p>
    </div>
  `;

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": BREVO_API_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sender: {
        name: BREVO_SENDER_NAME,
        email: BREVO_SENDER_EMAIL
      },
      to: [{ email: to }],
      subject: `QwerNFC ${qrId} changes approved — new app ready`,
      htmlContent: html
    })
  });

  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) {
    return {
      configured: true,
      sent: false,
      reason: "provider_error",
      status: response.status,
      providerMessage: String(result?.message || result?.code || "Brevo rejected the message.").slice(0, 180)
    };
  }

  return {
    configured: true,
    sent: true,
    messageId: String(result?.messageId || "")
  };
}


function parsePublishedRestoreBuild(text) {
  const fields = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    fields[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return {
    id: String(fields["restore-id"] || "").toUpperCase(),
    commit: String(fields.commit || "").toLowerCase(),
    sha256: String(fields["apk sha-256"] || "").toLowerCase(),
    publishedAt: String(fields["published at"] || ""),
    packageName: String(fields.package || "")
  };
}

async function publishedRestoreState(qrId) {
  const id = String(qrId || "").toUpperCase();
  const base = `${PUBLIC_BASE}/downloads/restore/${encodeURIComponent(id)}`;
  const nonce = Date.now();
  const buildResponse = await fetch(`${base}/BUILD.txt?v=${nonce}`, { cache: "no-store" });
  if (!buildResponse.ok) return null;
  const build = parsePublishedRestoreBuild(await buildResponse.text());
  if (
    build.id !== id ||
    !/^[0-9a-f]{40}$/.test(build.commit) ||
    !/^[0-9a-f]{64}$/.test(build.sha256) ||
    !build.publishedAt
  ) return null;
  const publishedAt = new Date(build.publishedAt);
  if (Number.isNaN(publishedAt.valueOf())) return null;
  const apkResponse = await fetch(`${base}/QwerNFC-Restore-${encodeURIComponent(id)}.apk?v=${nonce}`, {
    method: "HEAD",
    cache: "no-store"
  });
  if (!apkResponse.ok) return null;
  return { ...build, publishedAt };
}

let approvalReleaseCheckRunning = false;
async function processReadyApprovalEmails() {
  if (approvalReleaseCheckRunning) return;
  approvalReleaseCheckRunning = true;
  try {
    const pending = await pool.query(
      `SELECT request_id,qr_id,payload,apk_refresh_required_at
         FROM customer_update_requests
        WHERE status='approved'
          AND apk_refresh_required_at IS NOT NULL
          AND approval_email_sent_at IS NULL
        ORDER BY resolved_at ASC
        LIMIT 100`
    );

    for (const row of pending.rows) {
      try {
        const release = await publishedRestoreState(row.qr_id);
        if (!release) continue;
        const requiredAt = new Date(row.apk_refresh_required_at);
        if (Number.isNaN(requiredAt.valueOf()) || release.publishedAt <= requiredAt) continue;
        const delivery = await sendApprovalEmail(row.payload);
        if (!delivery.sent) continue;
        await pool.query(
          `UPDATE customer_update_requests
              SET approval_email_sent_at=COALESCE(approval_email_sent_at,NOW()),
                  apk_refresh_published_at=COALESCE(apk_refresh_published_at,NOW()),
                  apk_refresh_build_commit=$2,
                  apk_refresh_sha256=$3
            WHERE request_id=$1
              AND approval_email_sent_at IS NULL`,
          [row.request_id, release.commit, release.sha256]
        );
      } catch (error) {
        console.error("QwerNFC approval email release check failed for " + String(row.qr_id || "") + ".", error);
      }
    }
  } finally {
    approvalReleaseCheckRunning = false;
  }
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_update_requests (
      request_id UUID PRIMARY KEY,
      qr_id TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolved_by TEXT,
      approval_email_sent_at TIMESTAMPTZ
    );
    ALTER TABLE customer_update_requests
      ADD COLUMN IF NOT EXISTS approval_email_sent_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS apk_refresh_required_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS apk_refresh_published_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS apk_refresh_build_commit TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS apk_refresh_sha256 TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS customer_update_requests_status_created_idx
      ON customer_update_requests(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS customer_update_requests_apk_refresh_pending_idx
      ON customer_update_requests(qr_id,resolved_at)
      WHERE status='approved'
        AND apk_refresh_required_at IS NOT NULL
        AND approval_email_sent_at IS NULL;
  `);
}

const server = http.createServer(async (req, res) => {
  const origin = String(req.headers.origin || "");
  const allowedOrigin = corsOrigin(req);

  if (origin && !allowedOrigin) {
    return json(res, 403, { error: "Origin not allowed." });
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": allowedOrigin || "https://keishirogane1.github.io",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-max-age": "600",
      "vary": "Origin"
    });
    return res.end();
  }

  try {
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      await pool.query("SELECT 1");
      return json(res, 200, { ok: true, service: "qwernfc-customer-update-api" }, allowedOrigin);
    }

    if (req.method === "POST" && url.pathname === "/v1/requests") {
      if (rateLimit(req)) return json(res, 429, { error: "Too many requests. Try again shortly." }, allowedOrigin);
      const payload = normalizePayload(await readBody(req, 900 * 1024));
      const requestId = randomUUID();

      await pool.query(
        `INSERT INTO customer_update_requests(request_id, qr_id, payload, status)
         VALUES($1,$2,$3::jsonb,'pending')`,
        [requestId, payload.id, JSON.stringify(payload)]
      );

      return json(res, 201, {
        requestId,
        status: "pending",
        qrId: payload.id,
        createdAt: payload.requestedAt
      }, allowedOrigin);
    }

    if (req.method === "GET" && url.pathname === "/v1/requests") {
      await verifyAdmin(req);
      const status = ["pending", "approved", "rejected"].includes(url.searchParams.get("status"))
        ? url.searchParams.get("status")
        : "pending";
      await pool.query("DELETE FROM customer_update_requests WHERE created_at < NOW() - INTERVAL '30 days'");
      const result = await pool.query(
        `SELECT request_id, qr_id, payload, status, created_at, resolved_at,
                apk_refresh_required_at,apk_refresh_published_at,approval_email_sent_at
           FROM customer_update_requests
          WHERE status = $1
          ORDER BY created_at DESC
          LIMIT 100`,
        [status]
      );

      return json(res, 200, {
        requests: result.rows.map((row) => ({
          requestId: row.request_id,
          qrId: row.qr_id,
          payload: row.payload,
          status: row.status,
          createdAt: row.created_at,
          resolvedAt: row.resolved_at,
          apkRefreshRequiredAt: row.apk_refresh_required_at,
          apkRefreshPublishedAt: row.apk_refresh_published_at,
          approvalEmailSentAt: row.approval_email_sent_at
        }))
      }, allowedOrigin);
    }

    const resolveMatch = url.pathname.match(/^\/v1\/requests\/([0-9a-f-]{36})\/resolve$/i);
    if (req.method === "POST" && resolveMatch) {
      const login = await verifyAdmin(req);
      const body = await readBody(req);
      const status = body?.status === "approved" ? "approved" : body?.status === "rejected" ? "rejected" : "";
      if (!status) throw Object.assign(new Error("Resolution status must be approved or rejected."), { status: 400 });

      const result = await pool.query(
        `UPDATE customer_update_requests
            SET status=$2,
                resolved_at=NOW(),
                resolved_by=$3,
                apk_refresh_required_at=CASE WHEN $2='approved' THEN NOW() ELSE apk_refresh_required_at END,
                apk_refresh_published_at=CASE WHEN $2='approved' THEN NULL ELSE apk_refresh_published_at END,
                apk_refresh_build_commit=CASE WHEN $2='approved' THEN '' ELSE apk_refresh_build_commit END,
                apk_refresh_sha256=CASE WHEN $2='approved' THEN '' ELSE apk_refresh_sha256 END,
                approval_email_sent_at=CASE WHEN $2='approved' THEN NULL ELSE approval_email_sent_at END
          WHERE request_id=$1 AND status='pending'
          RETURNING request_id, qr_id, payload, status, resolved_at,apk_refresh_required_at`,
        [resolveMatch[1], status, login]
      );

      if (!result.rowCount) throw Object.assign(new Error("Pending request not found."), { status: 404 });

      const emailDelivery = status === "approved"
        ? {
            configured: Boolean(BREVO_API_KEY && BREVO_SENDER_EMAIL),
            sent: false,
            deferred: true,
            reason: "apk_refresh_pending"
          }
        : null;

      if (status === "approved") {
        void processReadyApprovalEmails().catch((error) => console.error("Approval email release check failed.", error));
      }

      const { payload: _payload, ...responseRow } = result.rows[0];
      return json(res, 200, { ...responseRow, emailDelivery }, allowedOrigin);
    }

    return json(res, 404, { error: "Not found." }, allowedOrigin);
  } catch (error) {
    const status = Number(error?.status || 500);
    if (status >= 500) console.error(error);
    return json(res, status, { error: error?.message || "Server error." }, allowedOrigin);
  }
});

initDatabase()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log("QwerNFC customer update API listening on port " + PORT);
      void processReadyApprovalEmails().catch((error) => console.error("Approval email release check failed.", error));
      const approvalReleaseTimer = setInterval(() => {
        void processReadyApprovalEmails().catch((error) => console.error("Approval email release check failed.", error));
      }, 60_000);
      approvalReleaseTimer.unref();
    });
  })
  .catch((error) => {
    console.error("Database initialization failed.", error);
    process.exit(1);
  });
