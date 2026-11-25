const form = document.querySelector("#chat-form");
const promptInput = document.querySelector("#prompt");
const messagesElement = document.querySelector("#messages");
const welcomeElement = document.querySelector("#welcome");
const sendButton = document.querySelector("#send-button");
const modelLabel = document.querySelector("#model-label");
const systemPromptInput = document.querySelector("#system-prompt");
const SYSTEM_PROMPT_STORAGE_KEY = "tomodachi.systemPrompt.v1";
const API_BASE_URL = window.TOMODACHI_API_URL.replace(/\/+$/, "");
let messages = [];
let sessionId = createSessionId();
let busy = false;

function createSessionId() {
  return `s-${crypto.randomUUID()}`;
}

function addMessage(role, content, metadata) {
  const row = document.createElement("article");
  row.className = `message ${role}`;
  if (role === "assistant") row.dataset.testid = "assistant-message";
  if (role === "assistant") {
    const avatar = document.createElement("span");
    avatar.className = "message-avatar";
    avatar.textContent = "t.";
    avatar.setAttribute("aria-hidden", "true");
    row.append(avatar);
  }

  const body = document.createElement("div");
  body.className = "message-body";
  const label = document.createElement("p");
  label.className = "message-role";
  label.textContent = role === "assistant" ? "Tomodachi" : "You";
  const text = document.createElement("div");
  text.className = "message-content";
  text.textContent = content;
  body.append(label, text);
  if (role === "assistant" && metadata) {
    const details = document.createElement("div");
    details.className = "reply-metadata";
    const items = [
      ["meta-source", metadata.resolution_source || "UNKNOWN"],
      ["meta-model", metadata.model || "Unknown"],
      ["meta-latency", `${Number.isFinite(metadata.latency_ms) ? metadata.latency_ms : 0} ms`],
      ["meta-input-tokens", String(metadata.input_tokens ?? 0)],
      ["meta-output-tokens", String(metadata.output_tokens ?? 0)]
    ];
    for (const [testId, value] of items) {
      const item = document.createElement("span");
      item.className = testId === "meta-source" ? "metadata-source" : "metadata-item";
      item.dataset.testid = testId;
      item.textContent = value;
      details.append(item);
    }
    const key = document.createElement("span");
    key.className = "metadata-item";
    key.textContent = `Key: ${metadata.key_id || "cache"}`;
    const fallbacks = document.createElement("span");
    fallbacks.className = "metadata-item";
    fallbacks.textContent = `Fallbacks: ${metadata.fallback_attempts ?? 0}`;
    details.append(key, fallbacks);
    body.append(details);
  }
  row.append(body);
  messagesElement.append(row);
  row.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return row;
}

function addChatError(message) {
  const row = document.createElement("article");
  row.className = "message assistant chat-error";
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.textContent = "t.";
  avatar.setAttribute("aria-hidden", "true");
  const body = document.createElement("div");
  body.className = "message-body";
  const label = document.createElement("p");
  label.className = "message-role";
  label.textContent = "Tomodachi";
  const text = document.createElement("div");
  text.className = "message-content";
  text.textContent = message;
  body.append(label, text);
  row.append(avatar, body);
  messagesElement.append(row);
  row.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderMessages() {
  messagesElement.replaceChildren();
  welcomeElement.hidden = messages.length > 0;
  for (const message of messages) addMessage(message.role, message.content, message.metadata);
}

function resizeInput() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  promptInput.disabled = value;
  sendButton.querySelector("span:first-child").textContent = value ? "Thinking" : "Send";
}

async function submitMessage(text) {
  const content = text.trim();
  if (!content || busy) return;
  messages.push({ role: "user", content });
  renderMessages();
  promptInput.value = "";
  resizeInput();

  const typingRow = document.createElement("article");
  typingRow.className = "message assistant";
  typingRow.innerHTML = '<span class="message-avatar" aria-hidden="true">t.</span><div class="message-body"><p class="message-role">Tomodachi</p><div class="typing-dots" aria-label="Tomodachi is thinking"><span></span><span></span><span></span></div></div>';
  messagesElement.append(typingRow);
  typingRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
  setBusy(true);

  try {
    const response = await fetch(`${API_BASE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        message: content,
        system_prompt: systemPromptInput.value
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || "Something went wrong. Please try again.");
    }
    const metadata = data.metadata;
    messages.push({ role: "assistant", content: data.reply, metadata });
    modelLabel.textContent = metadata.model || "AI companion";
    typingRow.remove();
    addMessage("assistant", data.reply, metadata);
  } catch (error) {
    typingRow.remove();
    addChatError(error.message || "Could not reach Tomodachi. Please try again.");
  } finally {
    setBusy(false);
    promptInput.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submitMessage(promptInput.value);
});

promptInput.addEventListener("input", resizeInput);
systemPromptInput.value = localStorage.getItem(SYSTEM_PROMPT_STORAGE_KEY) || "";
systemPromptInput.addEventListener("input", () => {
  localStorage.setItem(SYSTEM_PROMPT_STORAGE_KEY, systemPromptInput.value);
});
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

document.querySelector("#new-chat").addEventListener("click", resetConversation);
document.querySelector("#clear-chat").addEventListener("click", resetConversation);
document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => submitMessage(button.dataset.prompt || ""));
});

function resetConversation() {
  if (busy) return;
  messages = [];
  sessionId = createSessionId();
  messagesElement.replaceChildren();
  welcomeElement.hidden = false;
  systemPromptInput.value = "";
  localStorage.removeItem(SYSTEM_PROMPT_STORAGE_KEY);
  promptInput.value = "";
  resizeInput();
  promptInput.focus();
}

renderMessages();
