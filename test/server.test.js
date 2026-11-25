const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../server");

let server;
let gateway;
let origin;
let gatewayCalls = 0;
let gatewayMessages = [];
let gatewayFailuresToSimulate = 0;
let cacheTestCalls = 0;
let unavailableModelList = false;

after(() => new Promise((resolve) => {
  if (!server) return resolve();
  server.close(() => gateway.close(resolve));
}));

before(async () => {
  gateway = require("node:http").createServer((request, response) => {
    if (request.url === "/v1/models") {
      if (unavailableModelList) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "gateway unavailable" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        data: [{ id: "tomodachi" }, { id: "tomodachi-key_2" }]
      }));
      return;
    }

    gatewayCalls += 1;
    if (gatewayFailuresToSimulate > 0) {
      gatewayFailuresToSimulate -= 1;
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "provider unavailable" }));
      return;
    }

    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const { messages } = JSON.parse(body);
      gatewayMessages = messages;
      const prompt = messages.at(-1).content;
      const isCacheTestPrompt = prompt === "Cache me";
      if (isCacheTestPrompt) cacheTestCalls += 1;
      const cacheHit = isCacheTestPrompt && cacheTestCalls > 1;
      const fallbackUsed = prompt === "Fallback test";
      response.writeHead(200, {
        "Content-Type": "application/json",
        "x-litellm-model-id": cacheHit ? "key_1" : fallbackUsed ? "key_2" : "key_1",
        "x-litellm-model-name": fallbackUsed ? "openai/gpt-4o-backup" : "openai/gpt-4o-mini",
        "x-litellm-attempted-fallbacks": fallbackUsed ? "1" : "0",
        ...(cacheHit ? { "x-litellm-cache-key": "test-cache-key" } : {})
      });
      response.end(JSON.stringify({
        model: "tomodachi",
        usage: { prompt_tokens: 17, completion_tokens: 8 },
        choices: [{ message: { content: `Reply to: ${prompt}` } }]
      }));
    });
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  server = createApp({
    databaseUrl: ":memory:",
    gatewayUrl: `http://127.0.0.1:${gateway.address().port}/v1`,
    gatewayKey: "test-gateway-key",
    model: "tomodachi",
    enableFailureSimulation: true,
    fetchImpl: fetch
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

async function sendMessage(sessionId, message, systemPrompt) {
  const headers = { "Content-Type": "application/json" };
  if (typeof systemPrompt === "object" && systemPrompt?.simulateFailure) {
    headers["X-Simulate-Failure"] = systemPrompt.simulateFailure;
  }
  return fetch(`${origin}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      session_id: sessionId,
      message,
      ...(typeof systemPrompt === "string" ? { system_prompt: systemPrompt } : {})
    })
  });
}

test("GET /health reports database and configured gateway key-pool status", async () => {
  const response = await fetch(`${origin}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    keys_configured: 2,
    cache_enabled: true
  });

  unavailableModelList = true;
  const unhealthy = await fetch(`${origin}/health`);
  assert.equal(unhealthy.status, 503);
  assert.deepEqual(await unhealthy.json(), { detail: "database or provider key pool unavailable" });
  unavailableModelList = false;
});

test("serves JSON 404 for paths outside the three API endpoints", async () => {
  const response = await fetch(origin);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { detail: "not found" });
});

test("frontend exposes the required test IDs and page-load session behavior", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const testId of ["chat-input", "send-button", "system-prompt-input"]) {
    assert.match(html, new RegExp(`data-testid="${testId}"`));
  }
  for (const testId of [
    "assistant-message",
    "meta-source",
    "meta-model",
    "meta-latency",
    "meta-input-tokens",
    "meta-output-tokens"
  ]) {
    assert.ok(app.includes(`"${testId}"`) || app.includes(`'${testId}'`));
  }
  assert.match(app, /let sessionId = createSessionId\(\)/);
  assert.match(app, /addChatError\(/);
});

test("POST /chat stores backend multi-turn history and returns required metadata", async () => {
  const sessionId = "s-contract-7f3a";
  const first = await sendMessage(sessionId, "Remember the word is maple.", "Answer briefly.");
  assert.equal(first.status, 200);
  const firstResult = await first.json();
  assert.equal(firstResult.session_id, sessionId);
  assert.equal(firstResult.reply, "Reply to: Remember the word is maple.");
  assert.deepEqual(firstResult.metadata, {
    resolution_source: "LIVE_INFERENCE",
    model: "openai/gpt-4o-mini",
    input_tokens: 17,
    output_tokens: 8,
    key_id: "key_1",
    fallback_attempts: 0,
    latency_ms: firstResult.metadata.latency_ms
  });
  assert.ok(Number.isInteger(firstResult.metadata.latency_ms));

  const second = await sendMessage(sessionId, "What word should you remember?");
  assert.equal(second.status, 200);
  assert.equal(gatewayMessages[0].content, "Answer briefly.");
  assert.deepEqual(gatewayMessages.slice(1).map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "Remember the word is maple." },
    { role: "assistant", content: "Reply to: Remember the word is maple." },
    { role: "user", content: "What word should you remember?" }
  ]);

  const historyResponse = await fetch(`${origin}/sessions/${sessionId}/messages`);
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.session_id, sessionId);
  assert.deepEqual(history.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "Remember the word is maple." },
    { role: "assistant", content: "Reply to: Remember the word is maple." },
    { role: "user", content: "What word should you remember?" },
    { role: "assistant", content: "Reply to: What word should you remember?" }
  ]);
  assert.equal(history.messages[0].metadata, undefined);
  assert.equal(history.messages[1].metadata.resolution_source, "LIVE_INFERENCE");
  assert.equal(history.messages.some(({ content }) => content === "Answer briefly."), false);
});

test("reports the key id and fallback attempt count that answered", async () => {
  const response = await sendMessage("s-fallback", "Fallback test", { simulateFailure: "key_1=429" });
  assert.equal(response.status, 200);
  const { metadata } = await response.json();
  assert.equal(metadata.key_id, "key_2");
  assert.equal(metadata.fallback_attempts, 1);
  assert.equal(metadata.model, "openai/gpt-4o-backup");
});

test("X-Simulate-Failure skips failing keys and returns a real fallback answer", async () => {
  for (const [failure, expectedKey] of [
    ["key_1=429", "key_2"],
    ["key_1=500", "key_2"],
    ["key_1=502", "key_2"],
    ["key_1=503", "key_2"]
  ]) {
    const response = await sendMessage(`s-${failure}`, "Fallback test", { simulateFailure: failure });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.reply, "Reply to: Fallback test");
    assert.equal(result.metadata.key_id, expectedKey);
    assert.equal(result.metadata.fallback_attempts, 1);
    assert.equal(result.metadata.resolution_source, "LIVE_INFERENCE");
  }
});

test("X-Simulate-Failure is ignored when the feature switch is disabled", async () => {
  const disabledServer = createApp({
    databaseUrl: ":memory:",
    gatewayUrl: `http://127.0.0.1:${gateway.address().port}/v1`,
    gatewayKey: "test-gateway-key",
    model: "tomodachi",
    enableFailureSimulation: false,
    fetchImpl: fetch
  });
  try {
    await new Promise((resolve) => disabledServer.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${disabledServer.address().port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Simulate-Failure": "key_1=429"
      },
      body: JSON.stringify({ session_id: "s-disabled-simulation", message: "Simulation disabled." })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).metadata.key_id, "key_1");
  } finally {
    await new Promise((resolve) => disabledServer.close(resolve));
  }
});

test("simulated failure of every key returns 503 without saving the turn", async () => {
  for (const [sessionId, failure] of [
    ["s-all-429", "*=429"],
    ["s-all-mixed", "key_1=429,key_2=500"]
  ]) {
    const response = await sendMessage(sessionId, "No provider should answer.", { simulateFailure: failure });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { detail: "all providers unavailable" });
    const history = await fetch(`${origin}/sessions/${sessionId}/messages`);
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json()).messages, []);
  }
});

test("rejects malformed failure simulation directives", async () => {
  const response = await fetch(`${origin}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Simulate-Failure": "key_1=400"
    },
    body: JSON.stringify({ session_id: "s-invalid-simulation", message: "Invalid simulation." })
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { detail: "invalid X-Simulate-Failure format" });
});

test("LiteLLM cache hits preserve cached tokens and omit key identity", async () => {
  cacheTestCalls = 0;
  const first = await sendMessage("s-cache-a", "Cache me");
  assert.equal((await first.json()).metadata.resolution_source, "LIVE_INFERENCE");

  const second = await sendMessage("s-cache-b", "Cache me");
  assert.equal(second.status, 200);
  const cached = await second.json();
  assert.equal(cached.metadata.resolution_source, "LLM_CACHE");
  assert.equal(cached.reply, "Reply to: Cache me");
  assert.equal(cached.metadata.input_tokens, 17);
  assert.equal(cached.metadata.output_tokens, 8);
  assert.equal(cached.metadata.key_id, null);
  assert.equal(cached.metadata.fallback_attempts, 0);

  const different = await sendMessage("s-cache-c", "A different prompt");
  assert.equal((await different.json()).metadata.resolution_source, "LIVE_INFERENCE");
});

test("SQLite conversation history survives application restarts", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tomodachi-sqlite-"));
  const databaseUrl = path.join(directory, "app.db");
  const makeServer = () => createApp({
    databaseUrl,
    gatewayUrl: `http://127.0.0.1:${gateway.address().port}/v1`,
    gatewayKey: "test-gateway-key",
    model: "tomodachi",
    fetchImpl: fetch
  });
  let firstServer;
  let secondServer;
  try {
    firstServer = makeServer();
    await new Promise((resolve) => firstServer.listen(0, "127.0.0.1", resolve));
    const firstOrigin = `http://127.0.0.1:${firstServer.address().port}`;
    const sessionId = "persist-across-restart";
    const sent = await fetch(`${firstOrigin}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message: "Persist this turn." })
    });
    assert.equal(sent.status, 200);
    await new Promise((resolve) => firstServer.close(resolve));
    firstServer = null;

    secondServer = makeServer();
    await new Promise((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
    const secondOrigin = `http://127.0.0.1:${secondServer.address().port}`;
    const restored = await fetch(`${secondOrigin}/sessions/${sessionId}/messages`);
    assert.equal(restored.status, 200);
    const { messages } = await restored.json();
    assert.deepEqual(messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "Persist this turn." },
      { role: "assistant", content: "Reply to: Persist this turn." }
    ]);
  } finally {
    if (firstServer) await new Promise((resolve) => firstServer.close(resolve));
    if (secondServer) await new Promise((resolve) => secondServer.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("provider failures return 503 and do not enter session history", async () => {
  gatewayFailuresToSimulate = 2;
  const failed = await sendMessage("s-retry", "Retry this message.");
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { detail: "all providers unavailable" });

  const historyResponse = await fetch(`${origin}/sessions/s-retry/messages`);
  assert.equal(historyResponse.status, 200);
  assert.deepEqual((await historyResponse.json()).messages, []);

  const retry = await sendMessage("s-retry", "Retry this message.");
  assert.equal(retry.status, 200);
  assert.deepEqual(gatewayMessages.map(({ role, content }) => ({ role, content })), [
    { role: "system", content: "You are Tomodachi, a helpful, thoughtful assistant. Be clear and friendly." },
    { role: "user", content: "Retry this message." }
  ]);
});

test("validates contract inputs and returns JSON detail errors", async () => {
  const malformed = await fetch(`${origin}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{"
  });
  assert.equal(malformed.status, 422);
  assert.equal(typeof (await malformed.json()).detail, "string");

  const missing = await fetch(`${origin}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "", message: "" })
  });
  assert.equal(missing.status, 422);
  assert.equal(typeof (await missing.json()).detail, "string");

  const oversized = await sendMessage("s-long", ` ${"x".repeat(4001)} `);
  assert.equal(oversized.status, 422);
  assert.equal(typeof (await oversized.json()).detail, "string");

  const unknown = await fetch(`${origin}/sessions/not-found/messages`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { detail: "session not found" });

  const removedRoute = await fetch(`${origin}/api/health`);
  assert.equal(removedRoute.status, 404);
  assert.equal(typeof (await removedRoute.json()).detail, "string");
});
