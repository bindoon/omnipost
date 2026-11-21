export const VIDEO_REPLACEMENT_CAPABILITY = "scheduled-video-replacement";
const workIds = {
  xiaohongshu: /^[a-f0-9]{24}$/i,
  bilibili: /^BV[\dA-Za-z]{10}$/,
};

export function validReplacementWorkId(platform, workId) {
  return typeof workId === "string" && Boolean(workIds[platform]?.test?.(workId));
}

export function replacementTarget(value) {
  try {
    const url = new URL(value);
    const param = (key) => {
      const values = url.searchParams.getAll(key);
      return values.length === 1 ? values[0] : null;
    };
    const id = param("id");
    if (
      url.origin === "https://creator.xiaohongshu.com" &&
      /^\/publish\/update\/?$/.test(url.pathname) &&
      validReplacementWorkId("xiaohongshu", id) &&
      param("noteType") === "video"
    )
      return { platform: "xiaohongshu", workId: id };
    const bvid = param("bvid");
    if (
      url.origin === "https://member.bilibili.com" &&
      /^\/platform\/upload\/video\/frame\/?$/.test(url.pathname) &&
      param("type") === "edit" &&
      validReplacementWorkId("bilibili", bvid)
    )
      return { platform: "bilibili", workId: bvid };
  } catch {}
  return null;
}

export function replacementPlatform(value) {
  return replacementTarget(value)?.platform ?? null;
}

export function replacementAsset(job, platform, now = Date.now()) {
  if (
    job?.kind !== "video" ||
    !job.platforms.includes(platform) ||
    job.delivery !== "manual" ||
    job.schedule?.submit ||
    !(Date.parse(job.schedule?.at) > now)
  )
    return null;
  const videos = job.assets.filter((asset) => asset.role === "video");
  const video = videos[0];
  if (
    videos.length !== 1 ||
    !video.type?.startsWith("video/") ||
    !(video.size > 0)
  )
    return null;
  return video;
}
