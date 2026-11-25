const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const Database = require("better-sqlite3");

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_SYSTEM_PROMPT_LENGTH = 4000;
const DEFAULT_SYSTEM_PROMPT = "You are Tomodachi, a helpful, thoughtful assistant. Be clear and friendly.";

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function errorResponse(response, status, detail) {
  return jsonResponse(response, status, { detail });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error("request body is too large"), { status: 422 }));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (settled) return;
      try {
        resolve(JSON.parse(body));
      } catch {
        settled = true;
        reject(Object.assign(new Error("malformed JSON body"), { status: 422 }));
      }
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function validSessionId(value) {
  return typeof value === "string" && value.trim().length >= 1 && value.length <= 128;
}

function getDatabasePath(databaseUrl) {
  if (databaseUrl.startsWith("file:")) {
    return decodeURIComponent(new URL(databaseUrl).pathname);
  }
  if (databaseUrl.startsWith("sqlite://")) {
    return decodeURIComponent(new URL(databaseUrl.replace(/^sqlite:/, "file:")).pathname);
  }
  return databaseUrl;
}

function createApp(options = {}) {
  const gatewayUrl = (options.gatewayUrl || process.env.LITELLM_BASE_URL || "http://127.0.0.1:4000/v1")
    .replace(/\/+$/, "");
  const gatewayKey = options.gatewayKey || process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || "";
  const model = options.model || process.env.LITELLM_MODEL || "tomodachi";
  const fetchImpl = options.fetchImpl || fetch;
  const gatewayTimeoutMs = Math.max(1000, Number(options.timeoutMs || process.env.LITELLM_TIMEOUT_MS) || 45000);
  const failureSimulationEnabled = options.enableFailureSimulation ??
    process.env.ENABLE_FAILURE_SIMULATION === "true";
  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL || path.join(__dirname, "data", "app.db");
  const databasePath = getDatabasePath(databaseUrl);
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      system_prompt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS messages_session_id_id_idx ON messages(session_id, id);
  `);
  const getSession = database.prepare(
    "SELECT session_id, system_prompt FROM sessions WHERE session_id = ?"
  );
  const insertSession = database.prepare(
    "INSERT OR IGNORE INTO sessions (session_id, system_prompt, created_at, updated_at) VALUES (?, ?, ?, ?)"
  );
  const updateSession = database.prepare(
    "UPDATE sessions SET system_prompt = ?, updated_at = ? WHERE session_id = ?"
  );
  const getHistory = database.prepare(
    "SELECT role, content, metadata FROM messages WHERE session_id = ? ORDER BY id"
  );
  const insertMessage = database.prepare(
    "INSERT INTO messages (session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const saveTurn = database.transaction(({ sessionId, systemPrompt, userMessage, reply, metadata, now }) => {
    updateSession.run(systemPrompt, now, sessionId);
    insertMessage.run(sessionId, "user", userMessage, null, now);
    insertMessage.run(sessionId, "assistant", reply, JSON.stringify(metadata), now);
  });
  const frontendOrigin = process.env.FRONTEND_ORIGIN || "";

  function setCorsHeaders(request, response) {
    const origin = request.headers.origin;
    if (!origin) return true;
    let configuredOrigin = frontendOrigin;
    if (configuredOrigin && !/^https?:\/\//i.test(configuredOrigin)) {
      configuredOrigin = `https://${configuredOrigin}`;
    }
    if (configuredOrigin && origin !== configuredOrigin) return false;
    response.setHeader("Access-Control-Allow-Origin", configuredOrigin || origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return true;
  }

  async function getConfiguredKeys() {
    const headers = {};
    if (gatewayKey) headers.Authorization = `Bearer ${gatewayKey}`;
    const response = await fetchImpl(`${gatewayUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(gatewayTimeoutMs)
    });
    if (!response.ok) throw new Error("LiteLLM model list is unavailable.");
    const result = await response.json();
    const models = Array.isArray(result.data) ? result.data : [];
    return models.filter(({ id }) =>
      typeof id === "string" && (id === "tomodachi" || /^tomodachi-key_\d+$/.test(id))
    ).length;
  }

  function parseSimulatedFailures(value, keyIds) {
    if (!failureSimulationEnabled || !value) return new Map();
    const failures = new Map();
    for (const entry of value.split(",")) {
      const match = entry.trim().match(/^(\*|key_\d+)=(429|500|502|503)$/);
      if (!match) throw Object.assign(new Error("invalid X-Simulate-Failure format"), { status: 422 });
      if (match[1] === "*") {
        for (const keyId of keyIds) failures.set(keyId, Number(match[2]));
      } else {
        if (!keyIds.includes(match[1])) {
          throw Object.assign(new Error("X-Simulate-Failure references an unknown key id"), { status: 422 });
        }
        failures.set(match[1], Number(match[2]));
      }
    }
    return failures;
  }

  async function complete(messages, simulatedFailures, deployments) {
    let fallbackAttempts = 0;
    for (const deployment of deployments) {
      if (simulatedFailures.has(deployment.keyId)) {
        fallbackAttempts += 1;
        continue;
      }
      try {
        const headers = { "Content-Type": "application/json" };
        if (gatewayKey) headers.Authorization = `Bearer ${gatewayKey}`;
        const upstream = await fetchImpl(`${gatewayUrl}/chat/completions`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(gatewayTimeoutMs),
          body: JSON.stringify({ model: deployment.modelName, messages })
        });
        if (!upstream.ok) {
          await upstream.arrayBuffer();
          fallbackAttempts += 1;
          continue;
        }

        const data = await upstream.json();
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          fallbackAttempts += 1;
          continue;
        }
        const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
        const cacheHit = Boolean(upstream.headers.get("x-litellm-cache-key"));
        const modelId = upstream.headers.get("x-litellm-model-id") || deployment.keyId;
        const gatewayModel = upstream.headers.get("x-litellm-model-name");
        return {
          status: 200,
          content,
          metadata: {
            resolution_source: cacheHit ? "LLM_CACHE" : "LIVE_INFERENCE",
            model: gatewayModel || (typeof data.model === "string" ? data.model : deployment.modelName),
            input_tokens: tokenCount(data.usage?.prompt_tokens),
            output_tokens: tokenCount(data.usage?.completion_tokens),
            key_id: cacheHit || !/^key_\d+$/.test(modelId || "") ? null : modelId,
            fallback_attempts: cacheHit ? 0 : fallbackAttempts
          }
        };
      } catch (error) {
        fallbackAttempts += 1;
        console.error(`LiteLLM request for ${deployment.keyId} failed:`, error.message);
      }
    }
    return { status: 503, detail: "all providers unavailable" };
  }

  async function getConfiguredDeployments() {
    const headers = {};
    if (gatewayKey) headers.Authorization = `Bearer ${gatewayKey}`;
    const response = await fetchImpl(`${gatewayUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(gatewayTimeoutMs)
    });
    if (!response.ok) throw new Error("LiteLLM model list is unavailable.");
    const result = await response.json();
    const models = Array.isArray(result.data) ? result.data : [];
    const names = new Set(models.map(({ id }) => id).filter((id) => typeof id === "string"));
    const keyIds = [];
    for (let index = 1; names.has(index === 1 ? model : `tomodachi-key_${index}`); index += 1) {
      keyIds.push(`key_${index}`);
    }
    return keyIds.map((keyId, index) => ({
      keyId,
      modelName: index === 0 ? model : `tomodachi-key_${index + 1}`
    }));
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      if (!setCorsHeaders(request, response)) {
        return errorResponse(response, 403, "origin is not allowed");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        return response.end();
      }

      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        try {
          const databaseStatus = database.pragma("quick_check")[0]?.quick_check;
          const keysConfigured = (await getConfiguredDeployments()).length;
          if (databaseStatus !== "ok" || keysConfigured < 2) {
            return errorResponse(response, 503, "database or provider key pool unavailable");
          }
          return jsonResponse(response, 200, {
            status: "ok",
            keys_configured: keysConfigured,
            cache_enabled: true
          });
        } catch (error) {
          console.error("Health check failed:", error.message);
          return errorResponse(response, 503, "database or provider key pool unavailable");
        }
      }

      if (request.method === "POST" && url.pathname === "/chat") {
        const requestStartedAt = performance.now();
        let payload;
        try {
          payload = await readJson(request);
        } catch (error) {
          return errorResponse(response, error.status || 422, error.message || "malformed JSON body");
        }

        if (!validSessionId(payload?.session_id)) {
          return errorResponse(response, 422, "session_id must be a non-empty string of at most 128 characters");
        }
        if (typeof payload?.message !== "string" || !payload.message.trim()) {
          return errorResponse(response, 422, "message must be a non-empty string");
        }
        const userMessage = payload.message.trim();
        if (userMessage.length > MAX_MESSAGE_LENGTH) {
          return errorResponse(response, 422, "message must be at most 4000 characters after trimming");
        }
        if (
          payload.system_prompt !== undefined &&
          (typeof payload.system_prompt !== "string" || payload.system_prompt.length > MAX_SYSTEM_PROMPT_LENGTH)
        ) {
          return errorResponse(response, 422, "system_prompt must be a string of at most 4000 characters");
        }
        let deployments;
        let simulatedFailures;
        try {
          deployments = await getConfiguredDeployments();
          simulatedFailures = parseSimulatedFailures(
            request.headers["x-simulate-failure"],
            deployments.map(({ keyId }) => keyId)
          );
        } catch (error) {
          if (error.status === 422) return errorResponse(response, 422, error.message);
          console.error("Unable to load LiteLLM key pool:", error.message);
          return errorResponse(response, 503, "all providers unavailable");
        }

        const sessionId = payload.session_id;
        const now = new Date().toISOString();
        insertSession.run(sessionId, DEFAULT_SYSTEM_PROMPT, now, now);
        const session = getSession.get(sessionId);
        const systemPrompt = payload.system_prompt === undefined
          ? session.system_prompt
          : payload.system_prompt.trim() || DEFAULT_SYSTEM_PROMPT;
        const history = getHistory.all(sessionId).map(({ role, content }) => ({ role, content }));
        const messages = [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: userMessage }
        ];

        const result = await complete(messages, simulatedFailures, deployments);
        if (result.status !== 200) return errorResponse(response, result.status, result.detail);

        const latencyMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
        const metadata = { ...result.metadata, latency_ms: latencyMs };
        saveTurn({
          sessionId,
          systemPrompt,
          userMessage,
          reply: result.content,
          metadata,
          now: new Date().toISOString()
        });
        return jsonResponse(response, 200, {
          session_id: sessionId,
          reply: result.content,
          metadata
        });
      }

      const historyMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (request.method === "GET" && historyMatch) {
        let sessionId;
        try {
          sessionId = decodeURIComponent(historyMatch[1]);
        } catch {
          return errorResponse(response, 404, "session not found");
        }
        if (!validSessionId(sessionId) || !getSession.get(sessionId)) {
          return errorResponse(response, 404, "session not found");
        }
        const messages = getHistory.all(sessionId).map((row) => {
          const message = { role: row.role, content: row.content };
          if (row.role === "assistant" && row.metadata) message.metadata = JSON.parse(row.metadata);
          return message;
        });
        return jsonResponse(response, 200, { session_id: sessionId, messages });
      }

      return errorResponse(response, 404, "not found");
    })().catch((error) => {
      console.error("Unhandled request error:", error);
      if (!response.headersSent) {
        errorResponse(response, 500, "internal server error");
      } else if (!response.destroyed) {
        response.end();
      }
    });
  });
  server.on("close", () => database.close());
  return server;
}

if (require.main === module) {
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`Tomodachi is listening on port ${port}.`);
  });
}

module.exports = { createApp };
