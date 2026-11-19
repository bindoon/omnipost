import {
  PLATFORMS,
  assertPlatformCopy,
  canFillCurrent,
  shownMessage,
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
  const result = job.results?.[target.platform];
  if (!canFillCurrent(target.platform, result, job.kind))
    return result.message || "已有处理记录，请先检查页面";
  return "";
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
const preview = params.has("demo") && !globalThis.chrome?.runtime?.id;
function coverLabel(role) {
  return role === "cover-landscape"
    ? "横封面"
    : role === "cover-portrait"
      ? "竖封面"
      : "封面";
}
function replaceLabel() {
  return target?.platform === "youtube" ? "替换缩略图" : "用这张做封面";
}
function coverButtons(job) {
  const rank = { "cover-landscape": 0, cover: 1, "cover-portrait": 2 };
  return (job.assets || [])
    .filter((a) => a.role?.startsWith("cover"))
    .slice()
    .sort((a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9))
    .map((a) => {
      const label = coverLabel(a.role);
      return `<div class="flex min-w-0 flex-col gap-2"><div class="relative grid aspect-[16/10] place-items-center overflow-hidden rounded-xl bg-slate-950 text-[11px] text-slate-400" data-thumb-for="${esc(job.id)}" data-thumb-asset="${esc(a.id)}"></div><button type="button" class="h-10 rounded-lg bg-brand text-sm font-medium text-white hover:bg-brand-dark" data-replace-job="${esc(job.id)}" data-replace-id="${esc(a.id)}">${replaceLabel()}</button><p class="replace-status text-xs leading-5 text-orange-900" data-status-for="${esc(a.id)}"></p><a class="text-center text-xs text-slate-500 underline decoration-slate-300 underline-offset-2 aria-disabled:pointer-events-none aria-disabled:opacity-40" data-download-for="${esc(a.id)}" download="${esc(a.name || "cover.png")}" aria-disabled="true">下载${label}</a></div>`;
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
  return `<p class="published mt-1 text-xs font-semibold text-emerald-800">${when}已在这个平台记下发布${likeText}</p>`;
}
function noteHtml(job) {
  const result = job.results?.[target?.platform];
  const text = ["failed", "needs_attention"].includes(result?.state)
    ? shownMessage(result.message || "")
    : "";
  if (!text) return "";
  const info = result.state === "needs_attention";
  return `<p class="${info ? "bg-amber-50 text-amber-950" : "error bg-orange-50 text-orange-950"} mt-3 rounded-xl px-3 py-2.5 text-[13px] leading-6">${esc(text)}</p>`;
}
function reasonHtml(job, reason) {
  if (!reason) return "";
  const same = reason === (job.results?.[target?.platform]?.message || "");
  if (same && noteHtml(job)) return "";
  return `<p class="error mt-3 rounded-xl bg-orange-50 px-3 py-2.5 text-[13px] leading-6 text-orange-950">${esc(reason)}</p>`;
}
function fillButton(job) {
  return `<button type="button" class="mt-3 h-11 w-full rounded-xl bg-brand text-sm font-medium text-white hover:bg-brand-dark" data-fill="${esc(job.id)}">${job.schedule ? "填入素材和定时" : "填入这个页面"}</button>`;
}
function videoCard(job) {
  const reason = blockReason(job);
  const title = titleOf(job);
  const desc =
    (job.overrides?.[target.platform]?.description ?? job.description) || "";
  const covers = coverButtons(job);
  const pending = job.id === focusJobId;
  const coverCount = (job.assets || []).filter((a) =>
    a.role?.startsWith("cover"),
  ).length;
  const coverHint =
    target?.platform === "youtube"
      ? "点「替换缩略图」即可换上。左侧还在选择视频时，先点「填入这个页面」。"
      : "点「用这张做封面」放进当前封面框。";
  return `<article class="card${pending ? " pending" : ""} mt-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">${pending ? `<p class="mb-2 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">待提交</p>` : ""}<h2 class="text-lg font-semibold leading-snug tracking-tight text-slate-900">${esc(title)}</h2>${publishedLine(job)}${covers ? "" : `<div class="relative mt-3 grid aspect-video place-items-center overflow-hidden rounded-xl bg-slate-950 text-[11px] text-slate-400" data-thumb-for="${esc(job.id)}"></div>`}${desc ? `<p class="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-slate-600">${esc(desc)}</p>` : ""}<div class="mt-3 flex items-baseline gap-3 border-t border-slate-100 pt-3 text-sm"><span class="shrink-0 text-slate-500">短标题</span><b class="min-w-0 font-semibold text-slate-900">${esc(title)}</b></div>${noteHtml(job)}${reason ? reasonHtml(job, reason) : fillButton(job)}${covers ? `<div class="mt-4 grid items-start gap-3 ${coverCount > 1 ? "grid-cols-2" : "grid-cols-1"}">${covers}</div><p class="mt-3 text-xs leading-5 text-slate-500">${coverHint}</p>` : ""}</article>`;
}
function articleCard(job) {
  const reason = blockReason(job);
  return `<article class="card mt-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><h2 class="text-lg font-semibold leading-snug text-slate-900">${esc(titleOf(job))}</h2>${publishedLine(job)}<p class="mt-2 text-[13px] leading-6 text-slate-600">${esc((job.overrides?.wechat?.description ?? job.description) || "文章正文与配图")}</p>${noteHtml(job)}${reason ? reasonHtml(job, reason) : fillButton(job)}<p class="mt-3 text-xs leading-5 text-slate-500">填充失败时，可在完整工作台复制微信正文粘贴。</p></article>`;
}
function guideBar() {
  return `<div class="sticky top-0 z-10 -mx-4 -mt-4 mb-4 border-b border-slate-200/80 bg-[#f3f6f4]/95 px-4 py-3 backdrop-blur"><button type="button" class="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left shadow-sm" data-action="workbench"><span class="min-w-0"><span class="block text-sm font-semibold text-slate-900">打开完整工作台</span><small class="mt-0.5 block text-xs font-normal text-slate-500">管理内容、复制正文、删除草稿在那里进行</small></span><span aria-hidden="true" class="text-slate-400">→</span></button></div>`;
}
function pageError() {
  return error
    ? `<p class="error mt-3 rounded-xl bg-orange-50 px-3 py-2.5 text-[13px] leading-6 text-orange-950">${esc(error)}</p>`
    : "";
}
function render() {
  const name = target?.platform ? PLATFORMS[target.platform].name : "当前页";
  const article = target?.platform === "wechat";
  const kind = article ? "article" : "video";
  const items = jobs.filter((j) => j.kind === kind);
  const guide = guideBar();
  const heading = (text) =>
    `<header class="mb-1"><h1 class="text-base font-semibold text-slate-900">${text}</h1></header>`;
  if (!target || target.role === "other") {
    app.innerHTML = `${guide}${heading("Omnipost")}${pageError()}<p class="text-sm leading-6 text-slate-500">当前页不是支持的发布页。</p>`;
    return;
  }
  if (target.role !== "editor") {
    const youtube = target.platform === "youtube";
    app.innerHTML = `${guide}${heading(esc(name))}<p class="text-sm leading-6 text-slate-700">${article ? "请打开公众号的新文章编辑器。" : youtube ? "当前还在 YouTube 工作室，不是上传页。" : "当前还不是视频发布页。"}</p><p class="mt-1 text-sm leading-6 text-slate-500">${article ? "从草稿箱点击「新的创作 → 文章」，或点击下方按钮。登录后请再次前往文章编辑器。" : youtube ? "前往这个频道的上传页后，在这里选择一条视频填入。" : "打开发布页后，在这里选择一条视频填入。"}</p><div class="mt-4"><button type="button" class="h-11 w-full rounded-xl bg-brand text-sm font-medium text-white hover:bg-brand-dark" data-action="open-editor">${youtube ? "前往上传页" : "前往发布页"}</button></div>${pageError()}`;
    return;
  }
  app.innerHTML = `${guide}${heading(esc(name))}<p class="text-sm leading-6 text-slate-500">选择一${article ? "篇文章" : "条视频"}，填入这个页面。</p>${pageError()}${
    items.length
      ? items.map(article ? articleCard : videoCard).join("")
      : `<p class="mt-3 text-sm leading-6 text-slate-500">还没有${article ? "文章" : "视频"}。先在完整工作台导入，或让 AI 交接。</p>`
  }`;
  mountThumbs();
}
const thumbUrls = new Map();
let thumbToken = 0;
function paintDemoThumb(el) {
  const portrait = el.dataset.thumbAsset === "cover-tall";
  const label = portrait ? "竖封面" : "横封面";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#10221c"/><path d="M160 156C100 120 72 80 96 56C116 36 144 52 160 80C176 52 204 36 224 56C248 80 220 120 160 156Z" fill="none" stroke="#e7c56a" stroke-width="3"/><text x="20" y="32" fill="#f4efe2" font-size="16">${label}</text></svg>`;
  const img = document.createElement("img");
  img.alt = label;
  img.src = "data:image/svg+xml," + encodeURIComponent(svg);
  el.replaceChildren(img);
  const link = [
    ...(el.parentElement?.querySelectorAll("[data-download-for]") || []),
  ].find((node) => node.dataset.downloadFor === el.dataset.thumbAsset);
  if (link) {
    link.href = img.src;
    link.removeAttribute("aria-disabled");
  }
}
async function mountThumbs() {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
  const token = ++thumbToken;
  for (const el of document.querySelectorAll("[data-thumb-for]")) {
    if (preview) {
      paintDemoThumb(el);
      continue;
    }
    const job = jobs.find((j) => j.id === el.dataset.thumbFor);
    const cover = el.dataset.thumbAsset
      ? job?.assets?.find((a) => a.id === el.dataset.thumbAsset)
      : coverAsset(job);
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
      const link = [
        ...(el.parentElement?.querySelectorAll("[data-download-for]") || []),
      ].find((node) => node.dataset.downloadFor === cover.id);
      if (link) {
        link.href = url;
        link.removeAttribute("aria-disabled");
      }
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
  dialog.className =
    "w-[min(440px,calc(100vw-32px))] rounded-2xl border-0 bg-white p-4 shadow-2xl";
  dialog.innerHTML = `<img class="max-h-[70vh] w-full rounded-lg object-contain" src="${url}" alt="封面预览" draggable="true"><p class="mt-2 text-xs leading-5 text-slate-500" role="status"></p><menu class="mt-3 flex flex-wrap justify-end gap-2 p-0"><button type="button" class="h-10 rounded-lg bg-brand px-3 text-sm font-medium text-white" data-place>${replaceLabel()}</button><a class="inline-flex h-10 items-center rounded-lg border border-slate-200 px-3 text-sm text-slate-700" href="${url}" download="${esc(asset.name)}">下载</a><button type="button" class="h-10 rounded-lg border border-slate-200 px-3 text-sm" data-close>关闭</button></menu>`;
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
  if (status) {
    status.classList.remove("ok");
    status.textContent = "正在替换…";
  }
  try {
    await send("PLACE_COVER", { id: job.id, assetId: asset.id, tabId });
    if (!status) return;
    status.classList.add("ok");
    status.textContent =
      target?.platform === "youtube"
        ? "已替换。请看左侧缩略图是不是这张。"
        : "已放入当前封面框。请核对裁切后再点完成。";
  } catch (error) {
    if (status) status.textContent = error.message;
    else throw error;
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
function loadDemo() {
  jobs = [
    {
      id: "demo",
      kind: "video",
      title: "人体如河网",
      description:
        "经是大江，络是支流，孙络是溪沟。用三维动画和真实河图，理解《黄帝内经》的河网比喻与古人的取象智慧。人体的河流·第1期｜传统理论图解，画面与配音含AI辅助制作",
      platforms: ["youtube"],
      results: {
        youtube: {
          state: "needs_attention",
          message:
            "视频已交给 YouTube，页面会把它存成私享视频。请核对标题、说明、缩略图，并自行选择是否面向儿童和公开范围。插件不会点发布",
        },
      },
      assets: [
        {
          id: "cover-wide",
          role: "cover-landscape",
          name: "wide.png",
          type: "image/png",
        },
        {
          id: "cover-tall",
          role: "cover-portrait",
          name: "tall.png",
          type: "image/png",
        },
      ],
    },
  ];
  target = { id: 1, platform: "youtube", role: "editor" };
  error = "";
  render();
}
async function load() {
  if (preview) {
    loadDemo();
    return;
  }
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
    if (b.dataset.replaceId) {
      const job = jobs.find((j) => j.id === b.dataset.replaceJob);
      const asset = job?.assets.find((a) => a.id === b.dataset.replaceId);
      const status = b.parentElement?.querySelector(
        `[data-status-for="${b.dataset.replaceId}"]`,
      );
      if (job && asset) await putCover(job, asset, status);
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
chrome.tabs?.onActivated.addListener((info) => {
  tabId = info.tabId;
  load();
});
chrome.tabs?.onUpdated.addListener((id, info) => {
  if (id !== tabId) return;
  if (info.status === "complete" || info.url) load();
});
chrome.storage?.onChanged.addListener((changes) => {
  if (changes["publisher.lastUpdate"]) load();
});
load();
