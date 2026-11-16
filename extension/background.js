import {
  PLATFORMS,
  validateTask,
  initialResults,
  validateResult,
  forPlatform,
  retryable,
  TERMINAL,
  isAssist,
  ensurePlatform,
} from "./shared/model.js";
import {
  platformForUrl,
  assertTarget,
  surfaceFor,
  editorUrl,
  pageRole,
} from "./shared/target.js";
import { put, get, all, remove, fileChunk } from "./shared/storage.js";
let socket,
  keepalive,
  processing = false,
  authenticated = false,
  connectTail = Promise.resolve(),
  retryTimer = null,
  retryDelay = 1000;
const activeTabs = new Map();
let queue = Promise.resolve();
const uiSender = (sender) =>
  sender.id === chrome.runtime.id &&
  sender.url?.startsWith(chrome.runtime.getURL(""));
const announce = () =>
  chrome.storage.local.set({ "publisher.lastUpdate": Date.now() });
async function save(job) {
  await put("jobs", job);
  await announce();
}
async function bridgePatch(job, platform, result) {
  if (job.bridgeJob && socket?.readyState === WebSocket.OPEN)
    socket.send(
      JSON.stringify({ type: "result", id: job.id, platform, result }),
    );
}
async function patch(id, platform, data) {
  queue = queue
    .catch(() => {})
    .then(async () => {
      const j = await get("jobs", id);
      if (!j) return;
      const next = {
        ...j.results[platform],
        ...data,
        updatedAt: new Date().toISOString(),
      };
      j.results[platform] = next;
      await save(j);
      await bridgePatch(j, platform, next);
    });
  await queue;
}
async function waitTab(tabId) {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("平台页面加载超时");
}
async function platformEditorUrl(platform, kind, tabId) {
  if (platform !== "wechat") return editorUrl(platform, kind);
  const tabs = tabId
    ? [await chrome.tabs.get(tabId)]
    : await chrome.tabs.query({});
  const context = tabs.find(
    (tab) =>
      platformForUrl(tab.url) === "wechat" &&
      new URL(tab.url).searchParams.get("token"),
  );
  return editorUrl(platform, kind, context?.url);
}
async function runPlatform(task, platform, targetTab) {
  const config = PLATFORMS[platform];
  let tab;
  try {
    if (targetTab) assertTarget(task, await chrome.tabs.get(targetTab.id));
    await patch(task.id, platform, {
      state: "opening",
      message: "打开" + config.name,
    });
    const url =
      targetTab?.url || (await platformEditorUrl(platform, task.kind));
    tab = targetTab || (await chrome.tabs.create({ url, active: true }));
    if (targetTab) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    activeTabs.set(tab.id, { id: task.id, platform });
    await patch(task.id, platform, {
      tabId: tab.id,
      editorUrl: tab.url || url,
    });
    await waitTab(tab.id);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/runner.js"],
    });
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_DRAFT",
      task: { ...forPlatform(task, platform), fillOnly: Boolean(targetTab) },
    });
    if (!response?.ok)
      throw new Error(response?.error || "平台适配器未返回结果");
    const result = validateResult(response.result);
    await patch(task.id, platform, { ...result, tabId: tab.id });
  } catch (error) {
    await patch(task.id, platform, {
      state: "failed",
      message: error.message,
      tabId: tab?.id,
      editorUrl: tab?.url,
    });
  } finally {
    if (tab) activeTabs.delete(tab.id);
  }
}
async function runTask(
  task,
  { bridgeJob = false, platforms = task.platforms } = {},
) {
  if (processing) throw new Error("另一个任务正在执行，请稍后再试");
  processing = true;
  try {
    let existing = await get("jobs", task.id);
    const job = existing || {
      ...validateTask(task),
      bridgeJob,
      results: initialResults(task),
    };
    if (existing && existing.kind !== task.kind)
      throw new Error("任务 ID 冲突");
    await save(job);
    if (job.delivery === "manual") {
      for (const p of platforms) {
        if (job.results[p]?.state === "queued" || retryable(job.results[p]))
          await patch(job.id, p, {
            state: "ready",
            message: isAssist(p)
              ? PLATFORMS[p].name +
                "需在发布页填充。打开页面后点扩展图标，选择这条视频。"
              : "素材已接收，等待在平台页点击插件填充",
          });
      }
      return;
    }
    if (job.kind === "x_reply") {
      await patch(job.id, "x", {
        state: "review_ready",
        message: "已保存到工作台，待人工发布",
      });
      return;
    }
    for (const p of platforms) {
      const current = await get("jobs", task.id);
      if (
        TERMINAL.has(current.results[p]?.state) &&
        current.results[p].state === "draft_ready"
      )
        continue;
      if (isAssist(p)) {
        if (
          current.results[p]?.state === "queued" ||
          retryable(current.results[p]) ||
          !current.results[p]
        )
          await patch(current.id, p, {
            state: "ready",
            message:
              PLATFORMS[p].name +
              "需在发布页填充。打开页面后点扩展图标，选择这条视频。",
          });
        continue;
      }
      await runPlatform(current, p);
    }
  } finally {
    processing = false;
    await announce();
  }
}
function endpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password
  )
    throw new Error("AI服务必须是本机 http://127.0.0.1 地址");
  return url.origin;
}
function bridgeOpen() {
  return authenticated && socket?.readyState === WebSocket.OPEN;
}
async function loadBridgeConfig() {
  const { bridgeConfig } = await chrome.storage.local.get("bridgeConfig");
  return bridgeConfig?.url && bridgeConfig?.token ? bridgeConfig : null;
}
function scheduleRetry() {
  clearTimeout(retryTimer);
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, 30000);
  retryTimer = setTimeout(() => {
    ensureConnected().catch(() => {});
  }, delay);
  chrome.alarms.create("bridge-reconnect", {
    delayInMinutes: 0.5,
    periodInMinutes: 0.5,
  });
}
function connectSerialized(config) {
  const run = connectTail.then(async () => {
    const root = endpoint(config.url);
    if (
      bridgeOpen() &&
      socket.url === root.replace("http:", "ws:") + "/worker"
    ) {
      const saved = await loadBridgeConfig();
      if (saved?.token === config.token) return;
    }
    await connect(config);
  });
  connectTail = run.catch(() => {});
  return run;
}
async function ensureConnected() {
  clearTimeout(retryTimer);
  if (bridgeOpen()) return true;
  const config = await loadBridgeConfig();
  if (!config) return false;
  try {
    await connectSerialized(config);
    return bridgeOpen();
  } catch {
    return false;
  }
}
async function connect(config) {
  const root = endpoint(config.url);
  if (!/^[a-f0-9]{64}$/.test(config.token))
    throw new Error("连接令牌格式不正确");
  await chrome.storage.local.set({
    bridgeConfig: { url: root, token: config.token },
  });
  authenticated = false;
  clearInterval(keepalive);
  const previous = socket;
  socket = null;
  previous?.close();
  socket = new WebSocket(root.replace("http:", "ws:") + "/worker");
  const current = socket;
  socket.onopen = () =>
    current.send(
      JSON.stringify({
        type: "hello",
        token: config.token,
        worker: chrome.runtime.id,
        capabilities: ["manual-stage"],
      }),
    );
  socket.onmessage = async (event) => {
    try {
      const m = JSON.parse(event.data);
      if (m.type === "hello") {
        authenticated = true;
        retryDelay = 1000;
        clearTimeout(retryTimer);
        keepalive = setInterval(() => {
          if (current.readyState === WebSocket.OPEN)
            current.send(JSON.stringify({ type: "ping" }));
        }, 10000);
        await chrome.storage.local.set({ bridgeConnected: true });
        await announce();
      }
      if (m.type === "task") {
        const task = validateTask(m.task);
        if (processing) {
          for (const p of task.platforms)
            current.send(
              JSON.stringify({
                type: "result",
                id: task.id,
                platform: p,
                result: {
                  state: "needs_attention",
                  message: "工作台正在处理其他任务，请完成后重试",
                },
              }),
            );
          return;
        }
        runTask(task, { bridgeJob: true }).catch(console.error);
      }
      if (m.type === "open") await openDraft(m.id, m.platform);
      if (m.type === "error") {
        await chrome.storage.local.set({ bridgeError: m.message });
        await announce();
      }
    } catch (error) {
      console.error(error);
    }
  };
  socket.onclose = async () => {
    if (socket !== current) return;
    authenticated = false;
    clearInterval(keepalive);
    await chrome.storage.local.set({ bridgeConnected: false });
    if (socket !== current) return;
    await announce();
    if (socket !== current) return;
    scheduleRetry();
  };
  socket.onerror = () => {};
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("无法连接本地 AI 服务，请确认 serve 正在运行"));
      if (socket === current) current.close();
    }, 5000);
    current.addEventListener(
      "message",
      (e) => {
        try {
          if (JSON.parse(e.data).type === "hello") {
            clearTimeout(timer);
            resolve();
          }
        } catch {}
      },
      { once: true },
    );
    current.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        reject(new Error("AI连接被拒绝，请检查令牌或其他浏览器会话"));
      },
      { once: true },
    );
  });
}
async function resumePlatform(tabId, job, platform) {
  await waitTab(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/runner.js"],
  });
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "RUN_DRAFT",
    task: {
      ...forPlatform(job, platform),
      resume: job.results[platform].resume,
    },
    resumeOnly: true,
  });
  if (!response?.ok || !response.result?.resumed)
    throw new Error(
      response?.error ||
        response?.result?.message ||
        "未能恢复平台草稿，请在草稿箱中按标题查找",
    );
}
async function openDraft(id, platform) {
  const j = await get("jobs", id);
  const r = j?.results[platform];
  if (!r) throw new Error("未找到该平台的草稿");
  if (j.kind === "x_reply") {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("workbench.html"),
      active: true,
    });
    return;
  }
  if (r.tabId) {
    try {
      const tab = await chrome.tabs.get(r.tabId);
      if (new URL(tab.url).origin === new URL(PLATFORMS[platform].url).origin) {
        if (r.draftUrl && platform !== "xiaohongshu" && tab.url !== r.draftUrl)
          await chrome.tabs.update(r.tabId, { url: r.draftUrl });
        if (
          r.persisted &&
          (platform === "xiaohongshu" ||
            (platform === "x" && j.kind === "video"))
        )
          await resumePlatform(r.tabId, j, platform);
        await chrome.tabs.update(r.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
    } catch {}
  }
  if (!r.draftUrl && !r.editorUrl) throw new Error("尚无草稿或编辑入口");
  if (
    new URL(r.draftUrl || r.editorUrl).origin !==
    new URL(PLATFORMS[platform].url).origin
  )
    throw new Error("草稿链接与平台不符");
  const tab = await chrome.tabs.create({
    url: r.draftUrl || r.editorUrl,
    active: true,
  });
  r.tabId = tab.id;
  await save(j);
  if (platform === "xiaohongshu" || (platform === "x" && j.kind === "video")) {
    await resumePlatform(tab.id, j, platform);
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    if (
      ["ASSET", "CONTENT_STATUS", "CONTENT_HEARTBEAT"].includes(message.type)
    ) {
      const active = activeTabs.get(sender.tab?.id);
      if (
        !active ||
        active.id !== message.id ||
        sender.id !== chrome.runtime.id
      )
        throw new Error("页面无权读取此任务");
      const j = await get("jobs", message.id);
      if (message.type === "CONTENT_HEARTBEAT") return { ok: true };
      if (message.type === "CONTENT_STATUS") {
        if (
          message.platform !== active.platform ||
          !["uploading", "filling", "saving"].includes(message.patch?.state)
        )
          throw new Error("状态更新无效");
        await patch(j.id, active.platform, message.patch);
        return { ok: true };
      }
      const a = j.assets.find((a) => a.id === message.assetId);
      if (!a) throw new Error("素材不属于该任务");
      const index = message.index;
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= Math.max(1, Math.ceil(a.size / 1024 ** 2))
      )
        throw new Error("分片序号无效");
      if (j.bridgeJob) {
        const { bridgeConfig: c } =
          await chrome.storage.local.get("bridgeConfig");
        const response = await fetch(
          endpoint(c.url) + `/jobs/${j.id}/assets/${a.id}?chunk=${index}`,
          { headers: { Authorization: "Bearer " + c.token } },
        );
        const v = await response.json();
        if (!response.ok) throw new Error(v.error || "读取AI素材失败");
        return { ok: true, chunk: v.chunk };
      }
      return { ok: true, chunk: await fileChunk(a.id, index) };
    }
    if (!uiSender(sender)) throw new Error("请求仅允许来自扩展工作台");
    if (message.type === "DELETE_JOB") {
      const j = await get("jobs", message.id);
      if (!j) throw new Error("任务不存在");
      if ([...activeTabs.values()].some((item) => item.id === j.id))
        throw new Error("这条内容正在填入页面，完成后再删除");
      if (j.bridgeJob) {
        try {
          const { bridgeConfig: c } =
            await chrome.storage.local.get("bridgeConfig");
          if (c?.url && c?.token) {
            const response = await fetch(endpoint(c.url) + "/jobs/" + j.id, {
              method: "DELETE",
              headers: { Authorization: "Bearer " + c.token },
            });
            if (response.status === 409) {
              const v = await response.json().catch(() => ({}));
              throw new Error(v.error || "这条草稿正在交接，完成后再删除");
            }
          }
        } catch (e) {
          if (e.message?.includes("交接") || e.message?.includes("填入"))
            throw e;
        }
      }
      const used = new Set(
        (await all("jobs"))
          .filter((item) => item.id !== j.id)
          .flatMap((item) => (item.assets || []).map((a) => a.id)),
      );
      for (const a of j.assets || []) {
        if (!used.has(a.id)) await remove("assets", a.id);
      }
      await remove("jobs", j.id);
      await announce();
      return { ok: true };
    }
    if (message.type === "STATE" || message.type === "ENSURE_BRIDGE") {
      const saved = await loadBridgeConfig();
      if (message.type === "ENSURE_BRIDGE") await ensureConnected();
      else if (saved && !bridgeOpen()) ensureConnected().catch(() => {});
      return {
        ok: true,
        jobs: message.type === "STATE" ? await all("jobs") : undefined,
        bridge: { connected: bridgeOpen(), paired: Boolean(saved) },
      };
    }
    if (message.type === "FILL_CURRENT") {
      if (processing) throw new Error("已有任务在运行");
      processing = true;
      try {
        const j = await get("jobs", message.id);
        if (!j) throw new Error("任务不存在");
        const tab = await chrome.tabs.get(message.tabId);
        const platform = platformForUrl(tab.url);
        if (!platform) throw new Error("当前页不是支持的发布平台");
        ensurePlatform(j, platform);
        await save(j);
        assertTarget(j, tab);
        runPlatform(j, platform, tab).finally(() => {
          processing = false;
          announce();
        });
        return { ok: true };
      } catch (e) {
        processing = false;
        throw e;
      }
    }
    if (message.type === "RUN_PLATFORM") {
      if (processing) throw new Error("已有任务在运行");
      const j = await get("jobs", message.id);
      if (!j) throw new Error("任务不存在");
      ensurePlatform(j, message.platform);
      await save(j);
      if (isAssist(message.platform)) {
        await chrome.tabs.create({
          url: editorUrl(message.platform, j.kind),
          active: true,
        });
        return { ok: true };
      }
      processing = true;
      j.results[message.platform] = {
        state: "queued",
        message: "等待推送",
        updatedAt: new Date().toISOString(),
      };
      await save(j);
      runPlatform(j, message.platform).finally(() => {
        processing = false;
        announce();
      });
      return { ok: true };
    }
    if (message.type === "OPEN_PLATFORM") {
      if (!PLATFORMS[message.platform]) throw new Error("未知平台");
      const url = await platformEditorUrl(
        message.platform,
        message.kind === "article" ? "article" : "video",
        message.tabId,
      );
      if (message.tabId) {
        await chrome.tabs.update(message.tabId, { url, active: true });
        return { ok: true };
      }
      await chrome.tabs.create({ url, active: true });
      return { ok: true };
    }
    if (message.type === "OPEN_WORKBENCH") {
      await openWorkbench();
      return { ok: true };
    }
    if (message.type === "TARGET") {
      const tab = await chrome.tabs.get(message.tabId);
      return { ok: true, target: { id: tab.id, ...pageRole(tab.url) } };
    }
    if (message.type === "UI_ASSET") {
      const j = await get("jobs", message.id);
      const a = j?.assets.find((a) => a.id === message.assetId);
      if (
        !a ||
        !/^(image|video)\//.test(a.type || "") ||
        a.size > 32 * 1024 ** 2
      )
        throw new Error("预览只支持 32MB 以内、已保存在本机的图片或视频");
      if (j.bridgeJob) {
        const { bridgeConfig: c } =
          await chrome.storage.local.get("bridgeConfig");
        const chunks = [];
        for (let i = 0; i < Math.max(1, Math.ceil(a.size / 1024 ** 2)); i++) {
          const r = await fetch(
            endpoint(c.url) + `/jobs/${j.id}/assets/${a.id}?chunk=${i}`,
            { headers: { Authorization: "Bearer " + c.token } },
          );
          if (!r.ok)
            throw new Error("无法读取封面，请确认桥接服务运行且源文件未变化");
          chunks.push((await r.json()).chunk);
        }
        return { ok: true, chunks };
      }
      const chunks = [];
      for (let i = 0; i < Math.max(1, Math.ceil(a.size / 1024 ** 2)); i++)
        chunks.push(await fileChunk(a.id, i));
      return { ok: true, chunks };
    }
    if (message.type === "START") {
      if (processing) throw new Error("已有任务在运行");
      const task = validateTask(message.task);
      if (!task.prepared && task.kind === "article")
        throw new Error("文章缺少适配内容");
      runTask(task).catch(console.error);
      return { ok: true, id: task.id };
    }
    if (message.type === "RETRY") {
      if (processing) throw new Error("已有任务在运行");
      const j = await get("jobs", message.id);
      if (
        !j ||
        !j.platforms.includes(message.platform) ||
        !retryable(j.results[message.platform])
      )
        throw new Error("该平台无需重试");
      j.results[message.platform] = { state: "queued", message: "等待重试" };
      await save(j);
      runTask(j, {
        platforms: [message.platform],
        bridgeJob: j.bridgeJob,
      }).catch(console.error);
      return { ok: true };
    }
    if (message.type === "CONNECT") {
      const saved = await loadBridgeConfig();
      const token = String(message.token || "").trim() || saved?.token;
      const url = String(message.url || "").trim() || saved?.url;
      if (!token || !url)
        throw new Error(
          "还没有连接令牌。在终端运行一次 omnipost pair，把令牌粘贴到这里。保存后会自动连接，不用每次再配对。",
        );
      await connectSerialized({ url, token });
      return { ok: true };
    }
    if (message.type === "OPEN") {
      await openDraft(message.id, message.platform);
      return { ok: true };
    }
    throw new Error("未知操作");
  })()
    .then(reply)
    .catch((e) => reply({ ok: false, error: e.message }));
  return true;
});
async function openWorkbench() {
  const base = chrome.runtime.getURL("workbench.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url?.startsWith(base));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null)
      await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: base });
}
function openPanel(tab) {
  const path = "panel.html?tabId=" + tab.id;
  // open() 必须在这次点击里同步调用。先 await setOptions 会让浏览器丢掉点击，侧栏打不开。
  chrome.sidePanel
    .setOptions({ tabId: tab.id, path, enabled: true })
    .catch(console.error);
  return chrome.sidePanel.open({ tabId: tab.id }).catch(() =>
    chrome.tabs.create({
      url: chrome.runtime.getURL("workbench.html") + "?targetTab=" + tab.id,
    }),
  );
}
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab.url || surfaceFor(tab.url) !== "panel") return;
  if (info.status !== "complete" && !info.url) return;
  chrome.sidePanel
    .setOptions({
      tabId,
      path: "panel.html?tabId=" + tabId,
      enabled: true,
    })
    .catch(console.error);
});
chrome.action.onClicked.addListener((tab) => {
  if (surfaceFor(tab?.url) === "panel") return openPanel(tab);
  return openWorkbench().catch(console.error);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "bridge-reconnect" || bridgeOpen()) return;
  ensureConnected().catch(() => {});
});
chrome.alarms.create("bridge-reconnect", { periodInMinutes: 0.5 });
(async () => {
  for (const j of await all("jobs")) {
    let changed = false;
    for (const r of Object.values(j.results)) {
      if (!TERMINAL.has(r.state)) {
        r.state = "needs_attention";
        r.message = "扩展曾中断，请检查现有草稿后再重试";
        changed = true;
      }
    }
    if (changed) await save(j);
  }
  ensureConnected().catch(() => {});
})();
