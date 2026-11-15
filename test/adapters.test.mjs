import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { parseHTML, DOMParser } from "linkedom";
const source = await fs.readFile(
  new URL("../extension/content/runner.js", import.meta.url),
  "utf8",
);
async function run({
  imageFailure = false,
  saveFailure = false,
  auth = true,
} = {}) {
  const { document } = parseHTML(
    "<html><body><main>公众号后台</main></body></html>",
  );
  const calls = [];
  let listener;
  const chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          listener = fn;
        },
      },
      async sendMessage(m) {
        if (m.type === "ASSET")
          return {
            ok: true,
            chunk: Buffer.from("image bytes").toString("base64"),
          };
        return { ok: true };
      },
    },
  };
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    if (url === "/")
      return {
        text: async () =>
          auth
            ? 'data: {t: "demo-token"}; user_name: "demo-user"; ticket: "demo-ticket"; time: "123"'
            : "login page",
      };
    if (url.startsWith("/cgi-bin/filetransfer"))
      return {
        json: async () =>
          imageFailure
            ? { base_resp: { ret: 1, err_msg: "image error" } }
            : {
                base_resp: { ret: 0 },
                cdn_url: "https://mmbiz.qpic.cn/demo.jpg",
              },
      };
    if (url.startsWith("/cgi-bin/operate_appmsg")) {
      if (saveFailure) throw new Error("network disconnected");
      return {
        json: async () => ({ appMsgId: "987654321", base_resp: { ret: 0 } }),
      };
    }
    throw new Error("Unexpected network call " + url);
  };
  const context = vm.createContext({
    document,
    location: {
      origin: "https://mp.weixin.qq.com",
      pathname: "/",
      href: "https://mp.weixin.qq.com/",
    },
    chrome,
    fetch: fakeFetch,
    DOMParser,
    File,
    FormData,
    URLSearchParams,
    URL,
    Date,
    console,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    atob,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  });
  vm.runInContext(source, context);
  const task = {
    id: "fixture",
    kind: "article",
    platform: "wechat",
    title: "图文标题",
    description: "摘要",
    assets: [
      {
        id: "image-1",
        name: "city.jpg",
        size: 11,
        type: "image/jpeg",
        role: "image",
      },
    ],
    prepared: {
      wechat:
        '<p style="font-size:20px"><strong>制作过程</strong></p><p>正文</p><p><img data-asset-id="image-1" src="publisher-asset:image-1"></p>',
      media: [{ id: "image-1", alt: "截图" }],
    },
  };
  const response = await new Promise((resolve) =>
    listener({ type: "RUN_DRAFT", task }, {}, resolve),
  );
  return { response, calls };
}
test("微信适配器先上传真实图片，再保存图文草稿，并返回平台草稿ID；没有公开发布请求", async () => {
  const { response, calls } = await run();
  assert.equal(response.result.state, "draft_ready");
  assert.equal(response.result.postId, "987654321");
  const upload = calls.find((c) => c.url.includes("filetransfer"));
  assert.equal(await upload.options.body.get("file").text(), "image bytes");
  const save = calls.find((c) => c.url.includes("operate_appmsg"));
  assert.equal(save.options.body.get("title0"), "图文标题");
  const html = save.options.body.get("content0");
  assert.match(html, /https:\/\/mmbiz.qpic.cn\/demo.jpg/);
  assert.doesNotMatch(html, /publisher-asset:/);
  assert.match(html, /font-size:20px/);
  assert.equal(calls.filter((c) => c.url.includes("operate_appmsg")).length, 1);
  assert.ok(calls.every((c) => !/(masssend|mass_send|publish)/i.test(c.url)));
});
test("配图上传失败时，不创建缺图草稿，也不报告保存成功", async () => {
  const { response, calls } = await run({ imageFailure: true });
  assert.equal(response.result.state, "needs_attention");
  assert.equal(response.result.persisted, false);
  assert.ok(!calls.some((c) => c.url.includes("operate_appmsg")));
});
test("保存响应中断时停在需检查状态，不自动重发创建请求", async () => {
  const { response, calls } = await run({ saveFailure: true });
  assert.equal(response.result.state, "needs_attention");
  assert.match(response.result.message, /避免重复创建/);
  assert.equal(calls.filter((c) => c.url.includes("operate_appmsg")).length, 1);
});
test("未登录时只读取登录页面，不上传图片或创建草稿", async () => {
  const { response, calls } = await run({ auth: false });
  assert.equal(response.result.state, "needs_attention");
  assert.equal(calls.length, 1);
});

for (const withImage of [false, true])
  test(
    withImage
      ? "小红书上传后使用原生图片块一次写入全文，末段与图片数量保持完整"
      : "编辑器异步接收富文本时，等待正文完整出现后才保存草稿",
    async () => {
      const { document, window } = parseHTML(
        '<html><body><span id="draft-count">草稿箱(0)</span><textarea placeholder="输入标题"></textarea><div contenteditable="true" class="tiptap"></div><button id="save">暂存离开</button></body></html>',
      );
      window.HTMLElement.prototype.getBoundingClientRect = () => ({
        width: 100,
        height: 30,
        left: 0,
        top: 0,
        right: 100,
        bottom: 30,
      });
      window.HTMLElement.prototype.focus = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      document.createRange = () => ({ selectNodeContents() {}, collapse() {} });
      const editor = document.querySelector("[contenteditable]");
      let saves = 0,
        listener;
      document.execCommand = (name) => {
        if (name === "delete") editor.innerHTML = "";
        return true;
      };
      editor.addEventListener("paste", (event) => {
        event.preventDefault();
        setTimeout(() => {
          if (event.clipboardData.files.length)
            editor.innerHTML +=
              '<div data-dom-type="image" contenteditable="false"><img src="https://xhscdn.com/fixture.jpg"></div>';
          else editor.innerHTML = event.clipboardData.getData("text/html");
        }, 20);
      });
      document.querySelector("#save").addEventListener("click", () => {
        saves++;
        document.querySelector("#draft-count").textContent = "草稿箱(1)";
        const card = document.createElement("div");
        card.className = "draft-item";
        card.setAttribute("data-draft-id", "native-id");
        card.innerHTML =
          '<span class="draft-title-text">测试草稿</span><div class="btn">编辑</div>';
        card.querySelector(".btn").onclick = () => {
          document.querySelector("textarea").value = "测试草稿";
        };
        document.body.append(card);
      });
      class Transfer {
        constructor() {
          this.values = new Map();
          this.files = [];
          this.items = { add: (f) => this.files.push(f) };
        }
        setData(k, v) {
          this.values.set(k, v);
        }
        getData(k) {
          return this.values.get(k) || "";
        }
      }
      class ClipEvent extends window.Event {
        constructor(type, opts) {
          super(type, opts);
          this.clipboardData = opts.clipboardData;
        }
      }
      class Input extends window.Event {
        constructor(type, opts) {
          super(type, opts);
        }
      }
      let saveRoot;
      if (withImage) {
        const host = document.createElement("xhs-publish-btn");
        saveRoot = host.attachShadow({ mode: "closed" });
        saveRoot.append(document.querySelector("#save"));
        document.body.append(host);
      }
      const context = vm.createContext({
        document,
        location: {
          origin: "https://creator.xiaohongshu.com",
          pathname: "/publish/publish",
          href: "https://creator.xiaohongshu.com/publish/publish",
        },
        chrome: {
          dom: { openOrClosedShadowRoot: () => saveRoot },
          runtime: {
            onMessage: {
              addListener(fn) {
                listener = fn;
              },
            },
            sendMessage: async (m) =>
              m.type === "ASSET"
                ? { ok: true, chunk: Buffer.from("image").toString("base64") }
                : { ok: true },
          },
        },
        DOMParser,
        File,
        atob,
        DataTransfer: Transfer,
        ClipboardEvent: ClipEvent,
        InputEvent: Input,
        Event: window.Event,
        HTMLTextAreaElement: window.HTMLTextAreaElement,
        HTMLInputElement: window.HTMLInputElement,
        getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Date,
        console,
      });
      vm.runInContext(source, context);
      const html =
        "<p>这是异步接收的完整正文。</p><h2>章节标题</h2>" +
        (withImage ? "<p><span>【待插入配图 1】</span></p>" : "") +
        "<p>最后一段也必须保留。</p>";
      const response = await new Promise((resolve) =>
        listener(
          {
            type: "RUN_DRAFT",
            task: {
              id: "delayed",
              kind: "article",
              platform: "xiaohongshu",
              title: "测试草稿",
              assets: withImage
                ? [
                    {
                      id: "picture",
                      name: "city.jpg",
                      type: "image/jpeg",
                      size: 5,
                    },
                  ]
                : [],
              prepared: {
                xiaohongshu: html,
                media: withImage ? [{ id: "picture" }] : [],
              },
            },
          },
          {},
          resolve,
        ),
      );
      assert.equal(
        response.result.state,
        "draft_ready",
        response.result.message,
      );
      assert.equal(saves, 1);
      assert.equal(editor.querySelectorAll("img").length, withImage ? 1 : 0);
      assert.match(editor.textContent, /最后一段也必须保留/);
    },
  );

for (const misplace of [false, true])
  test(
    misplace
      ? "平台把配图放错位置时，保留草稿并拒绝报告成功"
      : "X 零高度弹窗与可拖动媒体块仍能按顺序保存正文和图片",
    async () => {
      const { document, window } = parseHTML(
        '<html><body><span>Draft Last saved just now</span><textarea placeholder="Add a title"></textarea><div contenteditable="true" data-testid="composer"></div><button>Insert</button><div role="menuitem">Media</div><div role="dialog"><button>Add photos or video</button><input type="file" accept="image/jpeg,image/png"></div></body></html>',
      );
      window.HTMLElement.prototype.getBoundingClientRect = function () {
        return {
          width: 100,
          height: this.getAttribute("role") === "dialog" ? 0 : 30,
          left: 0,
          top: 0,
          right: 100,
          bottom: 30,
        };
      };
      window.HTMLElement.prototype.focus = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      let selected, listener;
      document.createRange = () => ({
        selectNodeContents(el) {
          selected = el;
        },
        collapse() {},
      });
      document.execCommand = (name) => {
        if (name === "delete") selected.textContent = "";
        return true;
      };
      const editor = document.querySelector("[contenteditable]");
      editor.addEventListener("paste", (e) => {
        e.preventDefault();
        editor.innerHTML += e.clipboardData.getData("text/html");
      });
      document
        .querySelector("input[type=file]")
        .addEventListener("change", () => {
          const img = document.createElement("img");
          img.src = "https://pbs.twimg.com/media/fixture.jpg";
          const wrapper = document.createElement("div");
          wrapper.setAttribute("role", "button");
          const media = document.createElement("section");
          media.setAttribute("contenteditable", "false");
          media.append(img);
          wrapper.append(media);
          if (misplace) editor.prepend(wrapper);
          else editor.append(wrapper);
        });
      class Transfer {
        constructor() {
          this.values = new Map();
          this.files = [];
          this.items = { add: (f) => this.files.push(f) };
        }
        setData(k, v) {
          this.values.set(k, v);
        }
        getData(k) {
          return this.values.get(k) || "";
        }
      }
      class Clip extends window.Event {
        constructor(type, opts) {
          super(type, opts);
          this.clipboardData = opts.clipboardData;
        }
      }
      class Input extends window.Event {
        constructor(type, opts) {
          super(type, opts);
        }
      }
      class FastDate extends Date {
        static now() {
          return Date.now() * 100;
        }
      }
      const context = vm.createContext({
        document,
        location: {
          origin: "https://x.com",
          pathname: "/compose/articles/edit/123",
          href: "https://x.com/compose/articles/edit/123",
        },
        chrome: {
          runtime: {
            onMessage: {
              addListener(fn) {
                listener = fn;
              },
            },
            sendMessage: async (m) =>
              m.type === "ASSET"
                ? {
                    ok: true,
                    chunk: Buffer.from("image bytes").toString("base64"),
                  }
                : { ok: true },
          },
        },
        DOMParser,
        File,
        DataTransfer: Transfer,
        ClipboardEvent: Clip,
        InputEvent: Input,
        Event: window.Event,
        HTMLTextAreaElement: window.HTMLTextAreaElement,
        HTMLInputElement: window.HTMLInputElement,
        getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        requestAnimationFrame: (cb) => setTimeout(cb, 0),
        atob,
        Date: FastDate,
        console,
      });
      vm.runInContext(source, context);
      const response = await new Promise((resolve) =>
        listener(
          {
            type: "RUN_DRAFT",
            task: {
              id: "dialog",
              kind: "article",
              platform: "x",
              title: "测试草稿",
              assets: [
                {
                  id: "picture",
                  name: "city.jpg",
                  type: "image/jpeg",
                  size: 11,
                },
              ],
              prepared: {
                x: "<p>完整正文</p><p><span>【待插入配图 1】</span></p><p>最后一段</p>",
                media: [{ id: "picture", alt: "图" }],
              },
            },
          },
          {},
          resolve,
        ),
      );
      if (misplace) {
        assert.equal(response.result.state, "needs_attention");
        assert.match(response.result.message, /配图位置校验/);
        return;
      }
      assert.equal(
        response.result.state,
        "draft_ready",
        response.result.message,
      );
      assert.equal(editor.querySelectorAll("img").length, 1);
      assert.match(editor.textContent, /最后一段/);
      assert.equal(
        editor.querySelector("img").closest("[role=button]")
          .previousElementSibling.textContent,
        "完整正文",
      );
      assert.equal(
        editor.querySelector("img").closest("[role=button]").nextElementSibling
          .textContent,
        "最后一段",
      );
    },
  );

test("X 视频上传不受字数进度圈阻塞，文案只写一次，保存后才返回草稿", async () => {
  const { document, window } = parseHTML(
    '<html><body><input type="file" accept="video/mp4"><video></video><span>video.mp4: Ready</span><div role="progressbar"></div><div data-testid="tweetTextarea_0" contenteditable="true"></div><button data-testid="app-bar-close">Close</button></body></html>',
  );
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 100,
    height: 30,
  });
  window.HTMLElement.prototype.focus = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(document.body, "innerText", {
    get() {
      return this.textContent;
    },
  });
  document.createRange = () => ({ selectNodeContents() {}, collapse() {} });
  const editor = document.querySelector("[contenteditable]");
  let listener, savedText;
  document.execCommand = (name, _, value) => {
    editor.textContent = value;
    editor.dispatchEvent(new window.Event("input", { bubbles: true }));
    return true;
  };
  editor.addEventListener("input", (e) => {
    if (e.data) editor.textContent += e.data;
  });
  editor.addEventListener("paste", (e) => {
    e.preventDefault();
    editor.innerHTML = e.clipboardData.getData("text/html");
  });
  document.querySelector("button").onclick = () => {
    const save = document.createElement("button");
    save.textContent = "Save";
    document.body.append(save);
    save.onclick = () => {
      savedText = editor.textContent;
      context.location.pathname = "/home";
      document.body.innerHTML = '<a href="/compose/post">Post</a>';
      document.querySelector("a").onclick = () => {
        const drafts = document.createElement("button");
        drafts.textContent = "Drafts";
        drafts.onclick = () => {
          const row = document.createElement("button");
          row.innerHTML =
            '<div data-testid="unsentTweet"><span data-testid="tweetText">仅保存一次的文案</span><a href="https://pbs.twimg.com/amplify_video_thumb/123/img/fixture.jpg"></a></div>';
          document.body.append(row);
        };
        document.body.append(drafts);
      };
    };
  };
  class Transfer {
    constructor() {
      this.values = new Map();
      this.files = [];
      this.items = { add: (f) => this.files.push(f) };
    }
    setData(k, v) {
      this.values.set(k, v);
    }
    getData(k) {
      return this.values.get(k) || "";
    }
  }
  class Clip extends window.Event {
    constructor(type, opts) {
      super(type, opts);
      this.clipboardData = opts.clipboardData;
    }
  }
  class Input extends window.Event {
    constructor(type, opts) {
      super(type, opts);
      this.data = opts.data;
    }
  }
  const context = vm.createContext({
    document,
    location: {
      origin: "https://x.com",
      pathname: "/compose/post",
      href: "https://x.com/compose/post",
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
        sendMessage: async (m) =>
          m.type === "ASSET"
            ? { ok: true, chunk: Buffer.from("video").toString("base64") }
            : { ok: true },
      },
    },
    File,
    ClipboardEvent: Clip,
    DataTransfer: Transfer,
    InputEvent: Input,
    Event: window.Event,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    atob,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    console,
  });
  vm.runInContext(source, context);
  const response = await new Promise((resolve) =>
    listener(
      {
        type: "RUN_DRAFT",
        task: {
          id: "video",
          kind: "video",
          platform: "x",
          title: "视频测试",
          description: "仅保存一次的文案",
          assets: [
            {
              id: "video",
              role: "video",
              name: "video.mp4",
              type: "video/mp4",
              size: 5,
            },
          ],
        },
      },
      {},
      resolve,
    ),
  );
  assert.equal(response.result.state, "draft_ready", response.result.message);
  assert.equal(savedText, "仅保存一次的文案");
  assert.match(response.result.draftUrl, /unsent\/drafts/);
});

test("小红书视频等上传封面就绪后再填文案，并通过组件内按钮保存对应草稿ID", async () => {
  const { document, window } = parseHTML(
    '<html><body><span>草稿箱(0)</span><input type="file" accept="video/mp4"><input placeholder="填写标题"><div contenteditable="true"></div><xhs-publish-btn save-disabled="true"></xhs-publish-btn></body></html>',
  );
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 100,
    height: 30,
  });
  window.HTMLElement.prototype.focus = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(document.body, "innerText", {
    get() {
      return this.textContent;
    },
  });
  document.createRange = () => ({ selectNodeContents() {} });
  const title = document.querySelector("input[placeholder]"),
    editor = document.querySelector("[contenteditable]"),
    host = document.querySelector("xhs-publish-btn");
  const root = host.attachShadow({ mode: "closed" }),
    save = document.createElement("button");
  save.textContent = "暂存离开";
  root.append(save);
  let listener, saved;
  document.execCommand = (_, __, value) => {
    editor.textContent = value;
    return true;
  };
  document.querySelector("input[type=file]").onchange = () => {
    setTimeout(() => {
      title.value = "";
      editor.textContent = "";
    }, 20);
    setTimeout(() => {
      const cover = document.createElement("div");
      cover.setAttribute(
        "style",
        "background-image:url(https://xhscdn.com/spectrum/fixture)",
      );
      document.body.append(cover);
      host.setAttribute("save-disabled", "false");
    }, 100);
  };
  save.onclick = () => {
    saved = { title: title.value, text: editor.textContent };
    document.body.innerHTML =
      '<span>草稿保存成功</span><div class="draft-item" data-draft-id="video-native"><span class="draft-title-text">视频验收</span></div>';
  };
  class Transfer {
    constructor() {
      this.files = [];
      this.items = { add: (f) => this.files.push(f) };
    }
  }
  class Input extends window.Event {
    constructor(type, opts) {
      super(type, opts);
      this.data = opts.data;
    }
  }
  const context = vm.createContext({
    document,
    location: {
      origin: "https://creator.xiaohongshu.com",
      pathname: "/publish/publish",
      href: "https://creator.xiaohongshu.com/publish/publish",
    },
    chrome: {
      dom: { openOrClosedShadowRoot: () => root },
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
        sendMessage: async (m) =>
          m.type === "ASSET"
            ? { ok: true, chunk: Buffer.from("video").toString("base64") }
            : { ok: true },
      },
    },
    File,
    DataTransfer: Transfer,
    InputEvent: Input,
    Event: window.Event,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    atob,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    console,
  });
  vm.runInContext(source, context);
  const response = await new Promise((resolve) =>
    listener(
      {
        type: "RUN_DRAFT",
        task: {
          id: "xhs-video",
          kind: "video",
          platform: "xiaohongshu",
          title: "视频验收",
          description: "完整的视频文案",
          aiGenerated: true,
          assets: [
            {
              id: "v",
              role: "video",
              name: "video.mp4",
              type: "video/mp4",
              size: 5,
            },
          ],
        },
      },
      {},
      resolve,
    ),
  );
  assert.equal(response.result.state, "draft_ready", response.result.message);
  assert.deepEqual(saved, { title: "视频验收", text: "完整的视频文案" });
  assert.equal(response.result.postId, "video-native");
  assert.match(response.result.warnings[0], /AI 内容声明/);
});
