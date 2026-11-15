import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DOMParser } from "linkedom";
import { renderArticle } from "../extension/shared/content.js";
import {
  validateTask,
  validateResult,
  forPlatform,
} from "../extension/shared/model.js";
import { importTask } from "../cli.mjs";
const asset = {
  id: "image-1",
  name: "城市.jpg",
  path: "images/城市.jpg",
  role: "image",
  type: "image/jpeg",
  size: 6,
};
const md =
  "# 原文章标题\n\n完整正文与[数据来源](https://example.com/data)。\n\n## 制作过程\n\n![城市](images/城市.jpg)\n\n*截图图注*\n\n最后一段，必须保留。";
const parse = (html) =>
  new DOMParser().parseFromString(
    "<html><body>" + html + "</body></html>",
    "text/html",
  );
test("一份文章生成微信明确字号与 X 原生标题，图片位置保留给真实上传", () => {
  const r = renderArticle(md, [asset], DOMParser);
  const wx = parse(r.wechat),
    x = parse(r.x);
  assert.equal(wx.querySelectorAll('[data-md-h="1"]').length, 0);
  assert.match(
    wx.querySelector('[data-md-h="2"] strong').getAttribute("style"),
    /20px/,
  );
  assert.equal(wx.querySelectorAll("img").length, 1);
  assert.match(wx.body.textContent, /最后一段，必须保留/);
  assert.equal(x.querySelector("h2").textContent, "制作过程");
  assert.equal(x.querySelectorAll("[style],img").length, 0);
  assert.equal(
    x.querySelector("a").getAttribute("href"),
    "https://example.com/data",
  );
  assert.match(x.body.textContent, /【待插入配图 1】/);
  assert.deepEqual(r.media, [{ id: "image-1", alt: "城市" }]);
});
test("缺图、重名图片、外部图片和上级路径都不能静默变成成功适配", () => {
  assert.throws(() => renderArticle(md, [], DOMParser), /导入对应图片/);
  assert.throws(
    () =>
      renderArticle(
        md,
        [
          { ...asset, path: "a/城市.jpg" },
          { ...asset, id: "image-2", path: "b/城市.jpg" },
        ],
        DOMParser,
      ),
    /导入对应图片/,
  );
  assert.throws(
    () => renderArticle("![图](https://other.example/a.jpg)", [], DOMParser),
    /相对图片路径/,
  );
  assert.throws(
    () => renderArticle("![图](../城市.jpg)", [asset], DOMParser),
    /相对图片路径/,
  );
});
test("Markdown 中的脚本、事件属性和危险链接不会进入平台富文本", () => {
  const r = renderArticle(
    '# 标题\n\n<script>alert(1)</script>\n\n<p onclick="x()">保留文字</p>\n\n[危险](javascript:alert%281%29)',
    [],
    DOMParser,
  );
  assert.doesNotMatch(r.wechat, /<script|onclick|javascript:/i);
  assert.match(r.wechat, /保留文字/);
});
test("逐平台标题与简介独立，正文与原始素材不被覆盖", () => {
  const t = validateTask({
    kind: "article",
    title: "原标题",
    markdown: md,
    platforms: ["wechat", "x"],
    assets: [asset],
    overrides: { x: { title: "X标题", description: "X简介" } },
  });
  const x = forPlatform(t, "x");
  assert.equal(x.title, "X标题");
  assert.equal(x.markdown, md);
  assert.equal(t.title, "原标题");
  assert.equal(forPlatform(t, "wechat").title, "原标题");
  assert.throws(() => validateTask({ ...t, mode: "publish" }), /只推送草稿/);
  assert.throws(
    () => validateTask({ ...t, overrides: { x: { assets: [] } } }),
    /只接受标题和简介/,
  );
});
test("未保存、未拿到编辑入口或缺少保存证据时，不得报告草稿就绪", () => {
  for (const r of [
    {
      state: "draft_ready",
      persisted: false,
      draftUrl: "https://x.com/a",
      evidence: "ok",
    },
    { state: "draft_ready", persisted: true, draftUrl: "https://x.com/a" },
    { state: "draft_ready", persisted: true, evidence: "ok" },
  ])
    assert.throws(() => validateResult(r), /保存证据/);
  assert.equal(
    validateResult({ state: "needs_attention", message: "请登录" }).state,
    "needs_attention",
  );
  assert.throws(
    () =>
      validateResult({
        state: "draft_ready",
        persisted: true,
        draftUrl: "javascript:alert(1)",
        evidence: "saved",
      }),
    /HTTPS/,
  );
});
test("CLI 从真实文件导入正文和图片，中文路径、顺序、字节与内容都保留", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "publisher-import-"));
  try {
    await fs.mkdir(path.join(dir, "images"));
    await fs.writeFile(path.join(dir, "images/城市.jpg"), "abcdef");
    await fs.writeFile(path.join(dir, "文章.md"), md);
    const t = await importTask("article", path.join(dir, "文章.md"), {
      platforms: "wechat,x",
    });
    assert.equal(t.title, "原文章标题");
    assert.equal(t.assets.length, 1);
    assert.equal(t.assets[0].size, 6);
    assert.match(t.prepared.wechat, /截图图注/);
    assert.equal(t.mode, "draft");
    assert.match(t.prepared.x, /最后一段/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CLI 手动交接同时保留横竖封面，默认任务仍自动执行", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "publisher-covers-"));
  try {
    for (const name of ["片.mp4", "横.png", "竖.png"])
      await fs.writeFile(path.join(dir, name), "fixture");
    const opts = {
      title: "虚与实",
      platforms: "x",
      stage: true,
      "cover-landscape": path.join(dir, "横.png"),
      "cover-portrait": path.join(dir, "竖.png"),
    };
    const t = await importTask("video", path.join(dir, "片.mp4"), opts);
    assert.equal(t.delivery, "manual");
    assert.deepEqual(
      t.assets.map((a) => a.role),
      ["video", "cover-landscape", "cover-portrait"],
    );
    assert.equal(
      (
        await importTask("video", path.join(dir, "片.mp4"), {
          title: "虚与实",
          platforms: "x",
        })
      ).delivery,
      "auto",
    );
    await assert.rejects(
      importTask("video", path.join(dir, "片.mp4"), {
        ...opts,
        "cover-portrait": path.join(dir, "片.mp4"),
      }),
      /封面必须是图片/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
