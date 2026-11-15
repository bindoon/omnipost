import { PLATFORMS } from "./model.js";
const EDITORS = {
  channels: [/^\/platform\/post\/create\/?$/],
  xiaohongshu: [/^\/publish\/publish\/?$/],
  x: [/^\/compose\/(post|tweet)\/?$/],
  douyin: [
    /^\/creator-micro\/content\/upload\/?$/,
    /^\/creator-micro\/content\/post\/video\/?$/,
    /^\/creator-micro\/content\/publish\/?$/,
    /^\/content\/upload\/?$/,
  ],
};
export function platformForUrl(value) {
  try {
    const url = new URL(value);
    return Object.keys(PLATFORMS).find(
      (p) => new URL(PLATFORMS[p].url).origin === url.origin,
    );
  } catch {
    return undefined;
  }
}
export function editorUrl(platform, kind = "video") {
  if (platform === "x" && kind === "video") return "https://x.com/compose/post";
  return PLATFORMS[platform].url;
}
export function pageRole(value) {
  const platform = platformForUrl(value);
  if (!platform) return { role: "other", platform: null, url: value || "" };
  let editor = false;
  try {
    const url = new URL(value);
    editor = (EDITORS[platform] || []).some((re) => re.test(url.pathname));
  } catch {}
  return { role: editor ? "editor" : "site", platform, url: value };
}
export function surfaceFor(value) {
  const page = pageRole(value);
  if (!page.platform || !PLATFORMS[page.platform].kinds.includes("video"))
    return "workbench";
  return "panel";
}
export function assertTarget(job, tab) {
  const platform = platformForUrl(tab?.url);
  if (!platform || !job.platforms.includes(platform))
    throw new Error("当前页不属于该任务的目标平台");
  if (job.kind !== "video") throw new Error("当前页填充目前支持视频任务");
  const state = job.results[platform]?.state;
  const retryable =
    state === "ready" ||
    state === "queued" ||
    state === "failed" ||
    (state === "needs_attention" && PLATFORMS[platform].automation === "assist");
  if (!retryable)
    throw new Error("该平台已有处理记录，请先检查原页面，避免重复上传");
  const url = new URL(tab.url);
  if (!(EDITORS[platform] || []).some((re) => re.test(url.pathname)))
    throw new Error("请先打开平台的新视频发布页，再点击插件");
  return platform;
}
