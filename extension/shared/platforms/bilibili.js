/** @satisfies {import("./index.js").PlatformRules} */
const rules = {
  name: "哔哩哔哩",
  short: "B站",
  glyph: "哔",
  color: "#fb7299",
  url: "https://member.bilibili.com/platform/upload/video/frame",
  editorPaths: [/^\/platform\/upload\/video\/frame\/?$/],
  worksUrl: "https://member.bilibili.com/platform/upload-manager/article",
  caption: "视频 · 在上传页填充",
  automation: "assist",
  copy: {
    video: {
      titleMax: 80,
      bodyMax: 2000,
      tagsFromTopics: true,
      tagMax: 10,
      tagLengthMax: 20,
    },
  },
  categoryMax: 20,
  schedule: {
    openEditor: true,
    capability: "native-bilibili-schedule",
    window: { maxDays: 15 },
    disclosure: { statement: "含AI生成内容" },
  },
};

export default rules;
