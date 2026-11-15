import {
  PLATFORMS,
  validateTask,
  initialResults,
  retryable,
  TERMINAL,
  platformsFor,
  isAssist,
} from "./shared/model.js";
import { put, get } from "./shared/storage.js";
import { extractTitle, renderArticle, imagePaths } from "./shared/content.js";
const extension = Boolean(globalThis.chrome?.runtime?.id);
const app = document.querySelector("#app");
const urls = new Map();
let jobs = [],
  error = "",
  bridge = { connected: false };
let saveTimer;
const targetTabId = Number(
  new URLSearchParams(location.search).get("targetTab"),
);
let currentTarget;
function currentView() {
  if (!currentTarget?.platform) return "";
  const p = currentTarget.platform;
  const choices = jobs.filter(
    (j) => j.kind === "video" && j.platforms.includes(p),
  );
  return `<section class="panel" style="margin-bottom:24px" aria-label="当前页面填充"><div class="panel-body"><h2>填入刚才的${esc(PLATFORMS[p].name)}页面</h2><p>选择一份素材，上传视频并填入文案。原页面已有内容时停止。所有平台仅准备草稿，检查封面和内容后，由你亲自提交发布。</p>${
    choices.length
      ? choices
          .map(
            (j) =>
              `<div class="job-card"><strong>${esc(j.overrides?.[p]?.title || j.title)}</strong><p>${esc(j.results[p]?.message || "等待处理")}</p><button class="primary" data-fill-current="${esc(j.id)}" ${j.results[p]?.state !== "ready" ? "disabled" : ""}>填入原页面</button><div class="job-actions">${j.assets
                .filter((a) => a.role.startsWith("cover"))
                .map(
                  (a) =>
                    `<button class="quiet" data-cover-job="${esc(j.id)}" data-cover-id="${esc(a.id)}">查看 / 下载${a.role === "cover-landscape" ? "横屏" : a.role === "cover-portrait" ? "竖屏" : ""}封面</button>`,
                )
                .join("")}</div></div>`,
          )
          .join("")
      : "<p>还没有此平台的视频素材。请用 CLI 的 --stage 交接任务。</p>"
  }</div></section>`;
}
const seed = {
  screen: "library",
  libraryKind: "video",
  step: 1,
  kind: "article",
  title: "",
  markdown: "",
  description: "",
  platforms: ["wechat", "xiaohongshu", "x"],
  assets: [],
  overrides: {},
  previewPlatform: "wechat",
  tailorPlatform: "wechat",
  aiGenerated: false,
  jobId: null,
};
let state = { ...seed };
const icons = {
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  shield:
    '<path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7z"/><path d="m8 12 3 3 5-6"/>',
  spark:
    '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  link: '<path d="m10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 3 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
};
function icon(name) {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (icons[name] || icons.file) +
    "</svg>"
  );
}
function esc(s = "") {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function badge(id) {
  const p = PLATFORMS[id];
  return `<span class="platform-icon" style="background:${p.color}">${p.glyph}</span>`;
}
async function send(type, data = {}) {
  if (!extension)
    throw new Error("当前是界面预览。加载 Chrome 扩展后即可推送草稿。");
  const r = await chrome.runtime.sendMessage({ type, ...data });
  if (!r?.ok) throw new Error(r?.error || "扩展连接失败");
  return r;
}
function job() {
  return jobs.find((j) => j.id === state.jobId);
}
function hasSource() {
  return (
    state.title.trim() &&
    (state.kind === "article"
      ? state.markdown.trim()
      : state.assets.some((a) => a.role === "video"))
  );
}
function stageLabel(n) {
  return ["", "导入内容", "平台适配", "推送草稿", "继续编辑"][n];
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (extension) chrome.storage.local.set({ workbench: state });
    else localStorage.setItem("publisher-preview", JSON.stringify(state));
  }, 300);
}
function headerBar() {
  return `<header class="top"><div class="brand"><span class="brand-mark">O</span><span>Omnipost</span><span class="top-label">PUBLISH, THEN REFINE.</span></div><div class="top-actions">${!extension ? '<span class="preview-mode">界面预览</span>' : ""}<button class="quiet" data-action="library">内容列表</button><span class="connection"><i class="status-dot ${bridge.connected ? "online" : ""}"></i>${bridge.connected ? "AI 已连接" : "AI 未连接"}</span><button class="quiet" data-action="settings">${icon("spark")} 连接 AI</button></div></header>`;
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
function contentCard(j) {
  const ids = [
    ...j.platforms,
    ...platformsFor(j.kind).filter((id) => !j.platforms.includes(id)),
  ];
  const rows = ids
    .map((p) => {
      const included = j.platforms.includes(p);
      const r = included
        ? j.results?.[p] || { state: "queued", message: "等待推送" }
        : {
            state: "absent",
            message: isAssist(p)
              ? "打开发布页后，在侧栏选择这条内容"
              : "尚未写入草稿",
          };
      const done = r.state === "draft_ready";
      const attention = ["needs_attention", "failed"].includes(r.state);
      const busy = ["opening", "uploading", "filling", "saving"].includes(
        r.state,
      );
      const action = done
        ? `<button class="quiet" data-sync="open" data-job="${esc(j.id)}" data-platform="${p}">打开草稿</button>`
        : isAssist(p)
          ? `<button class="quiet" data-sync="goto" data-job="${esc(j.id)}" data-platform="${p}">打开发布页</button>`
          : busy
            ? ""
            : `<button class="primary" data-sync="run" data-job="${esc(j.id)}" data-platform="${p}">写入草稿</button>`;
      return `<div class="sync-row"><div><span class="job-platform">${badge(p)} ${esc(PLATFORMS[p].name)}</span><span class="pill ${done ? "success" : attention ? "warn" : ""}">${labels[r.state] || esc(r.state)}</span><p>${esc(r.message || "")}</p></div>${action}</div>`;
    })
    .join("");
  return `<article class="content-card"><div class="card-head"><h2>${esc(j.title)}</h2><button class="quiet danger" data-delete="${esc(j.id)}">删除</button></div><p class="saved">${j.createdAt ? new Date(j.createdAt).toLocaleString("zh-CN") : ""}</p><div class="draft-preview" data-preview-for="${esc(j.id)}"></div><div class="sync-row" style="border-top:0;padding-top:0"><div><p>视频打不开时这里显示封面，方便辨认。</p></div><button class="quiet" data-history="${esc(j.id)}">查看内容</button></div>${rows}</article>`;
}
function libraryMain() {
  const kind = state.libraryKind === "article" ? "article" : "video";
  const list = jobs.filter((j) => j.kind === kind);
  return `<main class="library"><div class="library-head"><div class="segmented" role="tablist" aria-label="内容类型"><button role="tab" data-library="video" aria-selected="${kind === "video"}" class="${kind === "video" ? "active" : ""}">视频</button><button role="tab" data-library="article" aria-selected="${kind === "article"}" class="${kind === "article" ? "active" : ""}">文章</button></div><button class="primary" data-action="compose">导入新内容</button></div>${
    list.length
      ? list.map(contentCard).join("")
      : `<p class="library-empty">${kind === "video" ? "还没有视频。" : "还没有文章。"}导入一份，或让 AI 交接到这里。每条内容下面是各平台的同步状态。</p>`
  }${repliesSection()}</main>`;
}
function render() {
  if (state.screen !== "compose") {
    app.innerHTML = headerBar() + libraryMain() + settingsView();
    mountPreviews();
    return;
  }
  app.innerHTML = headerBar() + `<main><section class="intro"><div><div class="eyebrow">YOUR CONTENT, EVERYWHERE</div><h1>写一份，在每个平台继续打磨。</h1><p>文章与视频统一导入，自动适配到草稿。最后一点表达，留在平台里完成。</p></div><span class="local-label">${icon("shield")} 素材保存在本地</span></section>${currentView()}<nav class="steps" aria-label="发布步骤">${[1, 2, 3, 4].map((n) => `<button class="step ${state.step === n ? "active" : state.step > n ? "done" : ""}" data-step="${n}" aria-current="${state.step === n ? "step" : "false"}"><span class="step-num">${state.step > n ? "✓" : String(n).padStart(2, "0")}</span><span><span class="step-title">${stageLabel(n)}</span><span class="step-desc">${["", "文章、图片或视频", "预览与轻量调整", "保存到各平台", "打开草稿继续编辑"][n]}</span></span></button>`).join("")}</nav><div id="error">${error ? `<div role="alert" class="error">${esc(error)}</div>` : ""}</div><div class="workspace"><section class="panel"><div class="panel-head"><span class="panel-title">${icon(state.step === 1 ? "file" : state.step === 4 ? "link" : "spark")}${["", "开始准备你的内容", "为每个平台，稍作调整", "把内容送到草稿箱", "草稿就绪，接着打磨"][state.step]}</span><span class="panel-note">STEP ${String(state.step).padStart(2, "0")} / 04</span></div><div class="panel-body">${[null, importView, tailorView, pushView, resultView][state.step]()}</div><footer class="panel-footer"><span class="saved">${state.step === 1 ? "修改自动保存在当前浏览器" : state.step === 2 ? "原文保留，每个平台单独调整" : state.step === 3 ? "仅生成草稿，不公开发布" : "表达的最后一步，留给你"}</span><div style="display:flex;gap:10px">${state.step > 1 ? '<button class="quiet" data-action="back">上一步</button>' : ""}${state.step < 3 ? `<button class="primary" data-action="next">${state.step === 1 ? "选择发布平台" : "准备推送草稿"} ${icon("arrow")}</button>` : state.step === 3 ? `<button class="primary" data-action="push" ${job() || !extension ? "disabled" : ""}>${job() ? "正在处理 / 已处理" : "推送到所选草稿"} ${icon("arrow")}</button>` : '<button class="primary" data-action="new">准备下一份内容 ＋</button>'}</div></footer></section><aside><section class="panel preview-panel"><div class="panel-head"><span class="panel-title">平台预览</span><span class="panel-note">呈现效果参考</span></div><div class="panel-body"><div class="preview-switches">${Object.keys(
    PLATFORMS,
  )
    .filter((p) => PLATFORMS[p].kinds.includes(state.kind))
    .map(
      (p) =>
        `<button class="${state.previewPlatform === p ? "active" : ""}" data-preview="${p}">${PLATFORMS[p].short}</button>`,
    )
    .join(
      "",
    )}</div><div class="phone"><div class="phone-bar"><span>‹</span><strong>${PLATFORMS[state.previewPlatform]?.name || "内容预览"}</strong><span>•••</span></div><div class="phone-content" id="platform-preview"></div></div><div class="preview-foot">最终样式以平台编辑器为准 · 原文始终保留</div></div></section><section class="ai-note"><h3>${icon("spark")} 也可以交给 AI</h3><p>Agent 通过本地 CLI 推送草稿，再把编辑入口交还给你。</p><code class="code">omnipost draft article.md<br>--platforms wechat,xiaohongshu,x</code></section></aside></div><div id="job-history">${historyView()}</div><p class="bottom-note">一份内容，几处草稿。打开平台，再做一点自己的调整。</p></main>${settingsView()}<input hidden id="files" type="file" accept=".md,.markdown,image/*,video/*" multiple><input hidden id="folder" type="file" webkitdirectory multiple>`;
  renderPreview();
  bindFiles();
}
function importView() {
  return `<div class="segmented" role="tablist"><button role="tab" aria-selected="${state.kind === "article"}" class="${state.kind === "article" ? "active" : ""}" data-kind="article">文章 / 图文</button><button role="tab" aria-selected="${state.kind === "video"}" class="${state.kind === "video" ? "active" : ""}" data-kind="video">视频</button></div><div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="导入文章与素材"><div class="drop-icon">${icon("upload")}</div><strong>${state.assets.length || state.markdown ? "继续添加内容与素材" : "把内容放在这里"}</strong><small>${state.kind === "article" ? "Markdown 文章与配图，或直接选择所在文件夹" : "视频、封面和文案，支持 MP4 / MOV，单文件最大 1GB"}</small><div class="drop-actions"><label class="file-label" for="files">选择文件</label>${state.kind === "article" ? '<label class="file-label" for="folder">选择文件夹</label>' : ""}</div></div><label class="field-label" for="title">标题 <small>${state.title.length} 字</small></label><input class="text-input" id="title" data-field="title" value="${esc(state.title)}" placeholder="给这份内容起个标题"><label class="field-label" for="body">${state.kind === "article" ? "正文" : "简介"} <small>${state.kind === "article" ? "MARKDOWN" : "视频说明 / 标签"}</small></label><textarea id="body" data-field="${state.kind === "article" ? "markdown" : "description"}" placeholder="${state.kind === "article" ? "在这里粘贴正文，也可以导入 Markdown 文件。" : "讲讲这段视频的内容。"}">${esc(state.kind === "article" ? state.markdown : state.description)}</textarea>${state.assets.length ? `<div class="field-label">已导入素材 <small>${state.assets.length} 个</small></div><div class="assets">${state.assets.map((a) => `<div class="asset-thumb" title="${esc(a.path || a.name)}">${urls.has(a.id) && a.type.startsWith("image/") ? `<img src="${urls.get(a.id)}" alt="${esc(a.name)}">` : icon("file")}<span>${esc(a.name)}</span></div>`).join("")}</div>` : ""}<p class="tip">${icon("shield")}<span><b>配图会随正文一起处理。</b> ${state.kind === "article" ? "选择文章所在文件夹，可以保留图片的相对路径。" : "视频文件保存在本地，按平台顺序上传。"}</span></p>`;
}
function tailorView() {
  const p = state.tailorPlatform;
  const o = state.overrides[p] || {};
  return `<div class="platform-grid">${Object.entries(PLATFORMS)
    .map(([id, c]) => {
      const supported = c.kinds.includes(state.kind);
      return `<label class="platform-card ${state.platforms.includes(id) ? "selected" : ""} ${supported ? "" : "disabled"}">${badge(id)}<input type="checkbox" data-platform="${id}" ${state.platforms.includes(id) ? "checked" : ""} ${supported ? "" : "disabled"}><strong>${c.name}</strong><small>${supported ? c.caption : "支持视频内容"}</small></label>`;
    })
    .join(
      "",
    )}</div><div class="tailor-tabs">${state.platforms.map((id) => `<button class="${id === p ? "active" : ""}" data-tailor="${id}">${PLATFORMS[id].short}</button>`).join("")}</div>${state.platforms.length ? `<label class="field-label" for="platform-title">${PLATFORMS[p].short}标题 <small>不修改其他平台</small></label><input class="text-input" id="platform-title" data-override="title" value="${esc(o.title ?? state.title)}"><label class="field-label" for="platform-desc">${state.kind === "article" ? "摘要 / 简介" : "视频简介"} <small>支持单独微调</small></label><textarea style="min-height:100px" id="platform-desc" data-override="description" placeholder="可选，填入适合这个平台的说明">${esc(o.description ?? state.description)}</textarea>` : ""}<label class="check-row"><input type="checkbox" id="aiGenerated" ${state.aiGenerated ? "checked" : ""}>内容包含 AI 生成部分（向支持的平台传递声明）</label><div class="info">接下来会上传到各平台草稿。你可以在平台里调整封面、文字、标签和排版，再自行发布。</div>`;
}
const labels = {
  absent: "未同步",
  ready: "素材已接收，待填充",
  queued: "等待推送",
  opening: "打开平台",
  uploading: "上传素材",
  filling: "填写内容",
  saving: "保存中",
  draft_ready: "草稿已保存",
  needs_attention: "需要处理",
  failed: "未完成",
};
function cards() {
  const j = job();
  const results = j?.results || initialResults({ platforms: state.platforms });
  return `<div class="job-list">${state.platforms
    .map((p) => {
      const r = results[p] || { state: "queued", message: "等待推送" };
      const done = r.state === "draft_ready";
      const attention = ["needs_attention", "failed"].includes(r.state);
      return `<section class="job-card"><div class="job-top"><span class="job-platform">${badge(p)} ${PLATFORMS[p].name}</span><span class="pill ${done ? "success" : attention ? "warn" : ""}">${labels[r.state] || r.state}</span></div><p class="job-message">${esc(r.message || "等待推送")}${r.evidence ? "<br>" + esc(r.evidence) : ""}${r.warnings?.length ? "<br>" + r.warnings.map(esc).join("<br>") : ""}</p>${j ? `<div class="job-actions">${r.tabId || r.draftUrl || r.editorUrl ? `<button class="quiet" data-open="${p}">${done ? "打开草稿，继续编辑" : "打开平台处理"} ↗</button>` : ""}${retryable(r) ? `<button class="quiet" data-retry="${p}">仅重试此平台</button>` : ""}</div>` : ""}</section>`;
    })
    .join("")}</div>`;
}
function pushView() {
  const j = job();
  const done = j
    ? Object.values(j.results).filter((r) => TERMINAL.has(r.state)).length
    : 0;
  return `<div class="info">${extension ? "准备好后，一次推送所选平台。每个平台单独保存，成功的草稿不会重复创建。" : "当前是界面预览。加载 Chrome 扩展后，即可推送真实草稿。"}</div><div class="progress-track"><div class="progress-fill" style="width:${state.platforms.length ? (done / state.platforms.length) * 100 : 0}%"></div></div><p class="saved" style="margin-bottom:20px">${j ? done + " / " + state.platforms.length + " 个平台已处理" : "尚未发起推送"}</p>${cards()}${j && done === state.platforms.length ? '<button class="primary" style="margin-top:22px" data-step="4">查看草稿与编辑入口 →</button>' : ""}`;
}
function resultView() {
  const count = Object.values(job()?.results || {}).filter(
    (r) => r.state === "draft_ready",
  ).length;
  return `<div class="completion"><div class="big-success">${count ? "✓" : "…"}</div><h2>${count ? count + " 份草稿，等待你的最后一点调整" : "还没有生成草稿"}</h2><p>${count ? "在各个平台里，保留最适合那里的表达。" : "完成前三步后，草稿的编辑入口会出现在这里。"}</p></div>${cards()}`;
}
function repliesSection() {
  const replies = jobs.filter((j) => j.kind === "x_reply");
  if (!replies.length) return "";
  return `<section class="history-list" aria-label="X 回复待审阅"><p class="saved">X 回复待审阅</p>${replies
    .map(
      (j) => `
        <details class="job-card">
          <summary>${esc(j.title)} · ${new Date(j.createdAt).toLocaleString("zh-CN")}</summary>
          <p class="job-message" style="white-space:pre-wrap">${esc(j.description)}</p>
          <div class="job-actions">
            <button class="quiet" data-copy-reply="${esc(j.id)}">复制回复</button>
            <a href="${esc(j.targetUrl)}" target="_blank" rel="noopener noreferrer">打开 X 原帖 ↗</a>
          </div>
          <p class="saved" role="status"></p>
        </details>`,
    )
    .join("")}</section>`;
}
function historyView() {
  const review = repliesSection();
  const list = jobs
    .filter((j) => j.kind !== "x_reply" && j.id !== state.jobId)
    .slice(0, 4);
  return (
    review +
    (list.length
      ? `<section class="history-list"><p class="saved">最近的草稿任务</p>${list.map((j) => `<div class="history-item"><span>${esc(j.title)} · ${new Date(j.createdAt).toLocaleString("zh-CN")}</span><button class="quiet" data-history="${j.id}">查看草稿 ↗</button></div>`).join("")}</section>`
      : "")
  );
}
function settingsView() {
  return `<dialog id="settings"><h2>把 AI 接到 Omnipost</h2><p>本地桥接服务接收 Agent 的任务。平台登录和草稿操作仍在你的 Chrome 中完成。</p><code class="code">omnipost serve<br>omnipost pair</code><label class="field-label" for="bridge-url">本地服务地址</label><input class="text-input" id="bridge-url" value="http://127.0.0.1:4318"><label class="field-label" for="bridge-token">连接令牌</label><input class="text-input" id="bridge-token" type="password" autocomplete="off" placeholder="粘贴 pair 命令返回的令牌"><p>令牌只保存在本机。连接后，AI 可以提交草稿任务、查看状态和打开编辑器。</p><div id="connect-error" class="error hidden"></div><footer><button class="quiet" data-action="close-settings">稍后连接</button><button class="primary" data-action="connect">连接本地 AI</button></footer></dialog>`;
}
function renderPreview() {
  const el = document.querySelector("#platform-preview");
  if (!el) return;
  const p = state.previewPlatform;
  const title = state.overrides[p]?.title ?? state.title;
  try {
    if (state.kind === "article" && state.markdown) {
      const out = renderArticle(state.markdown, state.assets);
      el.innerHTML = out[p] || out.wechat;
      for (let n = 0; n < out.media.length; n++) {
        const marker = [...el.querySelectorAll("span")].find(
          (e) => e.textContent === "【待插入配图 " + (n + 1) + "】",
        );
        if (marker) {
          const image = document.createElement("img");
          image.setAttribute("data-asset-id", out.media[n].id);
          image.alt = out.media[n].alt;
          marker.replaceWith(image);
        }
      }
      const h = el.querySelector('[data-md-h="1"]');
      if (h) h.textContent = title || extractTitle(state.markdown);
      else if (title) {
        const t = document.createElement("h1");
        t.textContent = title;
        el.prepend(t);
      }
      el.querySelectorAll("img[data-asset-id]").forEach((img) => {
        const url = urls.get(img.dataset.assetId);
        if (url) img.src = url;
        else img.remove();
      });
    } else if (state.kind === "video" && hasSource()) {
      el.replaceChildren();
      const video = state.assets.find((a) => a.role === "video");
      const cover = state.assets.find(
        (a) => a.role?.startsWith("cover") && urls.has(a.id),
      );
      if (video && urls.has(video.id)) {
        const player = document.createElement("video");
        player.src = urls.get(video.id);
        player.controls = true;
        player.muted = true;
        player.preload = "metadata";
        if (cover) player.poster = urls.get(cover.id);
        el.append(player);
      } else if (cover) {
        const img = document.createElement("img");
        img.src = urls.get(cover.id);
        el.append(img);
      } else if (video) {
        const note = document.createElement("p");
        note.textContent = previewMiss(video);
        el.append(note);
      }
      const h = document.createElement("h1");
      h.textContent = title;
      const desc = document.createElement("p");
      desc.textContent = state.overrides[p]?.description ?? state.description;
      el.append(h, desc);
    } else
      el.innerHTML =
        '<div class="preview-empty">' +
        icon("file") +
        "你的内容会出现在这里<br>先导入一篇文章或一段视频</div>";
  } catch (e) {
    el.innerHTML = '<div class="preview-empty">' + esc(e.message) + "</div>";
  }
}
function fail(e) {
  error = e.message || String(e);
  const el = document.querySelector("#error");
  if (el)
    el.innerHTML = '<div role="alert" class="error">' + esc(error) + "</div>";
}
async function chooseArticle(files) {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement("dialog");
    dialog.innerHTML =
      '<h2>选择要导入的文章</h2><p>文件夹中有多篇文章，请选择这次要推送的一篇。</p><form method="dialog"><select class="text-input" name="article">' +
      files
        .map(
          (f, i) =>
            '<option value="' +
            i +
            '">' +
            esc(f.webkitRelativePath || f.name) +
            "</option>",
        )
        .join("") +
      '</select><footer><button class="quiet" value="cancel">取消</button><button class="primary" value="choose">导入选中文章</button></footer></form>';
    document.body.append(dialog);
    dialog.addEventListener(
      "close",
      () => {
        const selected = files[Number(dialog.querySelector("select").value)];
        dialog.returnValue === "choose"
          ? resolve(selected)
          : reject(new Error("已取消导入"));
        dialog.remove();
      },
      { once: true },
    );
    dialog.showModal();
  });
}
async function importFiles(files) {
  error = "";
  try {
    const list = [...files];
    const articles = list.filter((f) => /\.m(arkdown|d)$/i.test(f.name));
    const md =
      articles.length > 1 ? await chooseArticle(articles) : articles[0];
    let root = "";
    if (md) {
      if (md.size > 2 * 1024 ** 2) throw new Error("文章文件超过2MB");
      state.assets = [];
      state.markdown = await md.text();
      state.title = extractTitle(state.markdown) || state.title;
      state.kind = "article";
      root = (md.webkitRelativePath || "").split("/").slice(0, -1).join("/");
    }
    if (!md && list.some((f) => f.type.startsWith("video/")))
      state.kind = "video";
    const wanted = md ? imagePaths(state.markdown) : null;
    for (const f of list.filter((f) =>
      md
        ? f.type.startsWith("image/") &&
          wanted.some((p) => p.split("/").pop() === f.name)
        : /^(image|video)\//.test(f.type),
    )) {
      if (f.size > 1024 ** 3) throw new Error(f.name + "超过1GB");
      const relative = f.webkitRelativePath || f.name;
      const path =
        root && relative.startsWith(root + "/")
          ? relative.slice(root.length + 1)
          : relative;
      const role = f.type.startsWith("video/")
        ? "video"
        : state.kind === "video"
          ? "cover"
          : "image";
      if (role === "video") {
        state.kind = "video";
        state.platforms = platformsFor("video");
      }
      const previous = state.assets.find((a) => a.path === path);
      const id = previous?.id || crypto.randomUUID();
      const a = { id, name: f.name, path, size: f.size, type: f.type, role };
      await put("assets", f, id);
      state.assets = state.assets.filter((a) => a.id !== id);
      if (role === "video")
        state.assets = state.assets.filter((a) => a.role !== "video");
      state.assets.push(a);
      if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
      urls.set(id, URL.createObjectURL(f));
    }
    if (md)
      state.platforms = state.platforms.filter((p) =>
        PLATFORMS[p].kinds.includes(state.kind),
      );
    if (!state.platforms.length)
      state.platforms = platformsFor(state.kind);
    state.previewPlatform = state.platforms[0];
    state.tailorPlatform = state.platforms[0];
    state.jobId = null;
    persist();
    render();
  } catch (e) {
    fail(e);
  }
}
function bindFiles() {
  document.querySelector("#files").onchange = (e) =>
    importFiles(e.target.files);
  document.querySelector("#folder").onchange = (e) =>
    importFiles(e.target.files);
  const drop = document.querySelector("#dropzone");
  if (drop) {
    drop.onclick = (e) => {
      if (!e.target.closest("label")) document.querySelector("#files").click();
    };
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add("drag");
    };
    drop.ondragleave = () => drop.classList.remove("drag");
    drop.ondrop = (e) => {
      e.preventDefault();
      importFiles(e.dataTransfer.files);
    };
    drop.onkeydown = (e) => {
      if (e.key === "Enter") document.querySelector("#files").click();
    };
  }
}
app.addEventListener("input", (e) => {
  if (e.target.dataset.field) {
    state[e.target.dataset.field] = e.target.value;
    state.jobId = null;
    persist();
    renderPreview();
  }
  if (e.target.dataset.override) {
    const id = state.tailorPlatform;
    state.overrides[id] ??= {};
    state.overrides[id][e.target.dataset.override] = e.target.value;
    state.jobId = null;
    persist();
    renderPreview();
  }
});
app.addEventListener("change", (e) => {
  const id = e.target.dataset.platform;
  if (id) {
    if (e.target.checked) state.platforms.push(id);
    else state.platforms = state.platforms.filter((p) => p !== id);
    state.platforms = [...new Set(state.platforms)];
    if (!state.platforms.includes(state.tailorPlatform))
      state.tailorPlatform = state.platforms[0];
    state.jobId = null;
    persist();
    render();
  }
  if (e.target.id === "aiGenerated") {
    state.aiGenerated = e.target.checked;
    persist();
  }
});
app.addEventListener("click", async (e) => {
  const b = e.target.closest("button,[data-kind]");
  if (!b) return;
  try {
    error = "";
    if (b.dataset.delete) {
      if (b.dataset.armed !== "1") {
        b.dataset.armed = "1";
        b.textContent = "确认删除";
        return;
      }
      await send("DELETE_JOB", { id: b.dataset.delete });
      if (state.jobId === b.dataset.delete) {
        state.jobId = null;
        state.screen = "library";
        persist();
      }
      await refresh();
      return;
    }
    if (b.dataset.library) {
      state.libraryKind = b.dataset.library;
      persist();
      render();
      return;
    }
    if (b.dataset.sync) {
      const id = b.dataset.job;
      const platform = b.dataset.platform;
      if (b.dataset.sync === "goto") {
        const item = jobs.find((j) => j.id === id);
        await send("OPEN_PLATFORM", {
          platform,
          kind: item?.kind || "video",
        });
      }
      else if (b.dataset.sync === "open")
        await send("OPEN", { id, platform });
      else await send("RUN_PLATFORM", { id, platform });
      await refresh();
      return;
    }
    if (b.dataset.fillCurrent) {
      await send("FILL_CURRENT", {
        id: b.dataset.fillCurrent,
        tabId: targetTabId,
      });
      await refresh();
      return;
    }
    if (b.dataset.coverId) {
      const j = jobs.find((j) => j.id === b.dataset.coverJob);
      const a = j.assets.find((a) => a.id === b.dataset.coverId);
      const r = await send("UI_ASSET", { id: j.id, assetId: a.id });
      const blob = new Blob(
        r.chunks.map((chunk) =>
          Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0)),
        ),
        { type: a.type },
      );
      const url = URL.createObjectURL(blob);
      const dialog = document.createElement("dialog");
      dialog.innerHTML = `<img src="${url}" alt="封面预览" style="max-width:70vw;max-height:70vh;display:block"><a href="${url}" download="${esc(a.name)}">下载封面</a> <button>关闭</button>`;
      document.body.append(dialog);
      dialog.querySelector("button").onclick = () => dialog.close();
      dialog.addEventListener(
        "close",
        () => {
          URL.revokeObjectURL(url);
          dialog.remove();
        },
        { once: true },
      );
      dialog.showModal();
      return;
    }
    if (b.dataset.copyReply) {
      const reply = jobs.find(
        (j) => j.kind === "x_reply" && j.id === b.dataset.copyReply,
      );
      if (!reply) throw new Error("回复任务不存在");
      await navigator.clipboard.writeText(reply.description);
      b.closest("details").querySelector('[role="status"]').textContent =
        "已复制。请在 X 核对账号与原帖后发布。";
      return;
    }
    if (b.dataset.step) {
      const n = +b.dataset.step;
      if (n > 1 && !hasSource()) throw new Error("先导入内容或填写标题与正文");
      state.step = n;
      persist();
      render();
      window.scrollTo(0, 0);
      return;
    }
    if (b.dataset.preview) {
      state.previewPlatform = b.dataset.preview;
      render();
      return;
    }
    if (b.dataset.tailor) {
      state.tailorPlatform = b.dataset.tailor;
      state.previewPlatform = b.dataset.tailor;
      render();
      return;
    }
    if (b.dataset.kind) {
      state.kind = b.dataset.kind;
      state.platforms = platformsFor(state.kind);
      state.previewPlatform = state.tailorPlatform = state.platforms[0];
      state.jobId = null;
      persist();
      render();
      return;
    }
    if (b.dataset.open) {
      await send("OPEN", { id: state.jobId, platform: b.dataset.open });
      return;
    }
    if (b.dataset.retry) {
      await send("RETRY", { id: state.jobId, platform: b.dataset.retry });
      await refresh();
      return;
    }
    if (b.dataset.history) {
      const j = jobs.find((j) => j.id === b.dataset.history);
      state = {
        ...seed,
        ...j,
        screen: "compose",
        libraryKind: j.kind === "article" ? "article" : "video",
        jobId: j.id,
        step: 2,
      };
      await hydrate();
      render();
      return;
    }
    switch (b.dataset.action) {
      case "library":
        state.screen = "library";
        persist();
        render();
        break;
      case "compose":
        state = {
          ...seed,
          screen: "compose",
          libraryKind: state.libraryKind,
          step: 1,
          assets: [],
          overrides: {},
          jobId: null,
        };
        persist();
        render();
        window.scrollTo(0, 0);
        break;
      case "next":
        if (!hasSource()) throw new Error("先导入内容或填写标题与正文");
        if (state.kind === "article")
          renderArticle(state.markdown, state.assets);
        if (!state.platforms.length) throw new Error("请选择平台");
        if (state.step === 2) validateTask({ ...state, mode: "draft" });
        state.step++;
        persist();
        render();
        window.scrollTo(0, 0);
        break;
      case "back":
        state.step = Math.max(1, state.step - 1);
        persist();
        render();
        window.scrollTo(0, 0);
        break;
      case "push": {
        const task = validateTask({
          ...state,
          id: crypto.randomUUID(),
          mode: "draft",
          prepared:
            state.kind === "article"
              ? renderArticle(state.markdown, state.assets)
              : undefined,
        });
        const r = await send("START", { task });
        state.jobId = r.id;
        persist();
        await refresh();
        break;
      }
      case "new":
        state = {
          ...seed,
          screen: "compose",
          libraryKind: state.libraryKind,
          assets: [],
          overrides: {},
          step: 1,
        };
        error = "";
        persist();
        render();
        break;
      case "settings":
        document.querySelector("#settings").showModal();
        break;
      case "close-settings":
        document.querySelector("#settings").close();
        break;
      case "connect": {
        const url = document.querySelector("#bridge-url").value;
        const token = document.querySelector("#bridge-token").value;
        await send("CONNECT", { url, token });
        document.querySelector("#settings").close();
        await refresh();
        break;
      }
    }
  } catch (e) {
    if (b.dataset.action === "connect") {
      const el = document.querySelector("#connect-error");
      el.classList.remove("hidden");
      el.textContent = e.message;
    } else fail(e);
  }
});
function previewMiss(asset) {
  if (asset.size > 32 * 1024 ** 2)
    return "视频超过 32MB，列表里不内嵌播放。填充发布页时仍使用原文件。";
  return "浏览器里没有这份视频。它在本地桥接的源文件中；桥接服务运行且文件未改动时，刷新后可以预览。";
}
async function blobFromChunks(chunks, type) {
  return new Blob(
    chunks.map((chunk) => Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0))),
    { type },
  );
}
async function mediaUrl(job, asset) {
  if (!asset || urls.has(asset.id)) return urls.get(asset.id) || "";
  const local = await get("assets", asset.id);
  if (local) {
    const url = URL.createObjectURL(local);
    urls.set(asset.id, url);
    return url;
  }
  if (!extension || !job?.bridgeJob || asset.size > 32 * 1024 ** 2) return "";
  const r = await send("UI_ASSET", { id: job.id, assetId: asset.id });
  const url = URL.createObjectURL(await blobFromChunks(r.chunks, asset.type));
  urls.set(asset.id, url);
  return url;
}
let previewToken = 0;
async function mountPreviews() {
  if (!extension) return;
  const token = ++previewToken;
  for (const el of document.querySelectorAll("[data-preview-for]")) {
    if (token !== previewToken) return;
    const job = jobs.find((j) => j.id === el.dataset.previewFor);
    const video = job?.assets?.find((a) => a.role === "video");
    const cover = coverAsset(job);
    el.replaceChildren();
    if (!video && !cover) continue;
    let coverUrl = "";
    let videoUrl = "";
    let videoError = "";
    if (cover) {
      try {
        coverUrl = await mediaUrl(job, cover);
      } catch {}
    }
    if (token !== previewToken) return;
    if (video) {
      try {
        videoUrl = await mediaUrl(job, video);
      } catch (e) {
        videoError = e.message;
      }
    }
    if (token !== previewToken) return;
    if (videoUrl) {
      const player = document.createElement("video");
      player.controls = true;
      player.preload = "metadata";
      player.src = videoUrl;
      if (coverUrl) player.poster = coverUrl;
      el.append(player);
    } else if (coverUrl) {
      const img = document.createElement("img");
      img.src = coverUrl;
      img.alt = cover.name || "封面";
      el.append(img);
      if (video) {
        const note = document.createElement("p");
        note.textContent = videoError || previewMiss(video);
        el.append(note);
      }
    } else if (video) {
      const note = document.createElement("p");
      note.textContent = videoError || previewMiss(video);
      el.append(note);
    }
  }
}
async function hydrate() {
  const job =
    jobs.find((j) => j.id === state.jobId) ||
    (state.bridgeJob ? state : null);
  for (const a of state.assets) {
    if (urls.has(a.id)) continue;
    try {
      await mediaUrl(job, a);
    } catch {}
  }
}
async function refresh() {
  if (!extension) return;
  try {
    const r = await send("STATE");
    if (targetTabId && !currentTarget)
      currentTarget = (await send("TARGET", { tabId: targetTabId })).target;
    const previousJobIds = jobs.map((j) => j.id).join("\n");
    jobs = r.jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    bridge = r.bridge;
    const previousStep = state.step;
    if (
      state.jobId &&
      state.step === 3 &&
      job() &&
      Object.values(job().results).every((r) => TERMINAL.has(r.state))
    )
      state.step = 4;
    if (
      state.screen !== "compose" ||
      currentTarget ||
      [3, 4].includes(state.step) ||
      previousStep !== state.step
    )
      render();
    else {
      if (previousJobIds !== jobs.map((j) => j.id).join("\n")) {
        app.querySelector("#job-history").innerHTML = historyView();
      }
      const label = app.querySelector(".connection");
      if (label)
        label.innerHTML =
          '<i class="status-dot ' +
          (bridge.connected ? "online" : "") +
          '"></i>' +
          (bridge.connected ? "AI 已连接" : "AI 未连接");
    }
  } catch (e) {
    fail(e);
  }
}
async function init() {
  try {
    const saved = extension
      ? (await chrome.storage.local.get("workbench")).workbench
      : JSON.parse(localStorage.getItem("publisher-preview") || "null");
    if (saved) {
      state = { ...seed, ...saved };
      if (saved.screen == null && saved.step) state.screen = "compose";
    }
    await hydrate();
  } catch {}
  if (new URLSearchParams(location.search).has("demo")) {
    state = {
      ...seed,
      title: "一座城市，从代码到画面",
      markdown:
        "# 一座城市，从代码到画面\n\n把城市的建筑与水系放进 Three.js，再让镜头沿着时间轴移动。一份代码，慢慢长成一段视频。\n\n![城市画面](sample.svg)\n\n*示例配图 · 用代码描绘城市*\n\n## 从十几秒的样片开始\n\n先确定画面与节奏，再把故事讲完整。导入原文后，你可以在不同平台继续调整。",
      assets: [
        {
          id: "sample",
          name: "sample.svg",
          path: "sample.svg",
          type: "image/svg+xml",
          size: 0,
          role: "image",
        },
      ],
      overrides: {},
      step: 1,
    };
    urls.set("sample", new URL("sample.svg", location.href).href);
  }
  render();
  await refresh();
  if (extension) {
    chrome.storage.onChanged.addListener((c) => {
      if (c["publisher.lastUpdate"]) refresh();
    });
  }
}
init();
