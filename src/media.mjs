import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

function stripHtmlComments(md) {
  return md.replace(/<!--[\s\S]*?-->/g, "");
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveLocalImage(src, rootDir) {
  if (!src || /^(https?:|data:|mailto:|#)/i.test(src)) return null;
  let cleaned;
  try {
    cleaned = decodeURIComponent(src.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  const abs = path.resolve(rootDir, cleaned);
  if (!isInside(rootDir, abs)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  if (!isInside(fs.realpathSync(rootDir), fs.realpathSync(abs))) return null;
  return abs;
}

export function collectMedia(mdText, rootDir) {
  const images = [];
  marked.walkTokens(marked.lexer(stripHtmlComments(mdText)), (token) => {
    if (token.type !== "image") return;
    const local = !/^(https?:|data:)/i.test(token.href);
    images.push({
      index: images.length + 1,
      source: token.href,
      alt: token.text || "",
      local,
      available: !local || Boolean(resolveLocalImage(token.href, rootDir)),
    });
  });
  return images;
}
