/** @satisfies {import("./index.js").PlatformRules} */
const rules = {
  name: "X",
  short: "X",
  glyph: "𝕏",
  color: "#151b2a",
  url: "https://x.com/compose/articles",
  editorPaths: [/^\/compose\/(post|tweet)\/?$/],
  worksUrl: "https://x.com/home",
  caption: "Articles / 视频 · 原生格式",
  automation: "direct",
  copy: { article: { titleMax: 100 }, video: { titleMax: 100 } },
};

export default rules;
