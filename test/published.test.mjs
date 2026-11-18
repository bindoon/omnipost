import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import {
  compactTitle,
  titlesMatch,
  parseCount,
  matchPublished,
  formatLikes,
} from "../extension/shared/published.js";
import { worksUrl } from "../extension/shared/target.js";

test("标题去掉空白和话题后，截断的平台标题仍能对上，过短的不行", () => {
  assert.equal(
    compactTitle("经络的名字，其实是一个地址 #中医"),
    "经络的名字其实是一个地址",
  );
  assert.equal(
    titlesMatch("经络的名字，其实是一个地址", "经络的名字，其实是一个地址"),
    true,
  );
  assert.equal(
    titlesMatch("经络的名字，其实是一个地址", "经络的名字，其实是一个地"),
    true,
  );
  assert.equal(titlesMatch("手麻都是气血不通吗", "手麻"), false);
  assert.equal(titlesMatch("气血不通", "气血通畅的人不会手麻"), false);
  assert.equal(parseCount("1.2万"), 12000);
  assert.equal(parseCount("1,234"), 1234);
  assert.equal(formatLikes(12000), "1.2万赞");
  assert.equal(formatLikes(86), "86赞");
});

test("只有唯一标题才算已发布，撞标题或没有点赞文本都不误记", () => {
  const items = [
    { title: "经络的名字，其实是一个地址", likesText: "点赞 86" },
    { title: "另一条", likesText: "3.5万赞" },
    { title: "重复的标题", likesText: "1" },
    { title: "重复的标题", likesText: "2" },
  ];
  const matched = matchPublished(
    [
      { id: "a", title: "经络的名字，其实是一个地址" },
      { id: "b", title: "没有的标题啊" },
      { id: "c", title: "重复的标题" },
    ],
    items,
  );
  assert.equal(matched.a.found, true);
  assert.equal(matched.a.likes, 86);
  assert.equal(matched.b.found, false);
  assert.equal(matched.c.found, false);
  assert.match(matched.c.reason, /不唯一/);
});

test("作品列表读出标题和点赞，登录页不假装已经对上", async () => {
  const { document } = parseHTML(
    '<html><body><div class="video-item"><a class="title" href="https://www.bilibili.com/video/BV1">经络的名字，其实是一个地址</a><span>点赞 1.2万</span></div></body></html>',
  );
  const source = await fs.readFile(
    new URL("../extension/content/published.js", import.meta.url),
    "utf8",
  );
  let listener;
  vm.runInNewContext(source, {
    document,
    location: {
      hostname: "member.bilibili.com",
      pathname: "/platform/upload-manager/video",
      href: "https://member.bilibili.com/platform/upload-manager/video",
    },
    chrome: {
      runtime: {
        id: "ext",
        onMessage: { addListener: (fn) => (listener = fn) },
      },
      dom: {},
    },
    URL,
  });
  const page = await new Promise((resolve) =>
    listener({ type: "READ_WORKS" }, { id: "ext" }, resolve),
  );
  assert.equal(page.ok, true);
  assert.equal(page.items[0].title, "经络的名字，其实是一个地址");
  assert.equal(page.items[0].likesText, "1.2万");
  assert.equal(page.loggedOut, false);
  assert.equal(
    worksUrl("youtube", "https://studio.youtube.com/channel/UCabc/videos"),
    "https://studio.youtube.com/channel/UCabc/videos",
  );
});
