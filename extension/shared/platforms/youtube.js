/** @satisfies {import("./index.js").PlatformRules} */
const rules = {
  name: "YouTube",
  short: "YouTube",
  glyph: "Y",
  color: "#ff0033",
  url: "https://studio.youtube.com/",
  editorPaths: [/\/videos\/upload\/?$/],
  caption: "视频 · 上传后成为私享",
  automation: "assist",
  copy: {
    video: {
      titleMax: 100,
      bodyMax: 5000,
      tagForbidden: /[<>]/,
      tagTotalMax: 500,
    },
  },
};

export default rules;
