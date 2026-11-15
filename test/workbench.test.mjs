import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { parseHTML, DOMParser } from "linkedom";
import * as model from "../extension/shared/model.js";
import * as content from "../extension/shared/content.js";

test("四步界面保留独立平台标题与预览；普通网页预览不能提交真实草稿", async (t) => {
  const { document, window } = parseHTML(
    '<html><body><div id="app"></div></body></html>',
  );
  const saved = {
    title: "原标题",
    markdown: "# 原标题\n\n完整原文。",
    step: 1,
    assets: [],
    overrides: {},
  };
  const timers = [];
  const source = (
    await fs.readFile(
      new URL("../extension/workbench.js", import.meta.url),
      "utf8",
    )
  ).replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  const context = vm.createContext({
    document,
    window: { scrollTo() {} },
    location: { search: "", href: "http://127.0.0.1/workbench.html" },
    URL,
    URLSearchParams,
    crypto,
    console,
    ...model,
    extractTitle: content.extractTitle,
    imagePaths: content.imagePaths,
    renderArticle: (md, assets) => content.renderArticle(md, assets, DOMParser),
    get: async () => undefined,
    put: async () => {},
    localStorage: { getItem: () => JSON.stringify(saved), setItem() {} },
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, ms);
      timers.push(id);
      return id;
    },
    clearTimeout,
  });
  t.after(() => timers.forEach(clearTimeout));
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  assert.equal(document.querySelectorAll("[data-step]").length, 4);
  document.querySelector("[data-action=next]").click();
  document.querySelector("[data-tailor=x]").click();
  const field = document.querySelector("#platform-title");
  field.value = "X专属标题";
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(
    document.querySelector("#platform-preview h1").textContent,
    "X专属标题",
  );
  document.querySelector("[data-tailor=wechat]").click();
  assert.equal(document.querySelector("#platform-title").value, "原标题");
  assert.equal(
    document.querySelector("#platform-preview h1").textContent,
    "原标题",
  );
  document.querySelector("[data-action=next]").click();
  assert.equal(
    document.querySelector("[data-action=push]").hasAttribute("disabled"),
    true,
  );
  assert.match(document.querySelector("#app").textContent, /当前是界面预览/);
});

test("完整工作台先按视频或文章列出平台状态", async () => {
  const { document, window } = parseHTML(
    '<html><body><div id="app"></div></body></html>',
  );
  const source = (
    await fs.readFile(
      new URL("../extension/workbench.js", import.meta.url),
      "utf8",
    )
  ).replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  vm.runInContext(
    source,
    vm.createContext({
      document,
      window: { scrollTo() {} },
      location: { search: "", href: "http://127.0.0.1/workbench.html" },
      URL,
      URLSearchParams,
      crypto,
      console,
      ...model,
      extractTitle: content.extractTitle,
      imagePaths: content.imagePaths,
      renderArticle: (md, assets) =>
        content.renderArticle(md, assets, DOMParser),
      get: async () => undefined,
      put: async () => {},
      localStorage: { getItem: () => null, setItem() {} },
      setTimeout,
      clearTimeout,
    }),
  );
  await new Promise(setImmediate);
  assert.equal(
    document
      .querySelector("[data-library=video]")
      .getAttribute("aria-selected"),
    "true",
  );
  assert.equal(document.querySelectorAll("[data-step]").length, 0);
  assert.match(document.body.textContent, /还没有视频/);
  document.querySelector("[data-library=article]").click();
  assert.match(document.body.textContent, /还没有文章/);
  document.querySelector("[data-action=compose]").click();
  assert.equal(document.querySelectorAll("[data-step]").length, 4);
});

test("视频读不到时列表显示封面，并可以删除这条草稿", async () => {
  const { document, window } = parseHTML(
    '<html><body><div id="app"></div></body></html>',
  );
  const jobs = [
    {
      id: "v1",
      kind: "video",
      title: "虚与实到底是什么",
      description: "虚，就是气血少",
      createdAt: "2026-11-14T00:00:00.000Z",
      platforms: ["channels"],
      results: { channels: { state: "ready", message: "待填充" } },
      assets: [
        {
          id: "vid",
          role: "video",
          name: "a.mp4",
          type: "video/mp4",
          size: 100,
        },
        {
          id: "cover-1",
          role: "cover-portrait",
          name: "c.png",
          type: "image/png",
          size: 10,
        },
      ],
    },
    {
      id: "x-reply-1",
      kind: "x_reply",
      title: "回复 @frankqianchen",
      description: "一条待审回复",
      createdAt: "2026-11-09T02:15:18.000Z",
      targetUrl: "https://x.com/frankqianchen/status/1",
      platforms: ["x"],
      results: { x: { state: "review_ready", message: "待审阅" } },
      assets: [],
    },
  ];
  const deleted = [];
  const source = (
    await fs.readFile(
      new URL("../extension/workbench.js", import.meta.url),
      "utf8",
    )
  ).replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  class PreviewURL extends URL {
    static createObjectURL() {
      return "blob:cover";
    }
    static revokeObjectURL() {}
  }
  vm.runInContext(
    source,
    vm.createContext({
      document,
      window: { scrollTo() {} },
      location: { search: "", href: "http://127.0.0.1/workbench.html" },
      URL: PreviewURL,
      URLSearchParams,
      crypto,
      console,
      Blob,
      ...model,
      extractTitle: content.extractTitle,
      imagePaths: content.imagePaths,
      renderArticle: (md, assets) =>
        content.renderArticle(md, assets, DOMParser),
      get: async (store, id) =>
        store === "assets" && id === "cover-1"
          ? new Blob(["png"], { type: "image/png" })
          : undefined,
      put: async () => {},
      localStorage: { getItem: () => null, setItem() {} },
      setTimeout,
      clearTimeout,
      chrome: {
        runtime: {
          id: "a".repeat(32),
          async sendMessage(message) {
            if (message.type === "DELETE_JOB") {
              deleted.push(message.id);
              jobs.splice(0, jobs.length);
            }
            if (message.type === "STATE")
              return { ok: true, jobs, bridge: { connected: false } };
            return { ok: true };
          },
        },
        storage: {
          local: {
            async get() {
              return {};
            },
            set() {},
          },
          onChanged: { addListener() {} },
        },
      },
    }),
  );
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(document.querySelector('[aria-label="X 回复待审阅"]'), null);
  assert.doesNotMatch(document.body.textContent, /回复 @frankqianchen/);
  const preview = document.querySelector("[data-preview-for=v1]");
  assert.equal(preview.querySelector("img").getAttribute("src"), "blob:cover");
  assert.match(preview.textContent, /浏览器里没有这份视频/);
  const button = document.querySelector("[data-delete=v1]");
  button.click();
  assert.equal(button.textContent, "确认删除");
  assert.deepEqual(deleted, []);
  button.click();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(deleted, ["v1"]);
  assert.match(document.body.textContent, /还没有视频/);
});

test("公众号填充失败后可从内容列表复制标题和正文，编辑预览同样保留复制按钮", async (t) => {
  const { document, window } = parseHTML(
    '<html><body><div id="app"></div></body></html>',
  );
  const article = {
    id: "wx-copy",
    kind: "article",
    title: "原始标题",
    markdown: "# 原始标题\n\n末段。",
    description: "摘要",
    createdAt: "2026-11-15T00:00:00.000Z",
    platforms: ["wechat"],
    bridgeJob: true,
    overrides: { wechat: { title: "公众号标题" } },
    assets: [{ id: "image", name: "image.png", type: "image/png" }],
    results: { wechat: { state: "failed", message: "填充失败" } },
  };
  const copied = [],
    reads = [],
    timers = [];
  const source = (
    await fs.readFile(
      new URL("../extension/workbench.js", import.meta.url),
      "utf8",
    )
  ).replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  vm.runInNewContext(source, {
    document,
    window: { scrollTo() {} },
    location: { search: "", href: "chrome-extension://ext/workbench.html" },
    URL,
    URLSearchParams,
    crypto,
    console,
    Blob,
    atob,
    Uint8Array,
    ...model,
    extractTitle: content.extractTitle,
    imagePaths: content.imagePaths,
    renderArticle: (md, assets) => content.renderArticle(md, assets, DOMParser),
    copyArticleTitle: async (item) => copied.push(item.overrides.wechat.title),
    copyWechatArticle: async (item, options) => {
      copied.push({ id: item.id, images: options.images });
      if (options.images)
        assert.equal(
          await (await options.readAsset(item.assets[0])).text(),
          "image bytes",
        );
    },
    get: async () => undefined,
    put: async () => {},
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, ms);
      timers.push(id);
      return id;
    },
    clearTimeout,
    chrome: {
      runtime: {
        id: "ext",
        sendMessage: async (message) => {
          if (message.type === "STATE")
            return { ok: true, jobs: [article], bridge: { connected: false } };
          if (message.type === "UI_ASSET") {
            reads.push(message.id);
            return { ok: true, chunks: [btoa("image bytes")] };
          }
          return { ok: true };
        },
      },
      storage: {
        local: {
          get: async () => ({ workbench: { libraryKind: "article" } }),
          set() {},
        },
        onChanged: { addListener() {} },
      },
    },
  });
  t.after(() => timers.forEach(clearTimeout));
  await new Promise(setImmediate);
  assert.match(document.body.textContent, /填充失败/);
  const preview = document.querySelector('[data-article-preview="wx-copy"]');
  assert.equal(preview.querySelector("h1").textContent, "公众号标题");
  assert.match(preview.textContent, /末段。/);
  assert.ok(
    preview
      .closest(".article-card-layout")
      .querySelector(".article-controls [data-copy-mode=body]"),
  );
  for (const mode of ["title", "body", "no-images"]) {
    document
      .querySelector(`[data-copy-article="wx-copy"][data-copy-mode="${mode}"]`)
      .click();
    await new Promise(setImmediate);
  }
  assert.equal(copied[0], "公众号标题");
  assert.equal(copied[1].images, true);
  assert.equal(copied[2].images, false);
  assert.deepEqual(reads, ["wx-copy"]);
  assert.match(
    document.querySelector('[role="status"]').textContent,
    /已复制无图正文/,
  );
  document.querySelector('[data-history="wx-copy"]').click();
  await new Promise(setImmediate);
  assert.ok(
    document.querySelector(
      '[data-copy-article="current"][data-copy-mode="body"]',
    ),
  );
  const title = document.querySelector("#platform-title");
  title.value = "调整后的标题";
  title.dispatchEvent(new window.Event("input", { bubbles: true }));
  document
    .querySelector('[data-copy-article="current"][data-copy-mode="title"]')
    .click();
  await new Promise(setImmediate);
  assert.equal(copied.at(-1), "调整后的标题");
});
