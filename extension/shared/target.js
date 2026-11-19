import { PLATFORMS, canFillCurrent } from "./model.js";
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
export function editorUrl(platform, kind = "video", contextUrl = "") {
  if (platform === "wechat") {
    const url = new URL("https://mp.weixin.qq.com/cgi-bin/appmsg");
    let token = "";
    try {
      const context = new URL(contextUrl);
      if (context.origin === url.origin)
        token = context.searchParams.get("token") || "";
    } catch {}
    url.search = new URLSearchParams(
      token
        ? {
            t: "media/appmsg_edit_v2",
            action: "edit",
            isNew: "1",
            type: "10",
            token,
            lang: "zh_CN",
            timestamp: String(Date.now()),
          }
        : {
            begin: "0",
            count: "10",
            type: "77",
            action: "list_card",
            lang: "zh_CN",
          },
    );
    return url.href;
  }
  if (platform === "x" && kind === "video") return "https://x.com/compose/post";
  if (platform === "youtube") {
    const channel = youtubeChannel(contextUrl);
    if (channel)
      return (
        "https://studio.youtube.com/channel/" + channel + "/videos/upload?d=ud"
      );
    return "https://www.youtube.com/upload";
  }
  return PLATFORMS[platform].url;
}
export function youtubeChannel(value) {
  try {
    const url = new URL(value || "");
    if (url.origin !== "https://studio.youtube.com") return "";
    return url.pathname.match(/\/channel\/(UC[^/]+)/)?.[1] || "";
  } catch {
    return "";
  }
}
export function worksUrl(platform, contextUrl = "") {
  if (platform === "youtube") {
    const channel = youtubeChannel(contextUrl);
    return channel
      ? "https://studio.youtube.com/channel/" + channel + "/videos"
      : "https://studio.youtube.com/";
  }
  return PLATFORMS[platform]?.worksUrl || "";
}
export function pageRole(value) {
  const platform = platformForUrl(value);
  if (!platform) return { role: "other", platform: null, url: value || "" };
  let editor = false;
  try {
    const url = new URL(value);
    editor =
      platform === "wechat"
        ? url.pathname === "/cgi-bin/appmsg" &&
          url.searchParams.get("t") === "media/appmsg_edit_v2" &&
          url.searchParams.get("action") === "edit" &&
          url.searchParams.get("type") === "10" &&
          url.searchParams.get("isNew") === "1" &&
          !url.searchParams.has("appmsgid")
        : (PLATFORMS[platform].editorPaths || []).some((re) =>
            re.test(url.pathname),
          );
  } catch {}
  return { role: editor ? "editor" : "site", platform, url: value };
}
export function surfaceFor(value) {
  const page = pageRole(value);
  if (!page.platform) return "workbench";
  return "panel";
}
export function assertTarget(job, tab) {
  const platform = platformForUrl(tab?.url);
  if (!platform || !job.platforms.includes(platform))
    throw new Error("当前页不属于该任务的目标平台");
  if (
    !PLATFORMS[platform].kinds.includes(job.kind) ||
    (job.kind === "article" && platform !== "wechat")
  )
    throw new Error("当前页不支持此内容类型");
  const result = job.results[platform];
  if (!canFillCurrent(platform, result, job.kind))
    throw new Error("该平台已有处理记录，请先检查原页面，避免重复上传");
  if (pageRole(tab.url).role !== "editor")
    throw new Error(
      platform === "wechat"
        ? "请在公众号草稿箱点击「新的创作 → 文章」，再点击插件"
        : "请先打开平台的新视频发布页，再点击插件",
    );
  return platform;
}
