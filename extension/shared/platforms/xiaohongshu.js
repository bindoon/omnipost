/** @satisfies {import("./index.js").PlatformRules} */
const rules = {
  name: "小红书",
  short: "小红书",
  glyph: "红",
  color: "#f43f5e",
  url: "https://creator.xiaohongshu.com/publish/publish?source=official",
  editorPaths: [/^\/publish\/publish\/?$/],
  worksUrl: "https://creator.xiaohongshu.com/new/note-manager",
  caption: "长文 / 视频 · 平台内微调",
  automation: "direct",
  copy: {
    article: { titleMax: 64, bodyMax: 1000 },
    video: {
      titleMax: 20,
      bodyMax: 1000,
      forbidContact: true,
      nativeTopics: true,
    },
  },
  schedule: {
    openEditor: true,
    submitLabel: "定时发布",
    receiptPath: /^\/publish\/publishSuccess/i,
    disclosure: { opener: "添加内容类型声明", statement: "笔记含AI合成内容" },
  },
};

export default rules;
