import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { parseHTML, DOMParser } from "linkedom";
const source = await fs.readFile(
  new URL("../extension/content/runner.js", import.meta.url),
  "utf8",
);
const wechatEditor =
  "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=10&token=session-token&lang=zh_CN";
async function runWechat({
  imageFailure = false,
  auth = true,
  existing = "",
  href = wechatEditor,
  withImage = true,
  pasteFailure = false,
  iframe = false,
} = {}) {
  const { document, window } = parseHTML(
    `<html><body><textarea id="title">${existing}</textarea><textarea id="js_description"></textarea><div id="js_editor"><div class="ProseMirror" contenteditable="true"></div></div><button>保存为草稿</button><button>发表</button></body></html>`,
  );
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 100,
    height: 30,
  });
  window.HTMLElement.prototype.focus = () => {};
  let editor = document.querySelector(".ProseMirror");
  let editorDocument = document;
  if (iframe) {
    const inner = parseHTML(
      '<html><body contenteditable="true"></body></html>',
    );
    editorDocument = inner.document;
    editor = inner.document.body;
    Object.defineProperty(editor, "isContentEditable", { value: true });
    const frame = document.createElement("iframe");
    frame.id = "ueditor_0";
    Object.defineProperty(frame, "contentDocument", { value: editorDocument });
    document.querySelector("#js_editor").replaceChildren(frame);
  }
  editorDocument.createRange = () => ({
    selectNodeContents() {},
    collapse() {},
  });
  editorDocument.execCommand = () => false;
  editor.addEventListener("paste", (event) => {
    event.preventDefault();
    if (!pasteFailure)
      editor.innerHTML = event.clipboardData.getData("text/html");
  });
  class Transfer {
    constructor() {
      this.values = new Map();
    }
    setData(k, v) {
      this.values.set(k, v);
    }
    getData(k) {
      return this.values.get(k) || "";
    }
  }
  class ClipEvent extends window.Event {
    constructor(type, options) {
      super(type, options);
      this.clipboardData = options.clipboardData;
    }
  }
  const calls = [];
  let listener,
    buttonClicks = 0;
  document
    .querySelectorAll("button")
    .forEach((button) => (button.onclick = () => buttonClicks++));
  const context = vm.createContext({
    document,
    location: {
      origin: new URL(href).origin,
      pathname: new URL(href).pathname,
      href,
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => (listener = fn) },
        sendMessage: async (m) =>
          m.type === "ASSET"
            ? { ok: true, chunk: Buffer.from("image bytes").toString("base64") }
            : { ok: true },
      },
    },
    fetch: async (url, options) => {
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
      throw new Error("Unexpected network call " + url);
    },
    DOMParser,
    File,
    FormData,
    URLSearchParams,
    URL,
    console,
    atob,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLInputElement: window.HTMLInputElement,
    InputEvent: window.Event,
    Event: window.Event,
    ClipboardEvent: ClipEvent,
    DataTransfer: Transfer,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    setInterval,
    clearInterval,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
    Date: class extends Date {
      static current = Date.now();
      static now() {
        return (this.current += 400);
      }
    },
  });
  vm.runInContext(source, context);
  const task = {
    id: "fixture",
    kind: "article",
    platform: "wechat",
    title: "图文标题",
    description: "摘要",
    fillOnly: true,
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
        '<p style="font-size:20px"><strong>制作过程</strong></p><p>正文</p>' +
        (withImage
          ? '<p><img data-asset-id="image-1" src="publisher-asset:image-1"></p>'
          : ""),
      media: withImage ? [{ id: "image-1", alt: "截图" }] : [],
    },
  };
  const response = await new Promise((resolve) =>
    listener({ type: "RUN_DRAFT", task }, {}, resolve),
  );
  return { response, calls, document, editor, buttonClicks };
}
for (const iframe of [false, true])
  test(`微信新文章${iframe ? " iframe" : ""}编辑器填入排版正文和已上传配图，不调用旧图文创建接口`, async () => {
    const { response, calls, document, editor, buttonClicks } = await runWechat(
      { iframe },
    );
    assert.equal(response.result.state, "needs_attention");
    assert.equal(response.result.persisted, false);
    assert.match(response.result.message, /已填入公众号新文章/);
    assert.equal(document.querySelector("#title").value, "图文标题");
    assert.equal(document.querySelector("#js_description").value, "摘要");
    assert.match(editor.innerHTML, /https:\/\/mmbiz.qpic.cn\/demo.jpg/);
    assert.match(editor.innerHTML, /font-size:20px/);
    assert.doesNotMatch(editor.innerHTML, /publisher-asset:/);
    assert.equal(
      await calls
        .find((c) => c.url.includes("filetransfer"))
        .options.body.get("file")
        .text(),
      "image bytes",
    );
    assert.equal(buttonClicks, 0);
    assert.ok(
      calls.every(
        (c) => !/operate_appmsg|masssend|mass_send|publish/i.test(c.url),
      ),
    );
  });
test("配图上传失败时不写入缺图文章，并保留手动复制入口", async () => {
  const { response, calls, editor, document } = await runWechat({
    imageFailure: true,
  });
  assert.equal(response.result.state, "needs_attention");
  assert.match(response.result.message, /图片上传失败/);
  assert.equal(editor.textContent, "");
  assert.equal(document.querySelector("#title").value, "");
  assert.equal(calls.length, 2);
});
test("公众号已有内容时在上传前停止，不覆盖用户修改", async () => {
  const { response, calls, document } = await runWechat({
    existing: "手改标题",
  });
  assert.match(response.result.message, /已有内容/);
  assert.equal(calls.length, 0);
  assert.equal(document.querySelector("#title").value, "手改标题");
});
test("微信旧图文编辑器和草稿列表均要求进入新的创作 → 文章", async () => {
  for (const href of [
    "https://mp.weixin.qq.com/",
    wechatEditor
      .replace("appmsg_edit_v2", "appmsg_edit")
      .replace("type=10", "type=77"),
    wechatEditor + "&appmsgid=1",
  ]) {
    const { response, calls } = await runWechat({ href });
    assert.match(response.result.message, /新的创作 → 文章/);
    assert.equal(calls.length, 0);
  }
});
test("微信正文粘贴失败时明确要求检查，不报告已填充或保存", async () => {
  const { response } = await runWechat({ pasteFailure: true });
  assert.equal(response.result.state, "needs_attention");
  assert.equal(response.result.persisted, false);
  assert.match(response.result.message, /没有接收完整富文本/);
});
test("公众号无配图文章不依赖图片上传凭据", async () => {
  const { response, calls } = await runWechat({
    withImage: false,
    auth: false,
  });
  assert.match(response.result.message, /已填入公众号新文章/);
  assert.equal(calls.length, 0);
});
test("公众号图片上传凭据失效时不上传或创建草稿", async () => {
  const { response, calls } = await runWechat({ auth: false });
  assert.equal(response.result.state, "needs_attention");
  assert.match(response.result.message, /复制微信正文/);
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

function mountRunner(href) {
  const { document, window } = parseHTML("<html><body></body></html>");
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 120,
    height: 36,
  });
  window.HTMLElement.prototype.focus = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(document.body, "innerText", {
    get() {
      return this.textContent;
    },
  });
  document.createRange = () => ({ selectNodeContents() {}, collapse() {} });
  document.execCommand = () => false;
  const url = new URL(href);
  let listener;
  class Transfer {
    constructor() {
      this.files = [];
      this.items = { add: (file) => this.files.push(file) };
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
    location: { origin: url.origin, pathname: url.pathname, href },
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
        sendMessage: async (message) =>
          message.type === "ASSET"
            ? { ok: true, chunk: Buffer.from("cover").toString("base64") }
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
  return {
    document,
    run(task) {
      return new Promise((resolve) =>
        listener({ type: "RUN_DRAFT", task }, {}, resolve),
      );
    },
    send(payload) {
      return new Promise((resolve) => listener(payload, {}, resolve));
    },
  };
}
function armCoverDialog(document, opener, confirmText, extras) {
  const names = [];
  opener.onclick = () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const upload = document.createElement("button");
    upload.textContent = "上传封面";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg";
    input.addEventListener("change", () => names.push(input.files[0].name));
    upload.onclick = () => {
      if (!input.isConnected) dialog.append(input);
    };
    const ok = document.createElement("button");
    ok.textContent = confirmText;
    ok.onclick = () => dialog.remove();
    dialog.append(upload, ok);
    extras?.(dialog);
    document.body.append(dialog);
  };
  return names;
}

test("小红书填入视频时打开封面弹窗并上传竖封面", async () => {
  const { document, run } = mountRunner(
    "https://creator.xiaohongshu.com/publish/publish",
  );
  document.body.innerHTML =
    '<span>草稿箱(0)</span><input type="file" accept="video/mp4"><input placeholder="填写标题"><div contenteditable="true"></div><button id="edit-cover">编辑封面</button><xhs-publish-btn save-disabled="true"></xhs-publish-btn><button id="save">暂存离开</button>';
  const host = document.querySelector("xhs-publish-btn");
  const names = armCoverDialog(
    document,
    document.querySelector("#edit-cover"),
    "完成",
  );
  document.querySelector("input[type=file]").onchange = () => {
    setTimeout(() => {
      const preview = document.createElement("div");
      preview.setAttribute(
        "style",
        "background-image:url(https://xhscdn.com/spectrum/fixture)",
      );
      document.body.append(preview);
      host.setAttribute("save-disabled", "false");
    }, 20);
  };
  document.querySelector("#save").onclick = () => {
    document.body.innerHTML =
      '<span>草稿保存成功</span><div class="draft-item" data-draft-id="video-native"><span class="draft-title-text">视频验收</span></div>';
  };
  const response = await run({
    id: "xhs-cover",
    kind: "video",
    platform: "xiaohongshu",
    title: "视频验收",
    description: "完整的视频文案",
    assets: [
      { id: "v", role: "video", name: "video.mp4", type: "video/mp4", size: 5 },
      {
        id: "portrait",
        role: "cover-portrait",
        name: "portrait.png",
        type: "image/png",
        size: 5,
      },
    ],
  });
  assert.equal(response.result.state, "draft_ready", response.result.message);
  assert.deepEqual(names, ["portrait.png"]);
});

test("视频号分别把竖封面和横封面写入两张卡片", async () => {
  const { document, run } = mountRunner(
    "https://channels.weixin.qq.com/platform/post/create",
  );
  document.body.innerHTML =
    '<input type="file" accept="video/mp4"><div class="post-desc-box"><div contenteditable="true" data-placeholder="添加描述"></div></div><input placeholder="概括视频主要内容"><div class="cover-card"><span>个人主页卡片</span><button>编辑</button></div><div class="cover-card"><span>分享卡片</span><button>编辑</button></div>';
  const covers = [...document.querySelectorAll(".cover-card")].map((card) =>
    armCoverDialog(document, card.querySelector("button"), "确认"),
  );
  const response = await run({
    id: "channels-cover",
    kind: "video",
    platform: "channels",
    fillOnly: true,
    title: "手麻都是气血不通吗",
    description: "对读素问和逆调论",
    assets: [
      { id: "v", role: "video", name: "video.mp4", type: "video/mp4", size: 5 },
      {
        id: "portrait",
        role: "cover-portrait",
        name: "portrait.png",
        type: "image/png",
        size: 5,
      },
      {
        id: "landscape",
        role: "cover-landscape",
        name: "landscape.png",
        type: "image/png",
        size: 5,
      },
    ],
  });
  assert.equal(
    response.result.state,
    "needs_attention",
    response.result.message,
  );
  assert.match(response.result.message, /封面已填入/);
  assert.doesNotMatch(response.result.message, /没有完整写入/);
  assert.equal(
    document.querySelector(".post-desc-box [contenteditable]").textContent,
    "对读素问和逆调论",
  );
  assert.equal(
    document.querySelector('input[placeholder*="概括视频"]').value,
    "手麻都是气血不通吗",
  );
  assert.equal(
    document.querySelector(".post-desc-box [contenteditable]").isConnected,
    true,
  );
  assert.deepEqual(covers.flat(), ["portrait.png", "landscape.png"]);
});

test("视频号描述写入编辑器内部，短标题原样保留逗号", async () => {
  const { document, run } = mountRunner(
    "https://channels.weixin.qq.com/platform/post/create",
  );
  document.body.innerHTML =
    '<input type="file" accept="video/mp4"><div><span>视频描述</span><div class="post-desc-box"><div class="input-editor" contenteditable="true"><span data-leaf="true"></span></div></div></div><div><span>短标题</span><input placeholder="概括视频主要内容"></div>';
  document.execCommand = (name, _, value) => {
    if (name !== "insertText") return false;
    const leaf = document.querySelector("[data-leaf]");
    leaf.textContent = value;
    return false;
  };
  const response = await run({
    id: "channels-desc",
    kind: "video",
    platform: "channels",
    fillOnly: true,
    title: "经络的名字，其实是一个地址",
    description: "对读素问和逆调论",
    assets: [
      { id: "v", role: "video", name: "video.mp4", type: "video/mp4", size: 5 },
    ],
  });
  assert.equal(
    response.result.state,
    "needs_attention",
    response.result.message,
  );
  assert.match(response.result.message, /文案已填入|描述和短标题/);
  assert.doesNotMatch(response.result.message, /逗号/);
  assert.doesNotMatch(response.result.message, /没有完整写入/);
  assert.equal(
    document.querySelector("[data-leaf]").textContent,
    "对读素问和逆调论",
  );
  assert.equal(document.querySelector(".input-editor").isConnected, true);
  assert.equal(
    document.querySelector('input[placeholder*="概括视频"]').value,
    "经络的名字，其实是一个地址",
  );
});

test("视频号修改页只写描述和短标题，不点完成", async () => {
  const { document, run } = mountRunner(
    "https://channels.weixin.qq.com/platform/post/coverEdit?objectId=export%2Fabc",
  );
  document.body.innerHTML =
    '<div><span>视频描述</span><div class="input-editor" contenteditable="true"></div></div><div><span>短标题</span><input value="经络的名字，其实是一个地址"></div><button id="done">完成</button>';
  let done = 0;
  document.querySelector("#done").onclick = () => done++;
  const response = await run({
    id: "channels-edit",
    kind: "video",
    platform: "channels",
    fillOnly: true,
    title: "经络的名字，其实是一个地址",
    description: "对读素问和逆调论",
    assets: [
      { id: "v", role: "video", name: "video.mp4", type: "video/mp4", size: 5 },
    ],
  });
  assert.equal(
    response.result.state,
    "needs_attention",
    response.result.message,
  );
  assert.match(response.result.message, /自行点完成/);
  assert.equal(done, 0);
  assert.equal(
    document.querySelector(".input-editor").textContent,
    "对读素问和逆调论",
  );
  assert.equal(
    document.querySelector('input[placeholder], input').value,
    "经络的名字，其实是一个地址",
  );
});

test("已打开的封面窗口写入侧栏封面，不关闭窗口", async () => {
  const { document, send } = mountRunner(
    "https://creator.douyin.com/creator-micro/content/upload",
  );
  const pad = "封".repeat(1600);
  document.body.innerHTML = `<div role="dialog">${pad}<button>上传封面</button><input type="file" accept="image/png"><button id="done">完成</button></div>`;
  const names = [];
  let closed = false;
  const input = document.querySelector("input[type=file]");
  input.addEventListener("change", () => names.push(input.files[0].name));
  document.querySelector("#done").onclick = () => {
    closed = true;
    document.querySelector("[role=dialog]").remove();
  };
  const response = await send({
    type: "PLACE_COVER",
    name: "portrait.png",
    mime: "image/png",
    chunks: [Buffer.from("png-bytes").toString("base64")],
  });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(names, ["portrait.png"]);
  assert.equal(closed, false);
  assert.equal(document.querySelector("[role=dialog]").isConnected, true);
  document.body.innerHTML = "<p>没有封面窗口</p>";
  const closedPage = await send({
    type: "PLACE_COVER",
    name: "portrait.png",
    mime: "image/png",
    chunks: [Buffer.from("png-bytes").toString("base64")],
  });
  assert.equal(closedPage.ok, false);
  assert.match(closedPage.error, /封面|上传/);
});

test("抖音填入视频时打开封面弹窗并上传封面", async () => {
  const { document, run } = mountRunner(
    "https://creator.douyin.com/creator-micro/content/upload",
  );
  document.body.innerHTML =
    '<input type="file" accept="video/mp4"><input placeholder="填写作品标题"><div class="zone-container" contenteditable="true"></div><button id="pick-cover">选择封面</button>';
  const names = armCoverDialog(
    document,
    document.querySelector("#pick-cover"),
    "完成",
  );
  const response = await run({
    id: "douyin-cover",
    kind: "video",
    platform: "douyin",
    fillOnly: true,
    title: "手麻都是气血不通吗",
    description: "对读素问和逆调论",
    assets: [
      { id: "v", role: "video", name: "video.mp4", type: "video/mp4", size: 5 },
      {
        id: "portrait",
        role: "cover-portrait",
        name: "portrait.png",
        type: "image/png",
        size: 5,
      },
    ],
  });
  assert.equal(
    response.result.state,
    "needs_attention",
    response.result.message,
  );
  assert.match(response.result.message, /封面已填入/);
  assert.doesNotMatch(response.result.message, /没有完整写入/);
  assert.equal(
    document.querySelector('input[placeholder="填写作品标题"]').value,
    "手麻都是气血不通吗",
  );
  assert.equal(
    document.querySelector(".zone-container").textContent,
    "对读素问和逆调论",
  );
  assert.deepEqual(names, ["portrait.png"]);
});

test("小红书封面窗口里有 3:4 时会选中后再保存", async () => {
  const { document, run } = mountRunner(
    "https://creator.xiaohongshu.com/publish/publish",
  );
  document.body.innerHTML =
    '<span>草稿箱(0)</span><input type="file" accept="video/mp4"><input placeholder="填写标题"><div contenteditable="true"></div><button id="edit-cover">编辑封面</button><xhs-publish-btn save-disabled="true"></xhs-publish-btn><button id="save">暂存离开</button>';
  const host = document.querySelector("xhs-publish-btn");
  let ratioOn = false;
  armCoverDialog(
    document,
    document.querySelector("#edit-cover"),
    "完成",
    (dialog) => {
      const ratio = document.createElement("button");
      ratio.textContent = "3:4";
      ratio.onclick = () => {
        ratioOn = true;
        ratio.setAttribute("aria-pressed", "true");
      };
      dialog.append(ratio);
    },
  );
  document.querySelector("input[type=file]").onchange = () => {
    setTimeout(() => {
      const preview = document.createElement("div");
      preview.setAttribute(
        "style",
        "background-image:url(https://xhscdn.com/spectrum/fixture)",
      );
      document.body.append(preview);
      host.setAttribute("save-disabled", "false");
    }, 20);
  };
  document.querySelector("#save").onclick = () => {
    document.body.innerHTML =
      '<span>草稿保存成功</span><div class="draft-item" data-draft-id="ratio"><span class="draft-title-text">视频验收</span></div>';
  };
  const response = await run({
    id: "xhs-ratio",
    kind: "video",
    platform: "xiaohongshu",
    title: "视频验收",
    description: "完整的视频文案",
    assets: [
      { id: "v", role: "video", name: "video.mp4", type: "video/mp4", size: 5 },
      {
        id: "portrait",
        role: "cover-portrait",
        name: "portrait.png",
        type: "image/png",
        size: 5,
      },
    ],
  });
  assert.equal(response.result.state, "draft_ready", response.result.message);
  assert.equal(ratioOn, true);
  assert.equal(response.result.warnings, undefined);
});

test("抖音点中同名联想后，话题才算填入", async () => {
  const { document, run } = mountRunner(
    "https://creator.douyin.com/creator-micro/content/upload",
  );
  document.body.innerHTML =
    '<input type="file" accept="video/mp4"><input placeholder="填写作品标题"><div contenteditable="true" data-placeholder="简介"></div><div class="mention-suggest-item-container"><div class="tag-hash">#气血</div><div class="tag-hash">#其他</div></div>';
  document.querySelector(".tag-hash").onclick = () => {
    const mention = document.createElement("span");
    mention.dataset.mention = "气血";
    mention.textContent = "#气血";
    document.querySelector("[contenteditable]").append(mention);
  };
  const response = await run({
    id: "douyin-topic",
    kind: "video",
    platform: "douyin",
    fillOnly: true,
    title: "手麻都是气血不通吗",
    description: "对读 #气血",
    assets: [
      { id: "v", role: "video", name: "video.mp4", type: "video/mp4", size: 5 },
    ],
  });
  assert.equal(
    response.result.state,
    "needs_attention",
    response.result.message,
  );
  assert.doesNotMatch(response.result.message, /没有变成平台话题/);
  assert.match(
    document.querySelector("[contenteditable]").textContent,
    /对读 #气血/,
  );
  assert.equal(document.querySelector("[data-mention]").textContent, "#气血");
});

test("抖音发布页把描述写入 zone-container，不拆掉编辑器结构", async () => {
  const { document, run } = mountRunner(
    "https://creator.douyin.com/creator-micro/content/post/video",
  );
  document.body.innerHTML =
    '<input type="file" accept="video/mp4"><input placeholder="填写作品标题"><div class="zone-container" contenteditable="true"><div class="ace-line"><span data-string="true"></span></div></div>';
  document.execCommand = (name, _, value) => {
    if (name !== "insertText") return false;
    document.querySelector("[data-string]").textContent = value;
    return false;
  };
  const response = await run({
    id: "douyin-desc",
    kind: "video",
    platform: "douyin",
    fillOnly: true,
    title: "手麻都是气血不通吗",
    description: "对读素问和逆调论",
    assets: [
      { id: "v", role: "video", name: "video.mp4", type: "video/mp4", size: 5 },
    ],
  });
  assert.equal(
    response.result.state,
    "needs_attention",
    response.result.message,
  );
  assert.match(response.result.message, /文案已填入/);
  assert.doesNotMatch(response.result.message, /没有完整写入/);
  assert.equal(
    document.querySelector('input[placeholder="填写作品标题"]').value,
    "手麻都是气血不通吗",
  );
  assert.equal(
    document.querySelector("[data-string]").textContent,
    "对读素问和逆调论",
  );
  assert.equal(document.querySelector(".ace-line").isConnected, true);
});

test("B 站填入标题、标签和封面，不点击投稿", async () => {
  const { document, run } = mountRunner(
    "https://member.bilibili.com/platform/upload/video/frame",
  );
  document.body.innerHTML =
    '<input type="file" accept="video/mp4"><input placeholder="请输入稿件标题"><div class="ql-editor" contenteditable="true"></div><div class="tag-pre-wrp"></div><input placeholder="按回车键Enter创建标签"><button id="cover">上传封面</button><button id="publish">立即投稿</button>';
  const tags = [];
  const tagInput = document.querySelector('input[placeholder*="创建标签"]');
  tagInput.addEventListener("confirm-tag", () => {
    const span = document.createElement("span");
    span.textContent = tagInput.value;
    document.querySelector(".tag-pre-wrp").append(span);
    tags.push(tagInput.value);
  });
  let published = 0;
  document.querySelector("#publish").onclick = () => published++;
  const names = armCoverDialog(
    document,
    document.querySelector("#cover"),
    "完成",
  );
  const response = await run({
    id: "bili",
    kind: "video",
    platform: "bilibili",
    fillOnly: true,
    title: "一期视频的标题",
    description: "简介正文",
    tags: "人工智能 代理",
    assets: [
      { id: "v", role: "video", name: "video.mp4", type: "video/mp4", size: 5 },
      {
        id: "c",
        role: "cover-landscape",
        name: "landscape.png",
        type: "image/png",
        size: 5,
      },
    ],
  });
  assert.equal(
    response.result.state,
    "needs_attention",
    response.result.message,
  );
  assert.match(response.result.message, /创作声明/);
  assert.equal(published, 0);
  assert.deepEqual(tags, ["人工智能", "代理"]);
  assert.deepEqual(names, ["landscape.png"]);
});

test("YouTube 作品列表先点创建再上传，不点公开发布", async () => {
  const { document, run } = mountRunner(
    "https://studio.youtube.com/channel/UC1/videos/upload",
  );
  document.body.innerHTML =
    '<button id="create">创建</button><div id="title-box" contenteditable="true"></div><div id="desc-box" contenteditable="true"></div><button id="publish">Publish</button>';
  document.querySelector("#create").onclick = () => {
    const upload = document.createElement("button");
    upload.id = "upload-video";
    upload.textContent = "上传视频";
    upload.onclick = () => {
      const input = document.createElement("input");
      input.name = "Filedata";
      input.type = "file";
      input.accept = "video/mp4";
      document.body.append(input);
    };
    document.body.append(upload);
  };
  let published = 0;
  document.querySelector("#publish").onclick = () => published++;
  const response = await run({
    id: "yt-create",
    kind: "video",
    platform: "youtube",
    fillOnly: true,
    title: "一期视频的标题",
    description: "说明",
    assets: [
      { id: "v", role: "video", name: "video.mp4", type: "video/mp4", size: 5 },
    ],
  });
  assert.equal(
    response.result.state,
    "needs_attention",
    response.result.message,
  );
  assert.equal(published, 0);
  assert.equal(
    document.querySelector('input[name="Filedata"]').files[0].name,
    "video.mp4",
  );
});

test("YouTube 交视频后停在私享，不点击发布", async () => {
  const { document, run } = mountRunner(
    "https://studio.youtube.com/channel/UC1/videos/upload",
  );
  document.body.innerHTML =
    '<input name="Filedata" type="file" accept="video/mp4"><div id="title-box" contenteditable="true"></div><div id="desc-box" contenteditable="true"></div><input id="thumb" type="file" accept="image/jpeg"><button id="publish">Publish</button>';
  const thumbs = [];
  document.querySelector("#thumb").addEventListener("change", (event) => {
    thumbs.push(event.target.files[0].name);
  });
  let published = 0;
  document.querySelector("#publish").onclick = () => published++;
  const response = await run({
    id: "yt",
    kind: "video",
    platform: "youtube",
    fillOnly: true,
    title: "一期视频的标题",
    description: "说明",
    assets: [
      { id: "v", role: "video", name: "video.mp4", type: "video/mp4", size: 5 },
      {
        id: "c",
        role: "cover-landscape",
        name: "wide.jpg",
        type: "image/jpeg",
        size: 5,
      },
    ],
  });
  assert.equal(
    response.result.state,
    "needs_attention",
    response.result.message,
  );
  assert.match(response.result.message, /私享/);
  assert.equal(published, 0);
  assert.deepEqual(thumbs, ["wide.jpg"]);
  assert.equal(
    document.querySelector("#title-box").textContent,
    "一期视频的标题",
  );
});

test("Instagram 选原版并填写配文，不点击分享", async () => {
  const { document, run } = mountRunner("https://www.instagram.com/");
  document.body.innerHTML =
    '<div role="dialog"><input type="file" accept="video/mp4"><button id="original">原版</button><div contenteditable="true"></div><input id="cover" type="file" accept="image/jpeg"><button id="share">分享</button></div>';
  let original = 0;
  let shared = 0;
  document.querySelector("#original").onclick = () => original++;
  document.querySelector("#share").onclick = () => shared++;
  const response = await run({
    id: "ig",
    kind: "video",
    platform: "instagram",
    fillOnly: true,
    title: "一期视频的标题",
    description: "配文正文",
    assets: [
      { id: "v", role: "video", name: "video.mp4", type: "video/mp4", size: 5 },
    ],
  });
  assert.equal(
    response.result.state,
    "needs_attention",
    response.result.message,
  );
  assert.match(response.result.message, /不会点分享/);
  assert.equal(original, 1);
  assert.equal(shared, 0);
  assert.match(
    document.querySelector("[contenteditable]").textContent,
    /配文正文/,
  );
});

for (const existing of [
  '<div contenteditable="true">原有文案</div>',
  '<video><source src="blob:existing"></video>',
]) {
  test(`X 重试在已有${existing.startsWith("<video") ? "视频" : "文案"}时停止，不读取素材或重复上传`, async () => {
    const { document, window } = parseHTML(
      `<html><body><input type="file" accept="video/mp4">${existing}</body></html>`,
    );
    window.HTMLElement.prototype.getBoundingClientRect = () => ({
      width: 100,
      height: 30,
    });
    let listener;
    const messages = [];
    vm.runInNewContext(source, {
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
          sendMessage: async (m) => {
            messages.push(m);
            return { ok: true };
          },
        },
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
      Date,
      console,
    });
    const response = await new Promise((resolve) =>
      listener(
        {
          type: "RUN_DRAFT",
          task: {
            id: "retry-x",
            kind: "video",
            platform: "x",
            fillOnly: true,
            title: "视频",
            assets: [],
          },
        },
        {},
        resolve,
      ),
    );
    assert.equal(response.result.state, "needs_attention");
    assert.match(response.result.message, /页面已有内容/);
    assert.equal(
      messages.some((m) => m.type === "ASSET"),
      false,
    );
  });
}
