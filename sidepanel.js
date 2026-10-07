/* PacketForge Intercept — request AND response interception via chrome.debugger + CDP Fetch domain.
 * Request pauses are forwarded with Fetch.continueRequest (edited URL/method/headers/postData).
 * Response pauses are fulfilled with Fetch.fulfillRequest (edited status/headers/body). */

const $ = (id) => document.getElementById(id);
const el = {
  toggle: $("spToggle"),
  mode: $("spMode"),
  target: $("spTarget"),
  forwardAll: $("spForwardAll"),
  dropAll: $("spDropAll"),
  filter: $("spFilter"),
  status: $("spStatus"),
  count: $("spCount"),
  queue: $("spQueue"),
  detail: $("spDetail"),
  detailTitle: $("spDetailTitle"),
  detailClose: $("spDetailClose"),
  editUrl: $("spEditUrl"),
  editUrlLabel: $("spEditUrlLabel"),
  editMethod: $("spEditMethod"),
  editMethodLabel: $("spEditMethodLabel"),
  editStatus: $("spEditStatus"),
  editStatusLabel: $("spEditStatusLabel"),
  editHeaders: $("spEditHeaders"),
  editBody: $("spEditBody"),
  editBodyLabel: $("spEditBodyLabel"),
  editNote: $("spEditNote"),
  forwardOne: $("spForwardOne"),
  sendRepeater: $("spSendRepeater"),
  dropOne: $("spDropOne"),
};

let intercepting = false;
let attachedTabId = null;
let mode = "both"; // "requests" | "responses" | "both" — default shows both features up front
const queue = new Map();
let selectedId = null;
const LOADING_PLACEHOLDER = "（响应体加载中…）";

/* ---------- helpers ---------- */

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function setStatus(text) {
  el.status.textContent = text;
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64);
  try {
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    return bin;
  }
}

function looksBinary(text) {
  if (text.indexOf("\u0000") !== -1) return true;
  let ctrl = 0;
  const n = Math.min(text.length, 2048);
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return ctrl / Math.max(n, 1) > 0.05;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function refreshTargetLabel() {
  const tab = await getActiveTab();
  el.target.textContent = tab ? (new URL(tab.url || "about:blank").host || tab.url) : "无标签页";
  return tab;
}

function send(target, method, params) {
  return chrome.debugger.sendCommand(target, method, params);
}

/* ---------- interception lifecycle ---------- */

function fetchPatterns() {
  // CDP Fetch.enable RequestPattern has a single stage field `requestStage` whose value
  // selects the stage: "Request" (before send) or "Response" (after response headers,
  // before the body reaches the page — the body is then pulled with getResponseBody).
  const patterns = [];
  if (mode === "requests" || mode === "both") patterns.push({ urlPattern: "*", requestStage: "Request" });
  if (mode === "responses" || mode === "both") patterns.push({ urlPattern: "*", requestStage: "Response" });
  return patterns;
}

async function startIntercept() {
  const tab = await getActiveTab();
  if (!tab) { setStatus("没有活动标签页。"); return false; }
  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    await send({ tabId: tab.id }, "Fetch.enable", { patterns: fetchPatterns() });
    attachedTabId = tab.id;
    intercepting = true;
    applyToggleUI();
    setStatus(`拦截已开启（${modeLabel(mode)}）——匹配流量已扣下。刷新页面以捕获其加载请求。`);
    return true;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/Another debugger|already attached|Cannot attach/i.test(msg)) {
      setStatus("无法附加——请先关闭该标签页上的 DevTools（每页只能有一个调试器）再试。");
    } else {
      setStatus("附加失败：" + msg);
    }
    return false;
  }
}

async function releaseAll() {
  for (const id of Array.from(queue.keys())) {
    try { await send({ tabId: attachedTabId }, "Fetch.continueRequest", { requestId: id }); } catch (e) {}
  }
  queue.clear();
  renderQueue();
  closeDetail();
}

async function stopIntercept() {
  intercepting = false;
  applyToggleUI();
  await releaseAll();
  if (attachedTabId != null) {
    try { await send({ tabId: attachedTabId }, "Fetch.disable"); } catch (e) {}
    try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch (e) {}
  }
  attachedTabId = null;
  setStatus("拦截已关闭——流量正常放行。");
}

async function applyModeChange() {
  if (!intercepting || attachedTabId == null) return;
  // Held items belong to the old pattern set; release them before re-arming Fetch.
  await releaseAll();
  try {
    await send({ tabId: attachedTabId }, "Fetch.disable");
    await send({ tabId: attachedTabId }, "Fetch.enable", { patterns: fetchPatterns() });
    setStatus(`模式已切换为 ${modeLabel(mode)}——已扣住的条目已放行。`);
  } catch (e) {
    setStatus("模式切换失败：" + String((e && e.message) || e));
  }
}

function modeLabel(m) {
  return m === "both" ? "请求 + 回包" : m === "responses" ? "回包" : "请求";
}

/* ---------- event handling ---------- */

chrome.debugger.onEvent.addListener((source, methodName, params) => {
  if (methodName !== "Fetch.requestPaused") return;
  if (attachedTabId == null || source.tabId !== attachedTabId) return;

  // HTTP auth challenges pause without a stage — pass them through untouched.
  if (params.authChallenge) {
    send(source, "Fetch.continueWithAuth", { requestId: params.requestId, authChallengeResponse: { response: "Default" } }).catch(() => {});
    return;
  }

  const isResponse = params.responseStatusCode !== undefined || params.responseErrorReason !== undefined;
  const url = (params.request && params.request.url) || "";
  const filter = el.filter.value.trim();
  if (filter && url.indexOf(filter) === -1) {
    send(source, "Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
    return;
  }

  const item = isResponse
    ? {
        kind: "response",
        requestId: params.requestId,
        url,
        method: params.request ? params.request.method : "",
        status: params.responseStatusCode,
        headers: params.responseHeaders || [],
        resourceType: params.resourceType,
        bodyText: null,
        bodyBase64: null,
        bodyFailed: false,
        binary: false,
      }
    : {
        kind: "request",
        requestId: params.requestId,
        request: params.request,
        resourceType: params.resourceType,
      };
  queue.set(params.requestId, item);
  renderQueue();
  setStatus(`已扣住 ${queue.size} 条——点击查看/编辑，然后放行或丢弃。`);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === attachedTabId) {
    attachedTabId = null;
    intercepting = false;
    queue.clear();
    applyToggleUI();
    renderQueue();
    closeDetail();
    setStatus(`Debugger detached (${reason}). Intercept OFF.`);
  }
});

/* ---------- queue rendering ---------- */

function renderQueue() {
  el.count.textContent = queue.size ? String(queue.size) : "";
  if (queue.size === 0) {
    el.queue.innerHTML = '<li class="sp-empty">没有扣住的请求。</li>';
    return;
  }
  el.queue.innerHTML = [...queue.entries()].map(([id, item]) => {
    const kindClass = item.kind === "response" ? "response" : "request";
    const kindText = item.kind === "response" ? "RESP" : "REQ";
    const url = item.kind === "response" ? item.url : (item.request.url || "");
    const meta = item.kind === "response"
      ? `${item.status || "?"} · ${item.resourceType || ""}`
      : (item.resourceType || "");
    return `
      <li class="sp-item" data-id="${esc(id)}">
        <div class="sp-item-main" data-act="open" data-id="${esc(id)}">
          <div>
            <span class="sp-kind ${kindClass}">${kindText}</span>
            <span class="sp-method">${esc(item.kind === "response" ? item.status || "—" : item.request.method)}</span>
            <span class="sp-rtype">${esc(meta)}</span>
          </div>
          <span class="sp-url">${esc(url.slice(0, 90))}</span>
        </div>
        <div class="sp-item-btns">
          <button type="button" class="btn btn-small" data-act="forward" data-id="${esc(id)}">→</button>
          <button type="button" class="btn btn-small" data-act="drop" data-id="${esc(id)}">✕</button>
        </div>
      </li>
    `;
  }).join("");
}

/* ---------- detail editor ---------- */

function showDetailFields(kind) {
  const showUrlMethod = kind === "request";
  el.editUrl.classList.toggle("hidden", !showUrlMethod);
  el.editUrlLabel.classList.toggle("hidden", !showUrlMethod);
  el.editMethod.classList.toggle("hidden", !showUrlMethod);
  el.editMethodLabel.classList.toggle("hidden", !showUrlMethod);
  el.editStatus.classList.toggle("hidden", showUrlMethod);
  el.editStatusLabel.classList.toggle("hidden", showUrlMethod);
}

function openDetail(id) {
  const item = queue.get(id);
  if (!item) return;
  selectedId = id;
  el.editNote.textContent = "";
  el.forwardOne.disabled = false;
  if (item.kind === "request") {
    el.detailTitle.textContent = `REQ ${item.request.method} ${item.request.url}`.slice(0, 90);
    el.editUrl.value = item.request.url || "";
    el.editMethod.value = item.request.method || "GET";
    el.editHeaders.value = Object.entries(item.request.headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n");
    el.editBody.value = item.request.postData || "";
    showDetailFields("request");
  } else {
    el.detailTitle.textContent = `RESP ${item.status || "—"} ${item.url}`.slice(0, 90);
    el.editStatus.value = String(item.status || 200);
    el.editHeaders.value = (item.headers || []).map((h) => `${h.name}: ${h.value}`).join("\n");
    if (item.bodyText != null) {
      el.editBody.value = item.bodyText;
    } else if (item.bodyFailed) {
      el.editBody.value = "";
      el.editNote.textContent = "响应体加载失败——放行时将原样透传。";
    } else {
      el.editBody.value = LOADING_PLACEHOLDER;
      el.forwardOne.disabled = true;
      item.bodyPromise = loadResponseBody(item);
    }
    if (item.binary) el.editNote.textContent = "二进制内容——未编辑时按原始字节放行。";
    showDetailFields("response");
  }
  el.detail.classList.remove("hidden");
}

async function loadResponseBody(item) {
  try {
    const res = await send({ tabId: attachedTabId }, "Fetch.getResponseBody", { requestId: item.requestId });
    if (queue.get(item.requestId) !== item) return; // item was released meanwhile
    if (res.base64Encoded) {
      item.bodyBase64 = res.body;
      item.bodyText = base64ToUtf8(res.body);
    } else {
      item.bodyBase64 = null;
      item.bodyText = res.body;
    }
    item.binary = looksBinary(item.bodyText);
  } catch (e) {
    item.bodyFailed = true;
    if (queue.get(item.requestId) === item) item.bodyText = null;
  }
  if (selectedId === item.requestId) {
    el.editBody.value = item.bodyText != null ? item.bodyText : "";
    el.forwardOne.disabled = false;
    if (item.bodyFailed) el.editNote.textContent = "响应体加载失败——放行时将原样透传。";
    else if (item.binary) el.editNote.textContent = "二进制内容——未编辑时按原始字节放行。";
  }
}

function closeDetail() {
  el.detail.classList.add("hidden");
  selectedId = null;
}

function readEditor() {
  if (!selectedId) return null;
  const headers = [];
  el.editHeaders.value.split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(":");
    if (i > 0) headers.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  });
  const status = parseInt(el.editStatus.value, 10);
  return {
    url: el.editUrl.value.trim(),
    method: el.editMethod.value.trim() || "GET",
    status: Number.isFinite(status) ? status : null,
    headers,
    body: el.editBody.value,
  };
}

/* ---------- forward / drop ---------- */

async function forwardOne(id, edits) {
  const item = queue.get(id);
  if (!item) return;
  queue.delete(id);
  renderQueue();
  closeDetail();

  if (item.kind === "request") {
    const cmd = { requestId: id };
    if (edits) {
      if (edits.url) cmd.url = edits.url;
      if (edits.method) cmd.method = edits.method;
      if (edits.headers) cmd.headers = edits.headers;
      if (edits.body != null) cmd.postData = utf8ToBase64(edits.body);
    }
    try { await send({ tabId: attachedTabId }, "Fetch.continueRequest", cmd); } catch (e) {}
    return;
  }

  // Response item: fulfill with (possibly edited) status/headers/body.
  // If the body is still loading, wait for it so we never fulfill with an empty body by accident.
  if (item.bodyPromise) { try { await item.bodyPromise; } catch (e) {} }
  const status = (edits && edits.status) || item.status || 200;
  const headers = (edits && edits.headers ? edits.headers : (item.headers || []).map((h) => ({ name: h.name, value: h.value })))
    .map((h) => ({ name: String(h.name), value: String(h.value) }));

  const bodyEdited = edits
    && edits.body != null
    && item.bodyText != null
    && edits.body !== item.bodyText
    && edits.body !== LOADING_PLACEHOLDER;
  let bodyB64 = null;
  if (bodyEdited) {
    bodyB64 = utf8ToBase64(edits.body);
    // The substitute body is uncompressed UTF-8, so original framing headers no longer hold.
    for (let i = headers.length - 1; i >= 0; i--) {
      if (/^(content-encoding|content-length|transfer-encoding)$/i.test(headers[i].name)) headers.splice(i, 1);
    }
  } else if (item.bodyBase64 != null) {
    bodyB64 = item.bodyBase64;
  } else if (item.bodyText != null) {
    bodyB64 = utf8ToBase64(item.bodyText);
  }

  if (bodyB64 == null) {
    // No body available (load failed) — fulfillRequest without a body yields an empty response,
    // so pass the original response through untouched instead.
    try { await send({ tabId: attachedTabId }, "Fetch.continueRequest", { requestId: id }); } catch (e) {}
    return;
  }

  try {
    await send({ tabId: attachedTabId }, "Fetch.fulfillRequest", {
      requestId: id,
      responseCode: status,
      responseHeaders: headers,
      body: bodyB64 || undefined,
    });
  } catch (e) {
    try { await send({ tabId: attachedTabId }, "Fetch.continueRequest", { requestId: id }); } catch (e2) {}
  }
}

async function dropOne(id) {
  if (!queue.get(id)) return;
  queue.delete(id);
  try { await send({ tabId: attachedTabId }, "Fetch.failRequest", { requestId: id, errorReason: "Aborted" }); } catch (e) {}
  renderQueue();
  closeDetail();
}

async function forwardAll() {
  for (const id of Array.from(queue.keys())) await forwardOne(id);
}

async function dropAll() {
  for (const id of Array.from(queue.keys())) await dropOne(id);
}

/* ---------- send to repeater (requests only) ---------- */

function sendToRepeater(id) {
  const item = queue.get(id);
  if (!item) return;
  if (item.kind === "response") {
    setStatus("重放器只接受请求——请选择 REQ 条目。");
    return;
  }
  const source = readEditor() || {
    url: item.request.url,
    method: item.request.method,
    headers: item.request.headers,
    body: item.request.postData,
  };
  let headerText = "";
  if (Array.isArray(source.headers)) {
    headerText = source.headers.map((h) => `${h.name}: ${h.value}`).join("\n");
  } else if (source.headers && typeof source.headers === "object") {
    headerText = Object.entries(source.headers).map(([k, v]) => `${k}: ${v}`).join("\n");
  }
  try {
    chrome.storage.local.set({
      htRepeaterHandoff: {
        method: source.method || "GET",
        url: source.url || "",
        headers: headerText,
        body: source.body || "",
        at: Date.now(),
      },
    });
    setStatus("已发送到重放器。打开 DevTools → PacketForge → 重放器 编辑并重放。（该请求仍保留在此——可随意放行或丢弃。）");
  } catch (e) {}
}

/* ---------- UI wiring ---------- */

function applyToggleUI() {
  el.toggle.textContent = "拦截：" + (intercepting ? "ON" : "OFF");
  el.toggle.classList.toggle("intercept-on", intercepting);
}

el.toggle.addEventListener("click", async () => {
  if (intercepting) await stopIntercept();
  else await startIntercept();
});

el.mode.addEventListener("change", async () => {
  mode = el.mode.value;
  await applyModeChange();
});

el.forwardAll.addEventListener("click", forwardAll);
el.dropAll.addEventListener("click", dropAll);
el.detailClose.addEventListener("click", closeDetail);
el.forwardOne.addEventListener("click", () => selectedId && forwardOne(selectedId, readEditor()));
el.dropOne.addEventListener("click", () => selectedId && dropOne(selectedId));
el.sendRepeater.addEventListener("click", () => selectedId && sendToRepeater(selectedId));

el.queue.addEventListener("click", (e) => {
  const target = e.target.closest("[data-act]");
  if (!target) return;
  const id = target.dataset.id;
  const act = target.dataset.act;
  if (act === "open") openDetail(id);
  else if (act === "forward") forwardOne(id);
  else if (act === "drop") dropOne(id);
});

window.addEventListener("beforeunload", () => {
  if (attachedTabId != null) {
    try { chrome.debugger.detach({ tabId: attachedTabId }); } catch (e) {}
  }
});

/* ---------- init ---------- */

refreshTargetLabel();
chrome.tabs.onActivated.addListener(refreshTargetLabel);
renderQueue();
applyToggleUI();
