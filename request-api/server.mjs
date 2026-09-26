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
const allowedFields = new Set(["store", "phone", "email", "location", "managedLink"]);

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
    const max = field === "managedLink" ? 2048 : field === "location" ? 180 : field === "email" ? 120 : field === "store" ? 80 : 32;
    const normalized = normalizeText(value, max);
    if (!normalized) continue;
    if (field === "managedLink") {
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
    ...(locationPin ? { locationPin } : {})
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

function restoreApkDownloadUrl(qrId) {
  const id = String(qrId || "").toUpperCase();
  return `${PUBLIC_BASE}/downloads/restore/${encodeURIComponent(id)}/QwerNFC-Restore-${encodeURIComponent(id)}.apk`;
}

async function sendApprovalEmail(payload) {
  const to = String(payload?.changes?.email || "").trim();
  if (!to) return { configured: Boolean(BREVO_API_KEY && BREVO_SENDER_EMAIL), sent: false, reason: "missing_email" };
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    return { configured: false, sent: false, reason: "not_configured" };
  }

  const qrId = String(payload.id || "").toUpperCase();
  const apkUrl = restoreApkDownloadUrl(qrId);
  const changedFields = Object.keys(payload.changes || {})
    .map((field) => ({
      store: "Store name",
      phone: "Phone number",
      email: "Email address",
      location: "Location",
      managedLink: "Managed link"
    })[field] || field)
    .join(", ");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#102016">
      <h2 style="margin-bottom:8px">QwerNFC update approved</h2>
      <p>Your requested changes for <strong>${escapeHtml(qrId)}</strong> have been approved by the QwerNFC administrator.</p>
      <p><strong>Approved fields:</strong> ${escapeHtml(changedFields || "Customer information")}</p>
      <p>You can download the latest QwerNFC Restore APK for this QR below.</p>
      <p style="margin:24px 0">
        <a href="${escapeHtml(apkUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#0b7a39;color:white;text-decoration:none;font-weight:700">Download QwerNFC Restore APK</a>
      </p>
      <p style="font-size:12px;color:#607065">Permanent QR identity remains unchanged. This email does not expose private routing data.</p>
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
      subject: `QwerNFC ${qrId} update approved`,
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
      ADD COLUMN IF NOT EXISTS approval_email_sent_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS customer_update_requests_status_created_idx
      ON customer_update_requests(status, created_at DESC);
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
      const payload = normalizePayload(await readBody(req));
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
        `SELECT request_id, qr_id, payload, status, created_at, resolved_at
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
          resolvedAt: row.resolved_at
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
            SET status=$2, resolved_at=NOW(), resolved_by=$3
          WHERE request_id=$1 AND status='pending'
          RETURNING request_id, qr_id, payload, status, resolved_at`,
        [resolveMatch[1], status, login]
      );

      if (!result.rowCount) throw Object.assign(new Error("Pending request not found."), { status: 404 });

      let emailDelivery = null;
      if (status === "approved") {
        emailDelivery = await sendApprovalEmail(result.rows[0].payload);
        if (emailDelivery.sent) {
          await pool.query(
            `UPDATE customer_update_requests SET approval_email_sent_at=NOW() WHERE request_id=$1`,
            [resolveMatch[1]]
          );
        }
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
    });
  })
  .catch((error) => {
    console.error("Database initialization failed.", error);
    process.exit(1);
  });
