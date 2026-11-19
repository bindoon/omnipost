/** @satisfies {import("./index.js").PlatformRules} */
const rules = {
  name: "Instagram",
  short: "Instagram",
  glyph: "I",
  color: "#c13584",
  url: "https://www.instagram.com/",
  editorPaths: [/^\/$/, /^\/create(?:\/|$)/],
  worksUrl: "https://www.instagram.com/",
  caption: "视频 · 在首页弹窗填充",
  automation: "assist",
  copy: { video: { titleMax: 100, bodyMax: 2200 } },
};

export default rules;
