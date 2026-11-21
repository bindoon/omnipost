import { PLATFORMS } from "./platforms/index.js";

export { PLATFORMS };

export function titleLimit(kind, id) {
  return PLATFORMS[id]?.copy[kind]?.titleMax;
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
  const rules = PLATFORMS[id].copy[kind] || {};
  const { titleMax, titleMin = 1, bodyMax } = rules;
  const length = charLength(String(title || "").trim());
  if (length < titleMin || length > titleMax)
    throw new Error(
      name + "标题需要" + titleMin + "～" + titleMax + "个字符，" + hint,
    );
  if (bodyMax && charLength(description) > bodyMax)
    throw new Error(name + "正文不能超过" + bodyMax + "个字符");
  if (rules.forbidContact && hasContact(description))
    throw new Error(name + "正文不要放链接或微信号");

  const topics = topicNames(description);
  if (rules.topicMax && topics.length > rules.topicMax)
    throw new Error(name + "话题最多 " + rules.topicMax + " 个");
  const all = tagNames(tags);
  const nativeTags = rules.tagsFromTopics
    ? [...new Set([...all, ...topics])]
    : all;
  if (rules.tagMax && nativeTags.length > rules.tagMax)
    throw new Error(name + "标签最多 " + rules.tagMax + " 个");
  if (
    rules.tagLengthMax &&
    nativeTags.some((tag) => charLength(tag) > rules.tagLengthMax)
  )
    throw new Error(
      name + "单个标签不能超过 " + rules.tagLengthMax + " 个字符",
    );
  if (
    rules.tagForbidden &&
    nativeTags.some((tag) => rules.tagForbidden.test(tag))
  )
    throw new Error(name + " 标签不能包含 < 或 >");
  if (rules.tagTotalMax && charLength(nativeTags.join("")) > rules.tagTotalMax)
    throw new Error(name + " 标签总长度不能超过 " + rules.tagTotalMax);
}
export function platformsFor(kind) {
  return Object.keys(PLATFORMS).filter((id) =>
    PLATFORMS[id].kinds.includes(kind),
  );
}
export function isAssist(id) {
  return PLATFORMS[id]?.automation === "assist";
}
export function videoFingerprintKey(job, asset) {
  return JSON.stringify([job.id, asset.id]);
}
export function validSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}
export function groupVideoTasks(jobs, fingerprints) {
  const groups = new Map();
  for (const job of jobs) {
    const asset =
      job.kind === "video" && job.assets?.find((a) => a.role === "video");
    const checked = asset && fingerprints?.get(videoFingerprintKey(job, asset));
    const hash = validSha256(asset?.sha256) ? asset.sha256 : checked;
    const identity = validSha256(hash)
      ? "sha256:" + hash.toLowerCase()
      : "job:" + job.id;
    const group = groups.get(identity) || [];
    group.push(job);
    groups.set(identity, group);
  }
  return [...groups.values()];
}
export function ensurePlatform(job, platform) {
  const config = PLATFORMS[platform];
  if (!config) throw new Error("未知平台：" + platform);
  if (!config.kinds.includes(job.kind))
    throw new Error(config.name + "不支持此内容类型");
  if (job.schedule) {
    if (!config.schedule) throw new Error(config.name + "暂不支持填入定时");
    if (job.schedule.submit && !config.schedule.submitLabel)
      throw new Error(config.name + "需要在原页面确认提交");
  }
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
  "schedule_ready",
  "scheduled",
  "schedule_unconfirmed",
  "review_ready",
  "needs_attention",
  "failed",
]);
export function nativeScheduleTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::00)?\+08:00$/.exec(
    String(value || ""),
  );
  const time = Date.parse(value);
  if (
    !match ||
    !Number.isFinite(time) ||
    new Date(time + 8 * 3600000).toISOString().slice(0, 16) !==
      `${match[1]}T${match[2]}`
  )
    throw new Error("定时时间须为有效日期和分钟，并明确标记 +08:00");
  return `${match[1]}T${match[2]}:00+08:00`;
}
// Check the clock at execution time so older stored tasks remain readable.
export function scheduleWindowIssue(platform, at, now = Date.now()) {
  const schedule = PLATFORMS[platform]?.schedule;
  if (!schedule) return "此平台暂不支持填入定时";
  const time = Date.parse(at);
  if (!(time > now)) return "预约时间已经过去或无效";
  const { minMinutes, maxDays } = schedule.window || {};
  const name = PLATFORMS[platform].short;
  if (minMinutes && time < now + minMinutes * 60_000)
    return `${name}预约时间至少需要提前 ${minMinutes} 分钟`;
  if (maxDays && time > now + maxDays * 86_400_000)
    return `${name}预约时间需要在 ${maxDays} 天内`;
  return "";
}
function scheduleSettings(input, platforms) {
  if (!input.schedule) return null;
  if (
    input.kind !== "video" ||
    platforms.some((platform) => !PLATFORMS[platform]?.schedule)
  )
    throw new Error("所选内容或平台暂不支持原生定时");
  const at = nativeScheduleTime(input.schedule.at);
  const collection = String(input.schedule.collection || "").trim();
  const submit = input.schedule.submit === true;
  const manual = platforms.filter(
    (platform) => !PLATFORMS[platform].schedule.submitLabel,
  );
  if (submit && manual.length)
    throw new Error(
      manual.map((platform) => PLATFORMS[platform].name).join("、") +
        "需要在原页面确认提交",
    );
  if (charLength(collection) > 100)
    throw new Error("合集名称不能超过100个字符");
  if (submit && input.delivery === "manual")
    throw new Error("手动交接只能填入定时，不可自动提交");
  if (
    submit &&
    (!collection ||
      !input.assets?.some(
        (a) => a.role === "cover-portrait" && a.type?.startsWith("image/"),
      ) ||
      !input.assets?.some(
        (a) => a.role === "cover-landscape" && a.type?.startsWith("image/"),
      ))
  )
    throw new Error("提交定时需要明确合集及横竖封面");
  return { at, collection, submit };
}
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
        (k) =>
          ![
            "title",
            "description",
            "tags",
            ...(input.schedule ? ["collection"] : []),
            ...(PLATFORMS[id].categoryMax ? ["category"] : []),
          ].includes(k),
      ) ||
      Object.values(override).some((v) => typeof v !== "string")
    )
      throw new Error(
        PLATFORMS[id].categoryMax
          ? "B 站平台调整只接受标题、简介、标签、分区和定时合集"
          : input.schedule
            ? "定时任务的平台调整只接受标题、简介、标签和合集"
            : "平台调整只接受标题、简介和标签",
      );
    if (
      override.category !== undefined &&
      (!override.category.trim() ||
        charLength(override.category) > PLATFORMS[id].categoryMax)
    )
      throw new Error("B 站分区需要1～20个字符");
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
    ...(input.schedule ? { schedule: scheduleSettings(input, platforms) } : {}),
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
export function scheduleNeedsReview(result) {
  return (
    [
      "schedule_ready",
      "scheduled",
      "schedule_unconfirmed",
      "submitting",
    ].includes(result?.state) ||
    (result?.state === "needs_attention" &&
      Boolean(result.scheduledAt && result.evidence))
  );
}
export function canFillCurrent(platform, result, kind) {
  if (scheduleNeedsReview(result)) return false;
  const state = result?.state;
  return (
    [undefined, "ready", "queued", "failed"].includes(state) ||
    (state === "needs_attention" &&
      (isAssist(platform) ||
        platform === "wechat" ||
        (platform === "x" && kind === "video")))
  );
}
export function retryable(result) {
  return (
    !scheduleNeedsReview(result) &&
    ["failed", "needs_attention"].includes(result?.state)
  );
}
// Once a submission is in flight, an editor error or disconnect cannot prove
// that the platform did not receive it. Keep the existing editor for review.
export function protectScheduleResult(previous, result) {
  if (
    previous?.state !== "submitting" ||
    ["schedule_ready", "scheduled", "schedule_unconfirmed"].includes(
      result.state,
    )
  )
    return result;
  return {
    ...result,
    state: "schedule_unconfirmed",
    persisted: false,
    message: "定时提交结果不明，请先核对平台作品列表",
  };
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
  if (["schedule_ready", "scheduled"].includes(result.state)) {
    nativeScheduleTime(result.scheduledAt);
    if (
      !result.editorUrl ||
      !result.evidence ||
      result.persisted !== (result.state === "scheduled")
    )
      throw new Error("没有平台定时回执，不能标记为已写入或已提交");
  }
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
