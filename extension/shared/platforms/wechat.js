/** @satisfies {import("./index.js").PlatformRules} */
const rules = {
  name: "微信公众号",
  short: "公众号",
  glyph: "微",
  color: "#07a86c",
  url: "https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card&lang=zh_CN",
  worksUrl:
    "https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=0&count=10",
  caption: "图文草稿 · 保留正文排版",
  automation: "direct",
  copy: { article: { titleMax: 64, bodyMax: 120 } },
};

export default rules;
