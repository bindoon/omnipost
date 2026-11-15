import { marked } from "marked";
import {
  prepareForWechat,
  prepareForX,
} from "../../src/formats.mjs";
const FONT =
  "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif";
export function normalizePath(p) {
  try {
    return decodeURIComponent(String(p))
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
  } catch {
    throw new Error("图片路径编码无效");
  }
}
export function extractTitle(md) {
  return /^#\s+(.+)$/m.exec(md)?.[1]?.trim() || "";
}
export function imagePaths(markdown) {
  const paths = [];
  marked.walkTokens(
    marked.lexer(String(markdown).replace(/<!--[\s\S]*?-->/g, "")),
    (t) => {
      if (t.type === "image") paths.push(normalizePath(t.href));
    },
  );
  return paths;
}
export function renderArticle(markdown, assets, Parser = globalThis.DOMParser) {
  const clean = String(markdown || "").replace(/<!--[\s\S]*?-->/g, "");
  const doc = new Parser().parseFromString(
    "<html><body><article></article></body></html>",
    "text/html",
  );
  const root = doc.querySelector("article");
  root.innerHTML = marked.parse(clean, { gfm: true, breaks: false });
  root
    .querySelectorAll(
      "script,style,iframe,object,embed,form,input,button,svg,link,meta",
    )
    .forEach((e) => e.remove());
  const allowed = new Set([
    "P",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "A",
    "IMG",
    "STRONG",
    "B",
    "EM",
    "I",
    "UL",
    "OL",
    "LI",
    "BLOCKQUOTE",
    "PRE",
    "CODE",
    "TABLE",
    "THEAD",
    "TBODY",
    "TR",
    "TH",
    "TD",
    "HR",
    "BR",
    "DEL",
  ]);
  for (const el of [...root.querySelectorAll("*")]) {
    if (!allowed.has(el.tagName)) {
      el.replaceWith(...el.childNodes);
      continue;
    }
    for (const a of [...el.attributes])
      if (!["href", "src", "alt"].includes(a.name)) el.removeAttribute(a.name);
    if (
      el.tagName === "A" &&
      !/^(https?:|mailto:|#)/i.test(el.getAttribute("href") || "")
    )
      el.removeAttribute("href");
  }
  const media = [];
  for (const img of [...root.querySelectorAll("img")]) {
    const src = normalizePath(img.getAttribute("src") || "");
    if (src.startsWith("../") || /^[a-z]+:/i.test(src) || src.startsWith("/"))
      throw new Error("请使用文章目录中的相对图片路径：" + src);
    let candidates = assets.filter(
      (a) =>
        a.role !== "video" &&
        (normalizePath(a.path || a.name) === src || a.source === src),
    );
    if (!candidates.length)
      candidates = assets.filter(
        (a) => a.role !== "video" && a.name === src.split("/").pop(),
      );
    if (candidates.length !== 1)
      throw new Error("请导入对应图片（保留相对路径）：" + src);
    const a = candidates[0];
    img.setAttribute("src", "publisher-asset:" + a.id);
    img.setAttribute("data-asset-id", a.id);
    media.push({ id: a.id, alt: img.getAttribute("alt") || a.name });
  }
  root.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    const p = doc.createElement("p");
    const depth = +h.tagName[1];
    p.setAttribute("data-md-h", String(depth));
    p.innerHTML = "<strong>" + h.innerHTML + "</strong>";
    p.setAttribute(
      "style",
      `margin:${depth === 1 ? "0 0 24px" : "32px 0 14px"};line-height:1.45;`,
    );
    p.firstElementChild.setAttribute(
      "style",
      `font-size:${depth === 1 ? 26 : depth === 2 ? 20 : 17}px;font-weight:700;color:#17212f;`,
    );
    h.replaceWith(p);
  });
  root.querySelectorAll("p").forEach((p) => {
    if (p.hasAttribute("data-md-h")) return;
    const caption =
      p.children.length === 1 && p.firstElementChild.tagName === "EM";
    p.setAttribute(
      "style",
      `font-family:${FONT};font-size:${caption ? 13 : 16}px;line-height:${caption ? 1.6 : 1.8};color:${caption ? "#758091" : "#273343"};margin:0 0 ${caption ? 24 : 18}px;${caption ? "text-align:center;" : ""}`,
    );
  });
  root
    .querySelectorAll("img")
    .forEach((i) =>
      i.setAttribute("style", "max-width:100%;height:auto;border-radius:6px;"),
    );
  const wx = prepareForWechat(root),
    semantic = root.cloneNode(true);
  let markerIndex = 0;
  semantic.querySelectorAll("img").forEach((img) => {
    const span = doc.createElement("span");
    span.textContent = "【待插入配图 " + ++markerIndex + "】";
    img.replaceWith(span);
  });
  const x = prepareForX(semantic);
  const raw = doc.createElement("article");
  raw.innerHTML = root.innerHTML;
  raw.querySelector('[data-md-h="1"]')?.remove();
  const text = raw.textContent.trim();
  return {
    wechat: wx.innerHTML,
    x: x.innerHTML,
    xiaohongshu: x.innerHTML,
    preview: root.innerHTML,
    media,
    text,
  };
}
export function markedImages(html, media, Parser = globalThis.DOMParser) {
  const doc = new Parser().parseFromString(
    "<html><body><article>" + html + "</article></body></html>",
    "text/html",
  );
  const root = doc.querySelector("article");
  let n = 0;
  root.querySelectorAll("img").forEach((img) => {
    const marker = doc.createElement("span");
    marker.textContent = "【待插入配图 " + ++n + "】";
    img.replaceWith(marker);
  });
  if (n !== media.length) throw new Error("图片数量与清单不一致");
  return root.innerHTML;
}
