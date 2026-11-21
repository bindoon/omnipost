/** @satisfies {import("./index.js").PlatformRules} */
const rules = {
  name: "TikTok Studio",
  short: "TikTok",
  glyph: "♪",
  color: "#161823",
  url: "https://www.tiktok.com/tiktokstudio/upload",
  worksUrl: "https://www.tiktok.com/tiktokstudio/content",
  editorPaths: [/^\/tiktokstudio\/upload\/?$/],
  isExistingWork: (url) =>
    Boolean(url.hash) ||
    (Boolean(url.search) &&
      !/^\?from=(?:creator_center|webapp)&tab=video$/.test(url.search)),
  caption: "视频 · 在上传页预填预约",
  automation: "assist",
  copy: { video: { titleMax: 100 } },
  schedule: {
    openEditor: false,
    capability: "native-tiktok-schedule-preparation",
  },
};

export default rules;
