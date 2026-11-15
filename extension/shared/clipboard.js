import { renderArticle } from "./content.js";

export function articleText(root) {
  const block = /^(P|DIV|SECTION|ARTICLE|H[1-6]|LI|BLOCKQUOTE|PRE|TR)$/;
  const walk = (node) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeName === "BR") return "\n";
    if (node.nodeName === "IMG") return node.getAttribute("alt") || "";
    const text = [...node.childNodes].map(walk).join("");
    return text + (block.test(node.nodeName) ? "\n" : "");
  };
  return walk(root)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function wechatClipboard(
  job,
  { images = true, readAsset } = {},
  Parser = globalThis.DOMParser,
) {
  const html = job.markdown
    ? renderArticle(job.markdown, job.assets || [], Parser).wechat
    : job.prepared?.wechat;
  if (!html) throw new Error("没有可复制的微信正文，请先导入文章");
  const doc = new Parser().parseFromString(
    "<html><body>" + html + "</body></html>",
    "text/html",
  );
  doc.querySelector('[data-md-h="1"]')?.remove();
  for (const img of [...doc.querySelectorAll("img")]) {
    if (!images) {
      const paragraph = img.closest("p");
      if (paragraph && !paragraph.textContent.trim()) paragraph.remove();
      else img.remove();
      continue;
    }
    const id =
      img.getAttribute("data-asset-id") ||
      img.getAttribute("src")?.replace(/^publisher-asset:/, "");
    const asset = job.assets?.find((asset) => asset.id === id);
    if (!asset || !/^image\//.test(asset.type))
      throw new Error(
        "配图清单不匹配，请改用「复制微信正文（无图）」并手动上传配图",
      );
    const blob = await readAsset(asset);
    if (!blob?.size)
      throw new Error(
        "无法读取配图，请改用「复制微信正文（无图）」并手动上传配图",
      );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    img.setAttribute("src", `data:${asset.type};base64,${btoa(binary)}`);
    img.removeAttribute("data-asset-id");
  }
  return { html: doc.body.innerHTML, text: articleText(doc.body) };
}

export function copyWechatArticle(job, options) {
  const prepared = wechatClipboard(job, options);
  // Promise-backed items keep write() inside the click gesture while images load.
  if (navigator.clipboard?.write && globalThis.ClipboardItem) {
    const item = new ClipboardItem({
      "text/html": prepared.then(
        ({ html }) => new Blob([html], { type: "text/html" }),
      ),
      "text/plain": prepared.then(
        ({ text }) => new Blob([text], { type: "text/plain" }),
      ),
    });
    return navigator.clipboard
      .write([item])
      .catch(async () => fallbackCopy((await prepared).html));
  }
  return prepared.then(({ html }) => fallbackCopy(html));
}

function fallbackCopy(html) {
  const node = document.createElement("div");
  node.contentEditable = "true";
  node.style.cssText = "position:fixed;left:-9999px;top:0";
  node.innerHTML = html;
  const selection = document.getSelection();
  const ranges = Array.from({ length: selection.rangeCount }, (_, i) =>
    selection.getRangeAt(i).cloneRange(),
  );
  const focused = document.activeElement;
  document.body.append(node);
  try {
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand("copy"))
      throw new Error("复制失败，请在预览中选中正文后按 Cmd/Ctrl+C");
  } finally {
    node.remove();
    selection.removeAllRanges();
    ranges.forEach((range) => selection.addRange(range));
    focused?.focus();
  }
}

export function copyArticleTitle(job) {
  const title = job.overrides?.wechat?.title ?? job.title;
  if (!title?.trim()) return Promise.reject(new Error("请先填写文章标题"));
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(title);
  const node = document.createElement("p");
  node.textContent = title;
  fallbackCopy(node.outerHTML);
  return Promise.resolve();
}
