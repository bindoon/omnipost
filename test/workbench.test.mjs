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
