import {
  PLATFORMS,
  assertPlatformCopy,
  canFillCurrent,
} from "./shared/model.js";

const app = document.querySelector("#app");
const params = new URLSearchParams(location.search);
let tabId = Number(params.get("tabId"));
let jobs = [];
let target = null;
let error = "";
let focusJobId = "";

function esc(s = "") {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
async function send(type, data = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...data });
  if (!r?.ok) throw new Error(r?.error || "扩展连接失败");
  return r;
}
function titleOf(job) {
  return job.overrides?.[target?.platform]?.title ?? job.title;
}
function blockReason(job) {
  if (!target?.platform) return "当前页还不能填充";
  const title = titleOf(job);
  const description =
    job.overrides?.[target.platform]?.description ?? job.description ?? "";
  try {
    assertPlatformCopy(
      job.kind,
      target.platform,
      title,
      description,
      job.overrides?.[target.platform]?.tags || "",
      "请在工作台调整",
    );
  } catch (error) {
    return error.message;
  }
  const state = job.results?.[target.platform]?.state;
  if (!canFillCurrent(target.platform, state, job.kind))
    return job.results[target.platform].message || "已有处理记录，请先检查页面";
  return "";
}
function failureNote(job) {
  const result = job.results?.[target?.platform];
  return ["failed", "needs_attention"].includes(result?.state)
    ? result.message || ""
    : "";
}
function coverAsset(job) {
  const covers = (job?.assets || []).filter((a) => a.role?.startsWith("cover"));
  return (
    covers.find((a) => a.role === "cover-portrait") ||
    covers.find((a) => a.role === "cover") ||
    covers[0] ||
    null
  );
}
function coverButtons(job) {
  return job.assets
    .filter((a) => a.role?.startsWith("cover"))
    .map((a) => {
      const label =
        a.role === "cover-landscape"
          ? "横封面"
          : a.role === "cover-portrait"
            ? "竖封面"
            : "封面";
      return `<button class="quiet" data-cover-job="${esc(job.id)}" data-cover-id="${esc(a.id)}">查看${label}</button>`;
    })
    .join("");
}
function publishedLine(job) {
  const at = job.published?.[target?.platform];
  if (typeof at !== "string") return "";
  const d = new Date(at);
  const when = Number.isNaN(d.getTime())
    ? ""
    : d.getMonth() + 1 + "/" + d.getDate() + " ";
  const likes = job.checks?.[target.platform]?.likes;
  const likeText = Number.isFinite(likes) ? " · " + likes + " 赞" : "";
  return `<p class="published">${when}已在这个平台记下发布${likeText}</p>`;
}
function videoCard(job) {
  const reason = blockReason(job);
  const note = failureNote(job);
  const title = titleOf(job);
  const desc =
    (job.overrides?.[target.platform]?.description ?? job.description) || "";
  const covers = coverButtons(job);
  const pending = job.id === focusJobId;
  return `<article class="card${pending ? " pending" : ""}">${pending ? `<p class="pending-flag">待提交</p>` : ""}<h2>${esc(title)}</h2>${publishedLine(job)}<div class="thumb" data-thumb-for="${esc(job.id)}"></div><p>${esc(desc.slice(0, 80))}</p><div class="row"><span>短标题</span><b>${esc(title)}</b></div>${note ? `<p class="error">${esc(note)}</p>` : ""}${reason ? `<p class="error">${esc(reason)}</p>` : `<button class="go" data-fill="${esc(job.id)}">填入这个页面</button>`}${covers ? `<div class="covers">${covers}</div><p class="drag-hint">按住封面向左拖。松手后写入光标下的上传框，不必先下载。</p>` : ""}</article>`;
}
function articleCard(job) {
  const reason = blockReason(job);
  const note = failureNote(job);
  return `<article class="card"><h2>${esc(titleOf(job))}</h2>${publishedLine(job)}<p>${esc((job.overrides?.wechat?.description ?? job.description) || "文章正文与配图")}</p>${note ? `<p class="error">${esc(note)}</p>` : ""}${reason ? `<p class="error">${esc(reason)}</p>` : `<button class="go" data-fill="${esc(job.id)}">填入这个页面</button>`}<p class="note">填充失败时，可在完整工作台复制微信正文粘贴。</p></article>`;
}
function guideBar() {
  return `<div class="topbar"><button class="guide" data-action="workbench"><span>打开完整工作台</span><small>管理内容、复制正文、删除草稿在那里进行</small></button></div>`;
}
function render() {
  const name = target?.platform ? PLATFORMS[target.platform].name : "当前页";
  const article = target?.platform === "wechat";
  const kind = article ? "article" : "video";
  const items = jobs.filter((j) => j.kind === kind);
  const guide = guideBar();
  if (!target || target.role === "other") {
    app.innerHTML = `${guide}<header><h1>Omnipost</h1></header><p class="empty">当前页不是支持的发布页。</p>`;
    return;
  }
  if (target.role !== "editor") {
    const youtube = target.platform === "youtube";
    app.innerHTML = `${guide}<header><h1>${esc(name)}</h1></header><p class="where">${article ? "请打开公众号的新文章编辑器。" : youtube ? "当前还在 YouTube 工作室，不是上传页。" : "当前还不是视频发布页。"}</p><p class="note">${article ? "从草稿箱点击「新的创作 → 文章」，或点击下方按钮。登录后请再次前往文章编辑器。" : youtube ? "前往这个频道的上传页后，在这里选择一条视频填入。" : "打开发布页后，在这里选择一条视频填入。"}</p><div class="page-action"><button class="go" data-action="open-editor">${youtube ? "前往上传页" : "前往发布页"}</button></div>${error ? `<p class="error">${esc(error)}</p>` : ""}`;
    return;
  }
  app.innerHTML = `${guide}<header><h1>${esc(name)}</h1></header><p class="where">选择一${article ? "篇文章" : "条视频"}，填入这个页面。</p>${error ? `<p class="error">${esc(error)}</p>` : ""}${
    items.length
      ? items.map(article ? articleCard : videoCard).join("")
      : `<p class="empty">还没有${article ? "文章" : "视频"}。先在完整工作台导入，或让 AI 交接。</p>`
  }`;
  mountThumbs();
}
const thumbUrls = new Map();
let thumbToken = 0;
async function mountThumbs() {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
  const token = ++thumbToken;
  for (const el of document.querySelectorAll("[data-thumb-for]")) {
    const job = jobs.find((j) => j.id === el.dataset.thumbFor);
    const cover = coverAsset(job);
    if (!cover) {
      el.textContent = "这条没有封面";
      continue;
    }
    try {
      const r = await send("UI_ASSET", { id: job.id, assetId: cover.id });
      if (token !== thumbToken) return;
      const url = URL.createObjectURL(
        new Blob(
          r.chunks.map((chunk) =>
            Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0)),
          ),
          { type: cover.type || "image/png" },
        ),
      );
      thumbUrls.set(cover.id, url);
      const img = document.createElement("img");
      img.src = url;
      img.alt = cover.name || "封面";
      img.draggable = true;
      img.addEventListener("dragstart", (event) =>
        startCoverDrag(event, job, cover, r.chunks),
      );
      el.replaceChildren(img);
    } catch {
      if (token !== thumbToken) return;
      el.textContent = "封面暂时打不开";
    }
  }
}
async function showCover(jobId, assetId) {
  const job = jobs.find((j) => j.id === jobId);
  const asset = job?.assets.find((a) => a.id === assetId);
  if (!asset) return;
  const r = await send("UI_ASSET", { id: job.id, assetId: asset.id });
  const blob = new Blob(
    r.chunks.map((chunk) =>
      Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0)),
    ),
    { type: asset.type },
  );
  const url = URL.createObjectURL(blob);
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<img src="${url}" alt="封面预览" draggable="true"><p class="drag-hint">按住封面向左拖到上传区。网页只接收文件，松手时会把这张图交给当前页。放不进去再点「写入上传框」。</p><p role="status"></p><menu><button type="button" data-place>写入上传框</button><a href="${url}" download="${esc(asset.name)}">下载</a><button type="button" data-close>关闭</button></menu>`;
  document.body.append(dialog);
  const status = dialog.querySelector("[role=status]");
  const image = dialog.querySelector("img");
  image.addEventListener("dragstart", (event) =>
    startCoverDrag(event, job, asset, r.chunks),
  );
  dialog.querySelector("[data-place]").onclick = () =>
    putCover(job, asset, status);
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  dialog.addEventListener(
    "close",
    () => {
      URL.revokeObjectURL(url);
      dialog.remove();
    },
    { once: true },
  );
  try {
    dialog.showModal?.();
  } catch {}
}
function startCoverDrag(event, job, asset, chunks) {
  const dt = event.dataTransfer;
  if (!dt) return;
  const type = asset.type || "image/png";
  const name = asset.name || "cover.png";
  const binary = chunks.map((chunk) =>
    Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0)),
  );
  const file = new File(binary, name, { type });
  dt.effectAllowed = "copy";
  try {
    dt.items.add(file);
  } catch {}
  const blobUrl = event.currentTarget?.src || "";
  try {
    dt.setData("DownloadURL", type + ":" + name + ":" + blobUrl);
  } catch {}
  if (file.size > 0 && file.size <= 1536 * 1024) {
    try {
      dt.setData("text/plain", chunks.join(""));
    } catch {}
  }
  send("ARM_COVER", { id: job.id, assetId: asset.id, tabId }).catch(() => {});
}
async function putCover(job, asset, status) {
  status.textContent = "正在放入左侧封面框…";
  try {
    await send("PLACE_COVER", { id: job.id, assetId: asset.id, tabId });
    status.textContent =
      "已放入当前封面页。请核对裁切后再点完成。横竖封面需要各自打开后再放一次。";
  } catch (error) {
    status.textContent = error.message;
  }
}
let loadToken = 0;
async function followActiveTab() {
  if (!chrome.tabs?.query) return;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) tabId = tab.id;
  } catch {}
}
async function readFocus() {
  const urlTab = Number(params.get("tabId"));
  const urlFocus = params.get("focus") || "";
  if (chrome.storage?.session?.get && tabId) {
    try {
      const key = "panelFocus." + tabId;
      const stored = await chrome.storage.session.get(key);
      if (stored?.[key]?.jobId) return stored[key].jobId;
    } catch {}
  }
  if (urlFocus && (!urlTab || urlTab === tabId)) return urlFocus;
  return "";
}
async function load() {
  const token = ++loadToken;
  try {
    await followActiveTab();
    focusJobId = await readFocus();
    const state = await send("STATE");
    const nextTarget = tabId ? (await send("TARGET", { tabId })).target : null;
    if (token !== loadToken) return;
    jobs = (state.jobs || []).slice().sort((a, b) => {
      const pinned = (b.id === focusJobId) - (a.id === focusJobId);
      if (pinned) return pinned;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
    target = nextTarget;
    error = "";
  } catch (e) {
    if (token !== loadToken) return;
    error = e.message;
  }
  render();
}
app.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    error = "";
    if (b.dataset.action === "workbench") {
      await send("OPEN_WORKBENCH");
      return;
    }
    if (b.dataset.action === "open-editor") {
      await send("OPEN_PLATFORM", {
        platform: target.platform,
        kind: target.platform === "wechat" ? "article" : "video",
        tabId,
      });
      return;
    }
    if (b.dataset.coverId) {
      await showCover(b.dataset.coverJob, b.dataset.coverId);
      return;
    }
    if (b.dataset.fill) {
      b.disabled = true;
      await send("FILL_CURRENT", { id: b.dataset.fill, tabId });
      await load();
    }
  } catch (err) {
    error = err.message;
    render();
  }
});
chrome.tabs.onActivated.addListener((info) => {
  tabId = info.tabId;
  load();
});
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id !== tabId) return;
  if (info.status === "complete" || info.url) load();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes["publisher.lastUpdate"]) load();
});
load();
