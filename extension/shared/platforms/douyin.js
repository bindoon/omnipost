/** @satisfies {import("./index.js").PlatformRules} */
const rules = {
  name: "抖音",
  short: "抖音",
  glyph: "抖",
  color: "#161823",
  url: "https://creator.douyin.com/creator-micro/content/upload",
  editorPaths: [
    /^\/creator-micro\/content\/upload\/?$/,
    /^\/creator-micro\/content\/post\/video\/?$/,
    /^\/creator-micro\/content\/publish\/?$/,
    /^\/content\/upload\/?$/,
  ],
  worksUrl: "https://creator.douyin.com/creator-micro/content/manage",
  caption: "视频 · 在发布页填充",
  automation: "assist",
  copy: {
    video: {
      titleMax: 30,
      bodyMax: 1000,
      forbidContact: true,
      nativeTopics: true,
      topicMax: 5,
    },
  },
  schedule: {
    openEditor: true,
    window: { minMinutes: 120 },
    submitLabel: "发布",
    collectionAfterTime: true,
    disclosure: {
      opener: "请选择自主声明",
      statement: "内容由AI生成",
      confirm: "确定",
    },
  },
};

export default rules;
