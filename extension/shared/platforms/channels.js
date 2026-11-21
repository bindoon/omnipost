/** @satisfies {import("./index.js").PlatformRules} */
const rules = {
  name: "微信视频号",
  short: "视频号",
  glyph: "视",
  color: "#ee9b28",
  url: "https://channels.weixin.qq.com/platform",
  editorPaths: [
    /^\/platform\/?$/,
    /^\/platform\/post\/create\/?$/,
    /^\/platform\/post\/coverEdit\/?$/,
  ],
  worksUrl: "https://channels.weixin.qq.com/platform/post/list",
  caption: "视频 · 在发布页填充",
  automation: "assist",
  copy: {
    video: { titleMin: 6, titleMax: 16, bodyMax: 1000, forbidContact: true },
  },
  schedule: {
    openEditor: true,
    window: { minMinutes: 30, maxDays: 4 },
    submitLabel: "发表",
    receiptPattern: "已发表|定时发表成功|预约成功|发布成功",
  },
};

export default rules;
