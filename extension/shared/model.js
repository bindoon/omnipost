export const PLATFORMS = {
  wechat: {
    name: "微信公众号",
    short: "公众号",
    glyph: "微",
    color: "#07a86c",
    kinds: ["article"],
    url: "https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card&lang=zh_CN",
    caption: "图文草稿 · 保留正文排版",
    automation: "direct",
  },
  xiaohongshu: {
    name: "小红书",
    short: "小红书",
    glyph: "红",
    color: "#f43f5e",
    kinds: ["article", "video"],
    url: "https://creator.xiaohongshu.com/publish/publish?source=official",
    caption: "长文 / 视频 · 平台内微调",
    automation: "direct",
  },
  x: {
    name: "X",
    short: "X",
    glyph: "𝕏",
    color: "#151b2a",
    kinds: ["article", "video"],
    url: "https://x.com/compose/articles",
    caption: "Articles / 视频 · 原生格式",
    automation: "direct",
  },
  channels: {
    name: "微信视频号",
    short: "视频号",
    glyph: "视",
    color: "#ee9b28",
    kinds: ["video"],
    url: "https://channels.weixin.qq.com/platform/post/create",
    caption: "视频 · 在发布页填充",
    automation: "assist",
  },
  douyin: {
    name: "抖音",
    short: "抖音",
    glyph: "抖",
    color: "#161823",
    kinds: ["video"],
    url: "https://creator.douyin.com/creator-micro/content/upload",
    caption: "视频 · 在发布页填充",
    automation: "assist",
  },
  bilibili: {
    name: "哔哩哔哩",
    short: "B站",
    glyph: "哔",
    color: "#fb7299",
    kinds: ["video"],
    url: "https://member.bilibili.com/platform/upload/video/frame",
    caption: "视频 · 在上传页填充",
    automation: "assist",
  },
  youtube: {
    name: "YouTube",
    short: "YouTube",
    glyph: "Y",
    color: "#ff0033",
    kinds: ["video"],
    url: "https://studio.youtube.com/",
    caption: "视频 · 上传后成为私享",
    automation: "assist",
  },
  instagram: {
    name: "Instagram",
    short: "Instagram",
    glyph: "I",
    color: "#c13584",
    kinds: ["video"],
    url: "https://www.instagram.com/",
    caption: "视频 · 在首页弹窗填充",
    automation: "assist",
  },
};
const TITLE_MAX = {
  article: { wechat: 64, xiaohongshu: 64, x: 100 },
  video: {
    xiaohongshu: 20,
    channels: 16,
    x: 100,
    douyin: 30,
    bilibili: 80,
    youtube: 100,
    instagram: 100,
  },
};
const TITLE_MIN = { video: { channels: 6 } };
const BODY_MAX = {
  article: { wechat: 120, xiaohongshu: 1000 },
  video: {
    xiaohongshu: 1000,
    douyin: 1000,
    channels: 1000,
    bilibili: 2000,
    youtube: 5000,
    instagram: 2200,
  },
};
const BAN_CONTACT = new Set(["xiaohongshu", "douyin", "channels"]);
export function titleLimit(kind, id) {
  return TITLE_MAX[kind]?.[id];
}
export function charLength(value) {
  return [...String(value || "")].length;
}
export function topicNames(value) {
  const names = [];
  for (const match of String(value || "").matchAll(/#([^\s#]+)/g))
    if (!names.includes(match[1])) names.push(match[1]);
  return names;
}
export function tagNames(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[,，\s]+/)
        .filter(Boolean),
    ),
  ];
}
export function hasContact(value) {
  const text = String(value || "");
  return (
    /https?:\/\/|www\./i.test(text) ||
    /(?:微信|薇信|vx|wx|weixin)\s*[:：]?\s*[A-Za-z][\w-]{5,}/i.test(text)
  );
}
export function assertPlatformCopy(
  kind,
  id,
  title,
  description = "",
  tags = "",
  hint = "请在平台适配中调整",
) {
  const name = PLATFORMS[id].name;
  const max = titleLimit(kind, id);
  const min = TITLE_MIN[kind]?.[id] || 1;
  const length = charLength(String(title || "").trim());
  if (!String(title || "").trim() || length > max || length < min)
    throw new Error(name + "标题需要" + min + "～" + max + "个字符，" + hint);
  const bodyMax = BODY_MAX[kind]?.[id];
  if (bodyMax && charLength(description) > bodyMax)
    throw new Error(name + "正文不能超过" + bodyMax + "个字符");
  if (kind === "video" && BAN_CONTACT.has(id) && hasContact(description))
    throw new Error(name + "正文不要放链接或微信号");
  const topics = topicNames(description);
  if (id === "douyin" && topics.length > 5)
    throw new Error("抖音话题最多 5 个");
  if (id === "bilibili") {
    const all = [...new Set([...tagNames(tags), ...topics])];
    if (all.length > 10) throw new Error("B 站标签最多 10 个");
    if (all.some((tag) => charLength(tag) > 20))
      throw new Error("B 站单个标签不能超过 20 个字符");
  }
  if (id === "youtube") {
    const all = tagNames(tags);
    if (all.some((tag) => /[<>]/.test(tag)))
      throw new Error("YouTube 标签不能包含 < 或 >");
    if (charLength(all.join("")) > 500)
      throw new Error("YouTube 标签总长度不能超过 500");
  }
}
export function platformsFor(kind) {
  return Object.keys(PLATFORMS).filter((id) =>
    PLATFORMS[id].kinds.includes(kind),
  );
}
export function isAssist(id) {
  return PLATFORMS[id]?.automation === "assist";
}
export function ensurePlatform(job, platform) {
  const config = PLATFORMS[platform];
  if (!config) throw new Error("未知平台：" + platform);
  if (!config.kinds.includes(job.kind))
    throw new Error(config.name + "不支持此内容类型");
  assertPlatformCopy(
    job.kind,
    platform,
    job.overrides?.[platform]?.title ?? job.title,
    job.overrides?.[platform]?.description ?? job.description ?? "",
    job.overrides?.[platform]?.tags || "",
    "请在工作台调整",
  );
  if (!job.platforms.includes(platform)) {
    job.platforms.push(platform);
    job.results ??= {};
    job.results[platform] = {
      state: "ready",
      message: "尚未同步到" + config.name,
      updatedAt: new Date().toISOString(),
    };
  }
  return job;
}
export const TERMINAL = new Set([
  "ready",
  "draft_ready",
  "review_ready",
  "needs_attention",
  "failed",
]);
// 暂时关闭。改回 true 即恢复命令、桥接和工作台里的 X 回复。
export const X_REPLY_ENABLED = false;
export function validateTask(input) {
  if (input?.kind === "x_reply") {
    if (!X_REPLY_ENABLED) throw new Error("X 回复暂时关闭");
    if (
      input.mode !== "review" ||
      !Array.isArray(input.platforms) ||
      input.platforms.length !== 1 ||
      input.platforms[0] !== "x"
    )
      throw new Error("X 回复仅支持工作台审阅");
    const match =
      /^https:\/\/x\.com\/([a-zA-Z0-9_]{1,15})\/status\/(\d+)(?:[?#][^\s]*)?$/.exec(
        input.targetUrl || "",
      );
    if (!match) throw new Error("请输入 X 原帖链接");
    const description = String(input.description || "").trim();
    if (!description || description.length > 2000)
      throw new Error("请填写回复正文，最多 2000 个字符");
    return {
      id: input.id || "x-reply-" + match[2],
      kind: "x_reply",
      title: "回复 @" + match[1].toLowerCase(),
      description,
      targetUrl:
        "https://x.com/" + match[1].toLowerCase() + "/status/" + match[2],
      platforms: ["x"],
      mode: "review",
      assets: [],
      createdAt: input.createdAt || new Date().toISOString(),
    };
  }
  if (!input || !["article", "video"].includes(input.kind))
    throw new Error("请选择文章或视频");
  const title = String(input.title || "").trim();
  if (!title) throw new Error("请填写标题");
  if (title.length > 100) throw new Error("标题不能超过100个字符");
  const platforms = [...new Set(input.platforms || [])];
  if (!platforms.length) throw new Error("至少选择一个平台");
  if (
    !input.overrides ||
    typeof input.overrides !== "object" ||
    Array.isArray(input.overrides)
  )
    input = { ...input, overrides: {} };
  for (const id of platforms) {
    if (!PLATFORMS[id]) throw new Error("未知平台：" + id);
    if (!PLATFORMS[id].kinds.includes(input.kind))
      throw new Error(PLATFORMS[id].name + "不支持此内容类型");
    const override = input.overrides[id] || {};
    if (
      Object.keys(override).some(
        (k) => !["title", "description", "tags"].includes(k),
      ) ||
      Object.values(override).some((v) => typeof v !== "string")
    )
      throw new Error("平台调整只接受标题、简介和标签");
    assertPlatformCopy(
      input.kind,
      id,
      override.title ?? title,
      override.description ?? input.description ?? "",
      override.tags || "",
    );
  }
  if (input.mode && input.mode !== "draft")
    throw new Error("当前版本只推送草稿");
  if (input.kind === "article" && !String(input.markdown || "").trim())
    throw new Error("请导入或填写文章正文");
  if (input.kind === "video" && !input.assets?.some((a) => a.role === "video"))
    throw new Error("请选择视频文件");
  const ids = new Set();
  for (const a of input.assets || []) {
    if (
      !a.id ||
      !a.name ||
      !Number.isSafeInteger(a.size) ||
      a.size < 0 ||
      a.size > 1024 ** 3 ||
      ids.has(a.id)
    )
      throw new Error("素材无效、重复或超过1GB");
    ids.add(a.id);
  }
  return {
    id: input.id || crypto.randomUUID(),
    kind: input.kind,
    title,
    markdown: String(input.markdown || ""),
    description: String(input.description || ""),
    prepared: input.prepared,
    platforms,
    mode: "draft",
    delivery: input.delivery === "manual" ? "manual" : "auto",
    assets: input.assets || [],
    overrides: input.overrides || {},
    aiGenerated: Boolean(input.aiGenerated),
    createdAt: input.createdAt || new Date().toISOString(),
  };
}
export function initialResults(task) {
  return Object.fromEntries(
    task.platforms.map((p) => [
      p,
      {
        state: "queued",
        message: "等待推送",
        updatedAt: new Date().toISOString(),
      },
    ]),
  );
}
export function canFillCurrent(platform, state, kind) {
  return (
    [undefined, "ready", "queued", "failed"].includes(state) ||
    (state === "needs_attention" &&
      (isAssist(platform) ||
        platform === "wechat" ||
        (platform === "x" && kind === "video")))
  );
}
export function retryable(result) {
  return ["failed", "needs_attention"].includes(result?.state);
}
export function isDraftEvidence(result) {
  return (
    result?.state === "draft_ready" &&
    result.persisted === true &&
    Boolean(result.draftUrl || result.editorUrl) &&
    Boolean(result.evidence)
  );
}
export function validateResult(result) {
  if (!TERMINAL.has(result?.state)) throw new Error("无效的任务结果");
  if (result.state === "draft_ready" && !isDraftEvidence(result))
    throw new Error("没有保存证据，不能标记为草稿已就绪");
  for (const key of ["draftUrl", "editorUrl"])
    if (result[key] && !/^https:\/\//.test(result[key]))
      throw new Error("草稿链接必须使用 HTTPS");
  return result;
}
export function forPlatform(task, id) {
  return {
    ...task,
    ...task.overrides[id],
    id: task.id,
    platform: id,
    mode: "draft",
    assets: task.assets,
    overrides: task.overrides,
  };
}
export function shownMessage(message) {
  return String(message || "").replace(
    /；话题「[^」]*」已按「#[^」]*」写入，请确认视频号已高亮/g,
    "",
  );
}
export function safeUrl(value) {
  try {
    const url = new URL(value);
    for (const k of ["token", "ticket", "key", "access_token"])
      url.searchParams.delete(k);
    return url.href;
  } catch {
    return "";
  }
}
