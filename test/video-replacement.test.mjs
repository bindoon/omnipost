import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import {
  replacementAsset,
  replacementPlatform,
} from "../extension/shared/video-replacement.js";

const originalTitle = "十二经脉怎样衔接？";
const scheduledAt = "2099-11-22T17:00:00+08:00";
const xiaohongshuUrl =
  "https://creator.xiaohongshu.com/publish/update?id=000000000000000000000001&noteType=video";
const bilibiliUrl =
  "https://member.bilibili.com/platform/upload/video/frame?type=edit&bvid=BV1rNs86mEGf";
const asset = {
  id: "video",
  name: "新版.mp4",
  role: "video",
  size: 4,
  type: "video/mp4",
};
const source = (
  await fs.readFile(
    new URL("../extension/content/replacement.js", import.meta.url),
    "utf8",
  )
).replace(/^import.*;\s*/m, "");

function mount(url, html, platform = "xiaohongshu") {
  const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 100,
    height: 40,
  });
  const reads = [];
  const location = { href: url };
  const transfer = class {
    files = [];
    items = { add: (file) => this.files.push(file) };
  };
  let listener;
  vm.runInNewContext(source, {
    document,
    location,
    getComputedStyle: () => ({ visibility: "visible" }),
    replacementPlatform,
    Event: window.Event,
    File,
    DataTransfer: transfer,
    atob,
    setTimeout,
    chrome: {
      runtime: {
        id: "fixture",
        onMessage: { addListener: (handler) => (listener = handler) },
        async sendMessage(message) {
          reads.push(message);
          return { ok: true, chunk: "dmlkMA==" };
        },
      },
    },
  });
  function replace(overrides = {}) {
    const task = {
      id: "job",
      platform,
      title: originalTitle,
      url,
      at: scheduledAt,
      asset,
      ...overrides,
    };
    return new Promise((resolve) =>
      listener(
        { type: "UPLOAD_REPLACEMENT_VIDEO", task },
        { id: "fixture" },
        resolve,
      ),
    );
  }
  return { document, location, reads, replace };
}

function editorFields() {
  return `
    <textarea id="description">保留正文</textarea>
    <input id="collection" value="人体的河流">
    <img id="cover" src="original.png">
    <button id="save">保存</button>
  `;
}

function xiaohongshuEditor(uploader) {
  return `<input placeholder="填写标题" value="${originalTitle}">
      <input id="time" value="2099-11-22 17:00">
      ${uploader}${editorFields()}`;
}

test("仅允许真实来源的原预约编辑路由和带原预约时间的手动视频任务", () => {
  assert.equal(replacementPlatform(xiaohongshuUrl), "xiaohongshu");
  assert.equal(replacementPlatform(bilibiliUrl), "bilibili");
  assert.equal(
    replacementPlatform(bilibiliUrl.replace("type=edit", "type=new")),
    null,
  );
  assert.equal(
    replacementPlatform(
      bilibiliUrl.replace("bilibili.com", "bilibili.com.example"),
    ),
    null,
  );
  assert.equal(
    replacementPlatform(
      "https://creator.douyin.com/creator-micro/content/post/video?iid=1",
    ),
    null,
  );
  const job = {
    kind: "video",
    platforms: ["xiaohongshu"],
    delivery: "manual",
    schedule: { at: scheduledAt, submit: false },
    assets: [asset],
  };
  assert.equal(replacementAsset(job, "xiaohongshu", 0), asset);
  assert.equal(replacementAsset(job, "bilibili", 0), null);
  assert.equal(
    replacementAsset(job, "xiaohongshu", Date.parse(scheduledAt)),
    null,
  );
  assert.equal(
    replacementAsset(
      { ...job, schedule: { at: scheduledAt, submit: true } },
      "xiaohongshu",
      0,
    ),
    null,
  );
});

test("小红书只把文件交给唯一重新上传框，保留原预约字段", async () => {
  const { document, reads, replace } = mount(
    xiaohongshuUrl,
    xiaohongshuEditor(`
      <div><span>视频文件</span><button>重新上传</button><input id="replace" class="upload-input" type="file" accept=".mp4,.mov"></div>
      <input id="other" type="file" accept="video/*">
    `),
  );
  let changed = 0;
  let saved = 0;
  document.querySelector("#replace").onchange = () => changed++;
  document.querySelector("#save").onclick = () => saved++;
  assert.equal((await replace({ title: "另一条稿件" })).ok, false);
  assert.equal((await replace({ at: "2099-11-22T17:10:00+08:00" })).ok, false);
  assert.equal(reads.length, 0);
  assert.equal((await replace()).ok, true);
  assert.equal(changed, 1);
  assert.equal(
    await document.querySelector("#replace").files[0].text(),
    "vid0",
  );
  assert.equal(document.querySelector("#other").files, undefined);
  assert.equal(document.querySelector("#description").textContent, "保留正文");
  assert.equal(document.querySelector("#collection").value, "人体的河流");
  assert.equal(document.querySelector("#time").value, "2099-11-22 17:00");
  assert.equal(
    document.querySelector("#cover").getAttribute("src"),
    "original.png",
  );
  assert.equal(saved, 0);
});

test("小红书只对明确的单一重新上传框操作，重复或禁用控件会停下", async () => {
  const upload = (extra = "") =>
    `<div>视频文件 <button>重新上传</button><input class="upload-input" type="file" accept=".mp4" ${extra}></div>`;
  const duplicate = mount(
    xiaohongshuUrl,
    xiaohongshuEditor(upload() + upload()),
  );
  const disabled = mount(xiaohongshuUrl, xiaohongshuEditor(upload("disabled")));
  assert.equal((await duplicate.replace()).ok, false);
  assert.equal((await disabled.replace()).ok, false);
  assert.equal(duplicate.reads.length + disabled.reads.length, 0);
});

test("B 站捕获更换按钮实际触发的文件框，避开添加分 P", async () => {
  const { document, replace } = mount(
    bilibiliUrl,
    `<input placeholder="请输入稿件标题" value="${originalTitle}">
      <div class="time-container"><div class="switch-container switch-container-active"></div>
        <span class="date-show">2099-11-22</span><span class="date-show">17:00</span></div>
      <div class="date-picker-timezone-wrp"><input value="(UTC+08:00) Beijing"></div>
      <div class="operate-btns"><button class="icon-text-btn"><span>更换视频</span></button></div>
      <div class="bcc-upload-wrapper"><input id="append" type="file" accept="video/*"></div>
      <input id="replacement" type="file">
      ${editorFields()}`,
    "bilibili",
  );
  const replacement = document.querySelector("#replacement");
  const label = document.querySelector(".icon-text-btn > span");
  label.onclick = async () => {
    await Promise.resolve();
    replacement.click();
  };
  let replaced = 0;
  let saved = 0;
  replacement.onchange = () => replaced++;
  document.querySelector("#save").onclick = () => saved++;
  const result = await replace();
  assert.equal(result.ok, true, result.error);
  assert.equal(replaced, 1);
  assert.equal(document.querySelector("#append").files, undefined);
  assert.equal(saved, 0);
});
