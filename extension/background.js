import {
  PLATFORMS,
  validateTask,
  initialResults,
  validateResult,
  forPlatform,
  retryable,
  scheduleNeedsReview,
  scheduleWindowIssue,
  protectScheduleResult,
  TERMINAL,
  isAssist,
  ensurePlatform,
  safeUrl,
} from "./shared/model.js";
import {
  NATIVE_SCHEDULE_CAPABILITY,
  PLATFORM_SCHEDULE_CAPABILITIES,
} from "./shared/platforms/index.js";
import { matchPublished } from "./shared/published.js";
import {
  VIDEO_REPLACEMENT_CAPABILITY,
  replacementAsset,
  replacementPlatform,
  replacementTarget,
} from "./shared/video-replacement.js";
import {
  platformForUrl,
  assertTarget,
  surfaceFor,
  editorUrl,
  pageRole,
  worksUrl,
  youtubeChannel,
} from "./shared/target.js";
import { put, get, all, remove, fileChunk } from "./shared/storage.js";
let socket,
  keepalive,
  processing = false,
  checking = false,
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
async function waitTab(tabId, editorPlatform) {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      if (!editorPlatform) return { tab };
      if (tab.url && tab.url !== "about:blank" && !tab.pendingUrl) {
        const page = pageRole(tab.url);
        if (page.platform !== editorPlatform || page.role !== "editor")
          throw new Error(
            "当前页面不是" + PLATFORMS[editorPlatform].name + "的新建投稿页",
          );
        const frame = await chrome.webNavigation.getFrame({
          tabId,
          frameId: 0,
        });
        if (frame?.errorOccurred) throw new Error("平台投稿页加载失败");
        if (frame?.documentId && frame.url === tab.url)
          return { tab, documentId: frame.documentId };
      }
    }
    await sleep(300);
  }
  throw new Error("平台页面加载超时");
}
function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + "超时(" + ms / 1000 + "s)")), ms),
    ),
  ]);
}
// 视频号的发布表单挂在 micro/content/post/create 的子 iframe 里；
// 上传控件可能挂在别的 frame：优先找含 video accept 的 file input，
// 其次找带表单特征（描述/短标题）的 frame，再退回表单 iframe。
async function editorFrameId(tabId, platform) {
  if (platform === "tiktok") return { frameId: 0 };
  // channels：runner 在主 frame 运行，经同源 contentDocument 访问
  // post-card / micro iframe 完成引导与填表（runner.channelsAllDocs）。
  if (platform !== "channels") return undefined;
  return { frameId: 0, diag: "main-frame routing" };
}
async function platformEditorUrl(platform, kind, tabId) {
  if (platform === "youtube") {
    const tabs = tabId
      ? [await chrome.tabs.get(tabId)]
      : await chrome.tabs.query({});
    const context = tabs.find((tab) => platformForUrl(tab.url) === "youtube");
    return editorUrl(platform, kind, context?.url);
  }
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
    if (task.schedule) {
      const issue = scheduleWindowIssue(platform, task.schedule.at);
      if (issue) throw new Error(issue);
    }
    await patch(task.id, platform, {
      state: "opening",
      message: "打开" + config.name,
    });
    const url =
      targetTab?.url || (await platformEditorUrl(platform, task.kind));
    // 防御：历史运行会遗留发布页标签页，堆积后拖慢甚至阻塞开页。
    // 新任务开始前清掉同平台的遗留编辑页。
    if (!targetTab) {
      const stale = await chrome.tabs
        .query({ url: new URL(url).origin + "/*" })
        .catch(() => []);
      const staleIds = stale
        .filter((t) => t.id && t.url?.includes("/platform"))
        .map((t) => t.id);
      if (staleIds.length)
        await chrome.tabs.remove(staleIds).catch(() => {});
    }
    // Both native date selectors and image previews use animation frames.
    // Keep the one active scheduling tab visible until the platform responds.
    tab =
      targetTab ||
      (await withTimeout(
        chrome.tabs.create({ url, active: Boolean(task.schedule) }),
        30000,
        "打开平台标签页",
      ));
    if (targetTab) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    activeTabs.set(tab.id, { id: task.id, platform });
    await patch(task.id, platform, {
      tabId: tab.id,
      editorUrl: platform === "douyin" ? url : tab.url || url,
    });
    const requiresEditorDocument =
      platform === "douyin" || platform === "xiaohongshu";
    const ready = await waitTab(
      tab.id,
      requiresEditorDocument ? platform : undefined,
    );
    tab = ready.tab;
    await withTimeout(
      chrome.scripting.executeScript({
        target: ready.documentId
          ? { tabId: tab.id, documentIds: [ready.documentId] }
          : { tabId: tab.id, allFrames: true },
        files: ["content/runner.js"],
      }),
      20000,
      "注入内容脚本",
    );
    const target = await editorFrameId(tab.id, platform);
    if (target?.diag)
      await patch(task.id, platform, {
        message: "定位表单 frame：" + target.diag.slice(0, 200),
      });
    // Pin both operations to the same document. A navigation after injection
    // must fail this send, rather than delivering it to the next editor.
    const messageTarget = ready.documentId
      ? { documentId: ready.documentId }
      : {};
    if (target?.frameId !== undefined) messageTarget.frameId = target.frameId;
    const response = await chrome.tabs.sendMessage(
      tab.id,
      {
        type: "RUN_DRAFT",
        task: { ...forPlatform(task, platform), fillOnly: Boolean(targetTab) },
      },
      messageTarget,
    );
    if (!response?.ok)
      throw new Error(response?.error || "平台适配器未返回结果");
    const current = await get("jobs", task.id);
    const result = validateResult(
      protectScheduleResult(current?.results[platform], response.result),
    );
    await patch(task.id, platform, { ...result, tabId: tab.id });
  } catch (error) {
    const current = await get("jobs", task.id);
    const uncertain = current?.results[platform]?.state === "submitting";
    await patch(task.id, platform, {
      state: uncertain ? "schedule_unconfirmed" : "failed",
      message: uncertain
        ? "定时提交结果不明，请先核对平台作品列表"
        : error.message,
      tabId: tab?.id,
      editorUrl: current?.results[platform]?.editorUrl || tab?.url,
    });
  } finally {
    if (tab) activeTabs.delete(tab.id);
    if (task.schedule?.submit && tab && !targetTab) {
      const current = await get("jobs", task.id);
      if (current?.results[platform]?.state === "scheduled")
        await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}
async function setBadge(text) {
  if (!chrome.action?.setBadgeText) return;
  await chrome.action.setBadgeBackgroundColor?.({ color: "#008a69" });
  await chrome.action.setBadgeText({ text });
}
function notify(title, message) {
  if (!chrome.notifications?.create || !chrome.runtime?.getURL) return;
  const created = chrome.notifications.create("omnipost-done", {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message,
  });
  created?.catch?.(() => {});
}
async function runTask(
  task,
  { bridgeJob = false, platforms = task.platforms } = {},
) {
  if (processing) throw new Error("另一个任务正在执行，请稍后再试");
  processing = true;
  try {
    let existing = await get("jobs", task.id);
    if (existing && existing.kind !== task.kind)
      throw new Error("任务 ID 冲突");
    // 重新推送的桥接任务素材 ID 会变化，必须用新任务内容刷新本地缓存，
    // 只保留各平台已有的结果状态。
    const job = {
      ...validateTask(task),
      bridgeJob,
      results: existing?.results || initialResults(task),
    };
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
    let step = 0;
    const runsDirectly = (platform) =>
      !isAssist(platform) ||
      (job.schedule && PLATFORMS[platform].schedule?.openEditor);
    const directTotal = platforms.filter(runsDirectly).length;
    for (const p of platforms) {
      const current = await get("jobs", task.id);
      const existingResult = current.results[p];
      if (
        existingResult?.state === "draft_ready" ||
        scheduleNeedsReview(existingResult)
      ) {
        if (existingResult.state === "submitting") {
          const uncertain = protectScheduleResult(
            existingResult,
            existingResult,
          );
          await patch(current.id, p, uncertain);
        } else if (bridgeJob) {
          await bridgePatch(current, p, existingResult);
        }
        continue;
      }
      if (!runsDirectly(p)) {
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
      step += 1;
      await setBadge(step + "/" + directTotal);
      await runPlatform(current, p);
    }
    await setBadge("");
    if (step)
      notify(
        "Omnipost",
        task.schedule
          ? "定时任务已处理，请核对各平台回执。"
          : "填写已结束。请逐个页面检查，再自行发布。",
      );
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
let bridgeRetry = null;
function retryBridge() {
  bridgeRetry ||= ensureConnected().finally(() => {
    bridgeRetry = null;
  });
  return bridgeRetry;
}
async function bridgeAssetChunk(config, jobId, assetId, index) {
  const url =
    endpoint(config.url) + `/jobs/${jobId}/assets/${assetId}?chunk=${index}`;
  const run = () =>
    fetch(url, { headers: { Authorization: "Bearer " + config.token } });
  try {
    return await run();
  } catch {
    await retryBridge();
    return run();
  }
}
async function replaceVideoInTab(id, tabId, url, expected) {
  if (processing) throw new Error("已有任务在运行");
  processing = true;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
    const target = replacementTarget(tab.url);
    if (
      !target || url !== tab.url ||
      (expected && (expected.platform !== target.platform || expected.workId !== target.workId))
    )
      throw new Error("请在已核对的原预约编辑页使用换源");
    const job = await get("jobs", id);
    const { platform } = target;
    const asset = replacementAsset(job, platform);
    if (!asset || (expected && expected.at !== job.schedule.at))
      throw new Error("请交接一条同平台、同定时时间的替换视频");
    if (job.bridgeJob && !(await loadBridgeConfig()))
      throw new Error("请先连接本机桥接读取替换视频");
    activeTabs.set(tab.id, { id: job.id, platform, replacementAsset: asset.id });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/replacement.js"],
    });
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "UPLOAD_REPLACEMENT_VIDEO",
      task: {
        id: job.id,
        url: tab.url,
        platform,
        title: job.overrides?.[platform]?.title ?? job.title,
        at: job.schedule.at,
        asset,
      },
    });
    if (!result?.ok) throw new Error(result?.error || "原稿未接收替换视频");
    return { ok: true };
  } finally {
    if (tab) activeTabs.delete(tab.id);
    processing = false;
  }
}
async function replaceOpenVideo(request) {
  const tabs = (await chrome.tabs.query({})).filter((tab) => {
    const target = replacementTarget(tab.url);
    return target?.platform === request.platform && target.workId === request.workId;
  });
  if (tabs.length !== 1) {
    throw new Error(tabs.length ? "同一原稿打开了多个标签页" : "未打开指定作品的原预约编辑页");
  }
  return replaceVideoInTab(request.id, tabs[0].id, tabs[0].url, request);
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
        capabilities: [
          "manual-stage",
          "build-20261120-5",
          VIDEO_REPLACEMENT_CAPABILITY,
          NATIVE_SCHEDULE_CAPABILITY,
          ...PLATFORM_SCHEDULE_CAPABILITIES,
        ],
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
        let task;
        try {
          task = validateTask(m.task);
        } catch (error) {
          for (const p of m.task?.platforms || [])
            current.send(
              JSON.stringify({
                type: "result",
                id: m.task?.id,
                platform: p,
                result: {
                  state: "failed",
                  persisted: false,
                  message: "任务校验失败：" + error.message,
                },
              }),
            );
          return;
        }
        if (processing) {
          for (const p of task.platforms)
            current.send(
              JSON.stringify({
                type: "result",
                id: task.id,
                platform: p,
                result: {
                  state: "needs_attention",
                  persisted: false,
                  message: "工作台正在处理其他任务，请完成后重试",
                },
              }),
            );
          return;
        }
        runTask(task, { bridgeJob: true }).catch(async (error) => {
          console.error(error);
          for (const p of task.platforms)
            current.send(
              JSON.stringify({
                type: "result",
                id: task.id,
                platform: p,
                result: {
                  state: "failed",
                  persisted: false,
                  message:
                    "扩展执行中断：" +
                    (error?.message || String(error)).slice(0, 200),
                },
              }),
            );
        });
      }
      if (m.type === "open") await openDraft(m.id, m.platform);
      if (m.type === "replace-video") {
        let result;
        try {
          result = await replaceOpenVideo(m);
        } catch (error) {
          result = { ok: false, error: error.message };
        }
        if (current.readyState === WebSocket.OPEN)
          current.send(JSON.stringify({
            type: "replace-video-result",
            requestId: m.requestId,
            result,
          }));
      }
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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function readWorksMessage(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/published.js"],
  });
  return chrome.tabs.sendMessage(tabId, { type: "READ_WORKS" });
}
async function readPlatformWorks(platform) {
  const tabs = await chrome.tabs.query({});
  const context = tabs.find((tab) => youtubeChannel(tab.url));
  const url = worksUrl(platform, context?.url || "");
  if (!url) throw new Error("这个平台还不能核对已发布列表");
  const [current] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitTab(tab.id);
    await sleep(1200);
    let page = await readWorksMessage(tab.id);
    const origin = new URL(url).origin;
    let sameOrigin = false;
    try {
      sameOrigin = Boolean(
        page?.nextUrl && new URL(page.nextUrl).origin === origin,
      );
    } catch {}
    if (sameOrigin) {
      await chrome.tabs.update(tab.id, { url: page.nextUrl, active: true });
      await waitTab(tab.id);
      await sleep(1200);
      page = await readWorksMessage(tab.id);
    }
    if (!page?.items?.length && !page?.loggedOut) {
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(1500);
      page = await readWorksMessage(tab.id);
    }
    return page;
  } finally {
    if (current?.id)
      chrome.tabs.update(current.id, { active: true }).catch(() => {});
    chrome.tabs.remove(tab.id).catch(() => {});
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
        sender.id !== chrome.runtime.id ||
        (active.replacementAsset &&
          (message.type !== "ASSET" || message.assetId !== active.replacementAsset))
      )
        throw new Error("页面无权读取此任务");
      const j = await get("jobs", message.id);
      if (message.type === "CONTENT_HEARTBEAT") return { ok: true };
      if (message.type === "CONTENT_STATUS") {
        if (
          message.platform !== active.platform ||
          !["uploading", "filling", "saving", "submitting"].includes(
            message.patch?.state,
          )
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
    if (message.type === "MARK_PUBLISHED") {
      const j = await get("jobs", message.id);
      if (!j) throw new Error("任务不存在");
      const config = PLATFORMS[message.platform];
      if (!config?.kinds.includes(j.kind))
        throw new Error("这个平台不能记录这条内容");
      const published = { ...(j.published || {}) };
      if (message.published === true)
        published[message.platform] = new Date().toISOString();
      else {
        delete published[message.platform];
        if (j.checks) delete j.checks[message.platform];
      }
      j.published = published;
      await save(j);
      return { ok: true };
    }
    if (message.type === "CHECK_PUBLISHED") {
      if (processing) throw new Error("正在填入页面，完成后再核对");
      if (checking) throw new Error("正在核对另一条内容");
      const origin = await get("jobs", message.id);
      if (!origin) throw new Error("任务不存在");
      const platform = message.platform;
      if (!PLATFORMS[platform]?.kinds.includes(origin.kind))
        throw new Error("这个平台不能核对这条内容");
      checking = true;
      try {
        const page = await readPlatformWorks(platform);
        if (!page?.ok) throw new Error(page?.error || "没有读到作品列表");
        if (page.loggedOut) {
          origin.checks = {
            ...(origin.checks || {}),
            [platform]: {
              found: false,
              reason: "需要先登录",
              checkedAt: new Date().toISOString(),
            },
          };
          await save(origin);
          return {
            ok: true,
            found: false,
            reason: "需要先登录" + PLATFORMS[platform].name,
          };
        }
        const entries = (await all("jobs"))
          .filter((job) => PLATFORMS[platform].kinds.includes(job.kind))
          .map((job) => ({
            id: job.id,
            title: job.overrides?.[platform]?.title ?? job.title,
          }));
        const matched = matchPublished(entries, page.items || []);
        const checkedAt = new Date().toISOString();
        for (const [id, result] of Object.entries(matched)) {
          if (!result.found) continue;
          const job = await get("jobs", id);
          if (!job) continue;
          job.published = {
            ...(job.published || {}),
            [platform]: job.published?.[platform] || checkedAt,
          };
          job.checks = {
            ...(job.checks || {}),
            [platform]: {
              found: true,
              likes: Number.isFinite(result.likes) ? result.likes : null,
              href: safeUrl(result.href),
              title: result.title,
              checkedAt,
            },
          };
          await save(job);
        }
        const mine = matched[origin.id] || {
          found: false,
          reason: page.note || "列表里没有同名标题",
        };
        if (!mine.found) {
          origin.checks = {
            ...(origin.checks || {}),
            [platform]: {
              found: false,
              reason: mine.reason,
              checkedAt,
              seen: page.items?.length || 0,
            },
          };
          await save(origin);
        }
        return {
          ok: true,
          found: Boolean(mine.found),
          likes: mine.likes ?? null,
          reason: mine.reason || "",
          seen: page.items?.length || 0,
        };
      } finally {
        checking = false;
      }
    }
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
    if (message.type === "VIDEO_FINGERPRINTS") {
      const config = await loadBridgeConfig();
      if (!config) return { ok: true, fingerprints: [] };
      const response = await fetch(
        endpoint(config.url) + "/video-fingerprints",
        {
          headers: { Authorization: "Bearer " + config.token },
        },
      );
      if (!response.ok) throw new Error("桥接未返回视频指纹");
      const { fingerprints } = await response.json();
      return { ok: true, fingerprints };
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
      const existing = j.results[message.platform];
      if (existing?.state === "draft_ready" || scheduleNeedsReview(existing))
        throw new Error("该平台已有处理记录，请先检查原页面，避免重复上传");
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
      let tabId = message.tabId;
      if (message.tabId) {
        await chrome.tabs.update(message.tabId, { url, active: true });
      } else {
        const tab = await chrome.tabs.create({ url, active: true });
        tabId = tab.id;
      }
      if (message.jobId && chrome.storage.session?.set)
        await chrome.storage.session.set({
          ["panelFocus." + tabId]: {
            jobId: message.jobId,
            platform: message.platform,
          },
        });
      const path =
        "panel.html?tabId=" +
        tabId +
        (message.jobId ? "&focus=" + encodeURIComponent(message.jobId) : "");
      chrome.sidePanel
        .setOptions({ tabId, path, enabled: true })
        .catch(() => {});
      try {
        await chrome.sidePanel.open({ tabId });
      } catch {}
      return { ok: true, tabId };
    }
    if (message.type === "OPEN_WORKBENCH") {
      await openWorkbench();
      return { ok: true };
    }
    if (message.type === "TARGET") {
      const tab = await chrome.tabs.get(message.tabId);
      return {
        ok: true,
        target: {
          id: tab.id,
          ...pageRole(tab.url),
          ...(replacementPlatform(tab.url) ? { replacement: true } : {}),
        },
      };
    }
    if (message.type === "REPLACE_VIDEO") {
      return replaceVideoInTab(message.id, message.tabId, message.url);
    }
    if (message.type === "PLACE_COVER" || message.type === "ARM_COVER") {
      if (processing) throw new Error("正在填入页面，完成后再放入封面");
      const j = await get("jobs", message.id);
      const a = j?.assets?.find((item) => item.id === message.assetId);
      if (
        !a ||
        !String(a.role || "").startsWith("cover") ||
        !/^image\//.test(a.type || "")
      )
        throw new Error("这不是可放入的封面");
      if (a.size > 32 * 1024 ** 2)
        throw new Error("封面超过 32MB，请下载后拖入");
      const tab = await chrome.tabs.get(message.tabId);
      if (!platformForUrl(tab.url)) throw new Error("当前页不是支持的发布页");
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/runner.js"],
      });
      const count = Math.max(1, Math.ceil(a.size / 1024 ** 2));
      const chunks = [];
      if (j.bridgeJob) {
        const { bridgeConfig: c } =
          await chrome.storage.local.get("bridgeConfig");
        for (let i = 0; i < count; i++) {
          const response = await fetch(
            endpoint(c.url) + `/jobs/${j.id}/assets/${a.id}?chunk=${i}`,
            { headers: { Authorization: "Bearer " + c.token } },
          );
          if (!response.ok) throw new Error("无法读取封面");
          chunks.push((await response.json()).chunk);
        }
      } else {
        for (let i = 0; i < count; i++) chunks.push(await fileChunk(a.id, i));
      }
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, {
          type: message.type,
          name: a.name,
          mime: a.type,
          chunks,
        });
      } catch {
        throw new Error("当前页还不能放入封面，请刷新发布页后再试");
      }
      if (!response?.ok) throw new Error(response?.error || "没能放入封面");
      return { ok: true };
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
        if (!c?.url || !c?.token)
          throw new Error(
            "还没有连接令牌。运行一次 omnipost pair，把令牌粘贴到「连接 AI」。之后只要 omnipost serve 在运行就会自动连上。",
          );
        const chunks = [];
        for (let i = 0; i < Math.max(1, Math.ceil(a.size / 1024 ** 2)); i++) {
          let r;
          try {
            r = await bridgeAssetChunk(c, j.id, a.id, i);
          } catch {
            throw new Error(
              "视频已经在插件里。预览要读取交给插件时的源文件，请在项目目录运行 omnipost serve。令牌已保存，不用再配对。",
            );
          }
          if (!r.ok)
            throw new Error(
              a.type?.startsWith("video/")
                ? "读不到这条视频的源文件。请确认 omnipost serve 在运行，且原视频没有被改动或移走。"
                : "无法读取封面，请确认桥接服务运行且源文件未变化",
            );
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
function armPanel(tab) {
  if (!tab?.id || !tab.url || surfaceFor(tab.url) !== "panel") return;
  chrome.sidePanel
    .setOptions({
      tabId: tab.id,
      path: "panel.html?tabId=" + tab.id,
      enabled: true,
    })
    .catch(() => {});
}
function openPanel(tab) {
  const path = "panel.html?tabId=" + tab.id;
  // open() 必须是这次点击里的第一个侧栏调用。先 setOptions 会在新版 Chrome 里吃掉点击，侧栏打不开，只能落到工作台。
  const opened = chrome.sidePanel.open({ tabId: tab.id });
  chrome.sidePanel
    .setOptions({ tabId: tab.id, path, enabled: true })
    .catch(console.error);
  return opened.catch(() =>
    chrome.tabs.create({
      url: chrome.runtime.getURL("workbench.html") + "?targetTab=" + tab.id,
    }),
  );
}
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab.url || surfaceFor(tab.url) !== "panel") return;
  if (info.status !== "complete" && !info.url) return;
  armPanel({ id: tabId, url: tab.url });
});
chrome.tabs.onActivated.addListener((info) => {
  chrome.tabs
    .get(info.tabId)
    .then(armPanel)
    .catch(() => {});
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
        const uncertain = r.state === "submitting";
        r.state = uncertain ? "schedule_unconfirmed" : "needs_attention";
        r.message = uncertain
          ? "定时提交结果不明，请先核对作品管理"
          : "扩展曾中断，请先检查原页面；如需重新填充，请打开空白发布页后重试";
        changed = true;
      }
    }
    if (changed) await save(j);
  }
  ensureConnected().catch(() => {});
})();
