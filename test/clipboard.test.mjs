import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { DOMParser } from "linkedom";
import { wechatClipboard } from "../extension/shared/clipboard.js";
const job = {
  kind: "article",
  title: "原始标题",
  overrides: { wechat: { title: "公众号标题" } },
  markdown: "# 原始标题\n\n开头。\n\n## 小节\n\n![图注](photo.png)\n\n末段。",
  assets: [
    { id: "photo", name: "photo.png", type: "image/png", role: "image" },
  ],
};
test("微信复制保留段落排版、完整末段和图片字节，不带一级标题或插件占位地址", async () => {
  const result = await wechatClipboard(
    job,
    { readAsset: async () => new Blob(["image"], { type: "image/png" }) },
    DOMParser,
  );
  assert.doesNotMatch(
    result.html,
    /原始标题|publisher-asset:|data-asset-id|blob:/,
  );
  assert.match(result.html, /font-size:20px/);
  assert.match(result.html, /data:image\/png;base64,aW1hZ2U=/);
  assert.match(result.text, /开头。\n+小节\n+图注\n+末段。/);
});
test("无图复制不读取素材，图片丢失时仍可复制完整排版正文", async () => {
  let reads = 0;
  const result = await wechatClipboard(
    job,
    {
      images: false,
      readAsset: async () => {
        reads++;
        throw new Error("missing");
      },
    },
    DOMParser,
  );
  assert.equal(reads, 0);
  assert.doesNotMatch(result.html, /<img|publisher-asset:/);
  assert.match(result.html, /font-size:20px/);
  assert.match(result.text, /末段。/);
  await assert.rejects(
    () => wechatClipboard(job, { readAsset: async () => null }, DOMParser),
    /复制微信正文（无图）/,
  );
});
test("富文本复制在点击时立即写入剪贴板，异步加载的图文同时提供 HTML 和纯文本", async () => {
  const source = (
    await fs.readFile(
      new URL("../extension/shared/clipboard.js", import.meta.url),
      "utf8",
    )
  )
    .replace(/^import[^\n]+\n/gm, "")
    .replaceAll("export ", "");
  let prepared = false,
    written = false,
    plain = "";
  const context = vm.createContext({
    DOMParser,
    Blob,
    Uint8Array,
    btoa,
    renderArticle: () => ({
      wechat:
        '<p style="font-size:20px">正文</p><p><img data-asset-id="photo" src="publisher-asset:photo"></p>',
    }),
    ClipboardItem: class {
      constructor(data) {
        this.data = data;
      }
    },
    navigator: {
      clipboard: {
        write: async ([item]) => {
          written = true;
          assert.equal(prepared, false);
          const html = await (await item.data["text/html"]).text();
          const text = await (await item.data["text/plain"]).text();
          assert.match(html, /data:image\/png;base64/);
          assert.equal(text, "正文");
        },
        writeText: async (text) => {
          plain = text;
        },
      },
    },
    job,
    options: {
      readAsset: async () => {
        await new Promise(setImmediate);
        prepared = true;
        return new Blob(["image"], { type: "image/png" });
      },
    },
  });
  vm.runInContext(source, context);
  const pending = vm.runInContext("copyWechatArticle(job, options)", context);
  assert.equal(written, true);
  await pending;
  await vm.runInContext("copyArticleTitle(job)", context);
  assert.equal(plain, "公众号标题");
});
