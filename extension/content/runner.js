import {
  PLATFORMS,
  scheduleWindowIssue,
  tagNames,
  topicNames as hashTopics,
} from "../shared/model.js";

(() => {
  if (globalThis.__OMNIPOST__) return;
  globalThis.__OMNIPOST__ = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.display !== "none" &&
      s.visibility !== "hidden"
    );
  };
  function attention(message) {
    const e = new Error(message);
    e.needsAttention = true;
    throw e;
  }
  async function wait(check, message, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await check();
      if (value) return value;
      await sleep(350);
    }
    attention(message);
  }
  function exact(texts, root = document) {
    const names = Array.isArray(texts) ? texts : [texts];
    const roots = [root];
    for (const host of root.querySelectorAll("xhs-publish-btn")) {
      const shadow = shadowRootOf(host);
      if (shadow) roots.push(shadow);
    }
    const els = roots
      .flatMap((node) => [
        ...node.querySelectorAll('button,[role="button"],a,label,span,div'),
      ])
      .filter(visible);
    for (const name of names) {
      const match = els
        .filter((e) => norm(e.textContent) === name)
        .sort(
          (a, b) =>
            a.querySelectorAll("*").length - b.querySelectorAll("*").length,
        )[0];
      if (match)
        return match.closest('button,[role="button"],a,label') || match;
    }
    return null;
  }
  function click(el) {
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true")
      attention("按钮尚不可用，请在平台处理后重试");
    if (
      /^(发布|发表|投稿|立即投稿|分享|定时发布|Publish|Post|Share)$/i.test(
        norm(el.textContent),
      )
    )
      throw new Error("草稿模式禁止公开发布");
    el.scrollIntoView({ block: "center" });
    el.click();
  }
  async function clickText(names, root = document) {
    click(await wait(() => exact(names, root), "未找到平台操作：" + names));
  }
  function field(selector, root = document) {
    return [...root.querySelectorAll(selector)].find(visible);
  }
  function textField(el, value) {
    el.focus();
    if (el.matches("input,textarea")) {
      const proto =
        el.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertText",
          data: value,
        }),
      );
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return;
    }
    const root = el.getRootNode();
    const selection = root.getSelection?.() || getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      document.execCommand("insertText", false, value);
    } catch {}
    if (compact(plainText(el)) !== compact(value)) {
      el.textContent = value;
    }
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: value,
      }),
    );
  }
  function editorText(el) {
    if (!el) return "";
    const text = el.matches("input,textarea") ? el.value : plainText(el);
    const placeholder =
      el.getAttribute("data-placeholder") ||
      el.getAttribute("placeholder") ||
      "";
    return norm(text) && norm(text) !== norm(placeholder) ? text : "";
  }
  function isEditable(el) {
    if (!el || !visible(el)) return false;
    if (
      el.matches(
        'textarea, input:not([type="file"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
      )
    )
      return true;
    const mode = el.getAttribute("contenteditable");
    return mode != null && mode !== "false";
  }
  function isShortTitle(el) {
    if (!el?.matches?.("input,textarea")) return false;
    const hint = `${el.getAttribute("placeholder") || ""}${el.getAttribute("aria-label") || ""}`;
    return /短标题|概括视频/.test(hint);
  }
  function placeCaret(el, atStart) {
    const doc = el.ownerDocument || document;
    const selection = el.getRootNode().getSelection?.() || getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    if (atStart !== undefined) range.collapse(atStart);
    selection.removeAllRanges();
    selection.addRange(range);
    return doc;
  }
  function insertEditorText(el, value) {
    const doc = placeCaret(el);
    const lines = String(value).split(/\n/);
    try {
      doc.execCommand("insertText", false, lines[0] || "");
      for (let i = 1; i < lines.length; i++) {
        doc.execCommand("insertParagraph", false);
        if (lines[i]) doc.execCommand("insertText", false, lines[i]);
      }
    } catch {}
  }
  async function pasteEditorText(el, value) {
    if (
      typeof ClipboardEvent !== "function" ||
      typeof DataTransfer !== "function"
    )
      return false;
    placeCaret(el);
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", value);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    await sleep(100);
    return acceptedEditor(el, value);
  }
  async function fillEditable(el, value, { pasteFirst = false } = {}) {
    if (!el) return;
    if (el.matches("input,textarea")) {
      textField(el, value);
      return;
    }
    el.focus();
    pointerClick(el);
    if (pasteFirst && (await pasteEditorText(el, value))) return;
    insertEditorText(el, value);
    if (acceptedEditor(el, value)) return;
    await sleep(40);
    if (acceptedEditor(el, value)) return;
    if (!pasteFirst && (await pasteEditorText(el, value))) return;
    textField(el, value);
  }
  function acceptedEditor(el, value) {
    if (compact(plainText(el)) !== compact(value)) return false;
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: value,
      }),
    );
    return true;
  }
  const channelsEditable =
    '[contenteditable]:not([contenteditable="false"]), textarea, input:not([type="file"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"])';
  function channelsEditor(label) {
    const seed = queryAll("label,span,div,p,dt,h2,h3")
      .filter((el) => visible(el) && norm(el.textContent) === label)
      .sort(
        (a, b) =>
          a.querySelectorAll("*").length - b.querySelectorAll("*").length,
      )[0];
    if (!seed) return null;
    let node = seed.parentElement;
    for (let i = 0; i < 6 && node; i++) {
      const editor = queryAll(channelsEditable, node).find(
        (el) =>
          isEditable(el) &&
          !seed.contains(el) &&
          (label !== "视频描述" || !isShortTitle(el)) &&
          seed.compareDocumentPosition(el) &
            (globalThis.Node?.DOCUMENT_POSITION_FOLLOWING || 4),
      );
      if (editor) return editor;
      node = node.parentElement;
    }
    return null;
  }
  function channelsDescription() {
    const candidates = queryAll(
      '[data-placeholder*="添加描述"], .post-desc-box [contenteditable], .input-editor[contenteditable], textarea[placeholder*="描述"]',
    ).filter((el) => isEditable(el) && !isShortTitle(el));
    const marked = candidates.find((el) =>
      /添加描述/.test(
        el.getAttribute("data-placeholder") ||
          el.getAttribute("placeholder") ||
          "",
      ),
    );
    if (marked) return marked;
    if (candidates[0]) return candidates[0];
    return channelsEditor("视频描述");
  }
  function channelsTitle() {
    return (
      channelsEditor("短标题") ||
      field(
        '.short-title-wrap input, input[placeholder*="短标题"], input[placeholder*="概括视频"]',
      )
    );
  }
  async function fillChannelsCopy(task, timeout = 300000) {
    const desc = await wait(
      () => channelsDescription(),
      "未找到视频号视频描述",
      timeout,
    );
    const raw = task.description || task.title || "";
    const topics = hashTopics(raw);
    const body = raw.replace(/(?:^|\s)(?:#[^\s#]+[ \t]*)+$/g, "").trim();
    const copy = withTopicSpaces(body || raw);
    await fillEditable(desc, copy);
    if (body && topics.length && !hashTopics(body).length) {
      for (let i = 0; i < topics.length; i++) {
        placeCaret(desc, false);
        try {
          (desc.ownerDocument || document).execCommand(
            "insertText",
            false,
            (i === 0 ? "\n" : "") + "#" + topics[i] + " ",
          );
        } catch {}
      }
    }
    if (compact(plainText(desc)) !== compact(withTopicSpaces(raw)))
      note(task, "视频描述没有完整写入，请在描述框核对");
    for (const name of topics) {
      if (!plainText(desc).includes("#" + name))
        note(task, "话题「" + name + "」没有完整写入，请在描述框核对");
    }
    const title = channelsTitle();
    if (title && !editorText(title)) textField(title, task.title);
  }
  function douyinTitle() {
    return field(
      'input[placeholder*="作品标题"],input[placeholder*="填写标题"],input[placeholder*="添加作品标题"],textarea[placeholder*="作品标题"]',
    );
  }
  function douyinDescription(title) {
    const selectors = [
      '.zone-container[contenteditable="true"]',
      '.editor-kit-container[contenteditable="true"]',
      '[data-placeholder*="简介"],[data-placeholder*="描述"],[data-placeholder*="添加作品"]',
      'textarea[placeholder*="简介"],textarea[placeholder*="描述"],textarea[placeholder*="添加作品"]',
    ];
    for (const selector of selectors) {
      const el = field(selector);
      if (el && el !== title) return el;
    }
    const zone = field(".zone-container, .editor-comp-publish");
    const nested = zone?.querySelector(
      '[contenteditable="true"],[contenteditable=""]',
    );
    if (nested && nested !== title && visible(nested)) return nested;
    if (
      zone &&
      zone !== title &&
      zone.getAttribute("contenteditable") !== "false"
    )
      return zone;
    return null;
  }
  const compact = (text) =>
    String(text || "").replace(/[\s\u200b-\u200d\ufeff]/g, "");
  function plainText(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 && node.nodeType !== 11) return "";
    if (node.matches?.("img,button,[role=button],[contenteditable=false]"))
      return "";
    return [...node.childNodes].map(plainText).join("");
  }
  async function richPaste(el, html, append = false) {
    const editorDocument = el.ownerDocument || document;
    const previous = plainText(el);
    if (!append && norm(previous))
      attention("编辑器已有内容，已停住以保留平台中的修改。请新建草稿后重试。");
    el.focus();
    {
      const range = editorDocument.createRange();
      let anchor = el;
      if (append && el.matches("[data-testid=composer]")) {
        const blocks = [...el.querySelectorAll("[data-block=true]")].filter(
          (b) => b.getAttribute("contenteditable") !== "false",
        );
        anchor = blocks.at(-1) || el;
        while (
          anchor.lastElementChild &&
          anchor.lastElementChild.tagName !== "BR"
        )
          anchor = anchor.lastElementChild;
      }
      range.selectNodeContents(anchor);
      range.collapse(!append);
      const selection =
        editorDocument.defaultView?.getSelection?.() || getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      editorDocument.dispatchEvent(
        new Event("selectionchange", { bubbles: true }),
      );
      if (typeof MouseEvent !== "undefined")
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await sleep(100);
    }
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    const tmp = editorDocument.createElement("div");
    tmp.innerHTML = html;
    dt.setData("text/plain", tmp.innerText || tmp.textContent);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    const accepted = el.dispatchEvent(event);
    if (accepted) {
      const started = Date.now();
      while (
        compact(plainText(el)) === compact(previous) &&
        Date.now() - started < 800
      )
        await sleep(40);
      if (compact(plainText(el)) === compact(previous))
        editorDocument.execCommand("insertHTML", false, html);
    }
    const expected = compact(previous + tmp.textContent);
    await wait(
      () => compact(plainText(el)) === expected,
      "平台没有接收完整富文本，请在编辑器中检查",
      5000,
    );
    await sleep(500);
    if (compact(plainText(el)) !== expected)
      attention("平台未稳定接收正文，已保留当前草稿");
  }
  async function file(task, asset) {
    const parts = [];
    for (let index = 0; index < Math.ceil(asset.size / 1024 ** 2); index++) {
      const r = await chrome.runtime.sendMessage({
        type: "ASSET",
        id: task.id,
        assetId: asset.id,
        index,
      });
      if (!r?.ok) throw new Error(r?.error || "读取素材失败");
      const binary = atob(r.chunk),
        bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      parts.push(bytes);
    }
    return new File(parts, asset.name, { type: asset.type });
  }
  async function upload(input, f) {
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  function shadowRootOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.shadowRoot) return el.shadowRoot;
    if (!String(el.tagName || "").includes("-")) return null;
    try {
      return chrome.dom?.openOrClosedShadowRoot?.(el) || null;
    } catch {
      return null;
    }
  }
  function queryAll(selector, start = document) {
    const out = [];
    const seen = new Set();
    const visit = (root) => {
      if (!root?.querySelectorAll || seen.has(root)) return;
      seen.add(root);
      out.push(...root.querySelectorAll(selector));
      for (const el of root.querySelectorAll("*")) {
        const shadow = shadowRootOf(el);
        if (shadow) visit(shadow);
        if (el.tagName === "IFRAME") {
          try {
            visit(el.contentDocument);
          } catch {}
        }
      }
    };
    const own = start?.nodeType === 1 ? shadowRootOf(start) : null;
    if (own) visit(own);
    visit(start);
    return out;
  }
  function acceptsImage(input) {
    if (!input || input.name === "Filedata") return false;
    const accept = (
      input.getAttribute("accept") ||
      input.accept ||
      ""
    ).toLowerCase();
    if (!accept) return input.id === "file-loader";
    if (/video|mp4|mov/.test(accept) && !/image|png|jpe?g|webp/.test(accept))
      return false;
    return /image|png|jpe?g|webp/.test(accept);
  }
  function coverFileInput() {
    const hosts = queryAll(
      "ytcp-thumbnails-compact-editor, ytcp-thumbnail-uploader, ytcp-video-thumbnail-editor, ytcp-thumbnail-editor",
    );
    for (const host of hosts) {
      const input = queryAll("input[type=file]", host).find(acceptsImage);
      if (input) return input;
    }
    return (
      queryAll("input#file-loader").find((el) => el.name !== "Filedata") ||
      queryAll("input[type=file]").find(acceptsImage) ||
      null
    );
  }
  function inputFor(kind, root = document) {
    const pattern = new RegExp(
      kind === "video" ? "video|mp4|mov" : "image|png|jpg|jpeg|webp",
      "i",
    );
    const inputs = queryAll("input[type=file]", root);
    return (
      inputs.find((el) =>
        pattern.test(el.getAttribute("accept") || el.accept || ""),
      ) ||
      (kind === "video"
        ? inputs.find(
            (el) =>
              !/image|png|jpg|jpeg|webp/i.test(
                el.getAttribute("accept") || el.accept || "",
              ),
          )
        : undefined)
    );
  }
  function deepField(selector) {
    return queryAll(selector).find(visible);
  }
  async function status(task, state, message) {
    return chrome.runtime.sendMessage({
      type: "CONTENT_STATUS",
      id: task.id,
      platform: task.platform,
      patch: { state, message },
    });
  }
  function note(task, message) {
    if (!message) return;
    task._notes = task._notes || [];
    if (!task._notes.includes(message)) task._notes.push(message);
  }
  function withNotes(task, message) {
    return [message, ...(task._notes || [])].filter(Boolean).join("；");
  }
  function withTopicSpaces(text) {
    return String(text || "").replace(/#([^\s#]+)(?![ \t])/g, "#$1 ");
  }
  function tagList(task) {
    return [
      ...new Set([...tagNames(task.tags), ...hashTopics(task.description)]),
    ];
  }
  function pointerClick(el) {
    if (typeof MouseEvent === "function") {
      const rect = el.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      for (const type of ["mousedown", "mouseup", "click"])
        el.dispatchEvent(new MouseEvent(type, init));
    }
    click(el);
  }
  function pressEnter(el) {
    if (typeof KeyboardEvent === "function")
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    else el.dispatchEvent(new Event("confirm-tag", { bubbles: true }));
  }
  function hasTopic(editor, name) {
    return queryAll(
      "a.tiptap-topic,[data-mention],a[class*=topic]",
      editor,
    ).some((el) => norm(el.textContent).replace(/^#/, "") === name);
  }
  function findSuggestion(name) {
    return queryAll(".item,[class*=mention-suggest-item],[class*=tag-hash]")
      .filter(visible)
      .filter((el) => {
        const line = norm(el.textContent).split(" ")[0].replace(/^#/, "");
        return line === name;
      })
      .sort(
        (a, b) =>
          a.querySelectorAll("*").length - b.querySelectorAll("*").length,
      )[0];
  }
  async function confirmTopics(task, editor) {
    const names = hashTopics(task.description || "");
    const rules = PLATFORMS[task.platform].copy.video;
    if (!names.length || !rules?.nativeTopics) return;
    const cap = rules.topicMax ?? names.length;
    for (const name of names.slice(0, cap)) {
      if (hasTopic(editor, name)) continue;
      const option = findSuggestion(name);
      if (option) {
        pointerClick(option);
        await sleep(200);
      }
      if (!hasTopic(editor, name))
        note(
          task,
          "话题「" + name + "」没有变成平台话题，请在页面点选同名联想",
        );
    }
    if (names.length > cap)
      note(task, PLATFORMS[task.platform].name + "只处理前 " + cap + " 个话题");
  }
  async function waitUploadIdle() {
    const busy = () => /上传中|正在上传|转码中/.test(document.body.innerText);
    if (!busy()) return;
    await wait(
      () =>
        !busy() &&
        /上传完成|上传成功|已上传|处理完成|转码完成/.test(
          document.body.innerText,
        ),
      "视频仍在上传，封面要等上传完成后再设置",
      300000,
    );
  }
  function result(task, evidence, draftUrl = location.href) {
    return {
      state: "draft_ready",
      persisted: true,
      message: "草稿已保存，可以在平台继续微调",
      evidence,
      draftUrl,
      editorUrl: location.href,
      resume: { title: task.title, kind: task.kind },
    };
  }
  function auth() {
    if (
      /login|passport|signin/i.test(location.pathname) ||
      field("input[type=password]")
    )
      attention("请先在平台登录，再重试此平台");
  }
  function htmlWithMarkers(task, platform) {
    const html = task.prepared?.[platform];
    if (!html) throw new Error("缺少平台富文本，请重新导入文章");
    if (platform !== "wechat") return html;
    const doc = new DOMParser().parseFromString(
      "<html><body>" + html + "</body></html>",
      "text/html",
    );
    let index = 0;
    doc.querySelectorAll("img").forEach((img) => {
      const span = doc.createElement("span");
      span.textContent = `【待插入配图 ${++index}】`;
      img.replaceWith(span);
    });
    return doc.body.innerHTML;
  }
  async function insertImage(task, editor, platform, n) {
    const media = task.prepared.media;
    await status(task, "uploading", `上传配图 ${n + 1} / ${media.length}`);
    const asset = task.assets.find((a) => a.id === media[n].id);
    editor.focus();
    const before = editor.querySelectorAll("img").length;
    let root = document,
      input;
    if (platform === "x") {
      await clickText(["Insert"]);
      await clickText(["Media"]);
      root = await wait(
        () =>
          [...document.querySelectorAll("[role=dialog]")].find(
            (dialog) =>
              dialog.querySelector("input[type=file]") &&
              [...dialog.querySelectorAll("button")].some(visible),
          ),
        "X 媒体窗口未打开",
      );
      input = await wait(
        () => inputFor("image", root),
        "未找到 X 图片上传控件",
      );
    } else {
      const dt = new DataTransfer();
      dt.items.add(await file(task, asset));
      editor.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: false,
          cancelable: true,
          clipboardData: dt,
        }),
      );
    }
    if (platform === "x") await upload(input, await file(task, asset));
    await wait(
      () => editor.querySelectorAll("img").length > before,
      "第" + (n + 1) + "张图片未插入，请打开编辑器处理",
      180000,
    );
    await wait(
      () =>
        !document.body.innerText.includes("Uploading media...") &&
        !document.body.innerText.includes("Processing media..."),
      "媒体仍在上传，请稍后在平台处理",
      180000,
    );
    await sleep(platform === "x" ? 1200 : 500);
  }
  function stripSpacers(editor) {
    for (const el of [...editor.querySelectorAll("p")]) {
      if (el.querySelector("img,video")) continue;
      if (!compact(el.textContent)) el.remove();
    }
  }
  async function fillArticle(task, editor, platform) {
    const doc = new DOMParser().parseFromString(
      "<html><body>" + htmlWithMarkers(task, platform) + "</body></html>",
      "text/html",
    );
    const sections = [""];
    for (const node of doc.body.childNodes) {
      const match = /^【待插入配图 (\d+)】$/.exec(node.textContent.trim());
      if (match) {
        if (Number(match[1]) !== sections.length)
          attention("文章配图顺序不匹配");
        sections.push("");
      } else {
        if (/【待插入配图 \d+】/.test(node.textContent))
          attention("暂不支持段落内嵌图片，请将图片独立成段");
        sections[sections.length - 1] += node.outerHTML || node.textContent;
      }
    }
    if (sections.length !== task.prepared.media.length + 1)
      attention("文章配图数量不匹配");
    const prefixes = [];
    let expected = "";
    if (platform === "xiaohongshu" && task.prepared.media.length) {
      if (compact(plainText(editor)) || editor.querySelector("img"))
        attention("编辑器已有内容，请新建草稿后重试");
      const uploaded = [];
      for (let i = 0; i < task.prepared.media.length; i++) {
        await insertImage(task, editor, platform, i);
        const image = await wait(() => {
          const img = editor.querySelectorAll("img")[i];
          return (
            img?.src?.startsWith("https://") &&
            img.closest('[data-dom-type="image"]')
          );
        }, "等待小红书原生图片块上传完成");
        uploaded.push(image.outerHTML);
      }
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      await sleep(100);
      document.execCommand("delete", false);
      await wait(
        () => !compact(plainText(editor)) && !editor.querySelector("img"),
        "未能准备完整文章编辑区",
      );
      await sleep(300);
      await richPaste(
        editor,
        sections.map((part, i) => part + (uploaded[i] || "")).join(""),
      );
    }

    for (let i = 0; i < sections.length; i++) {
      const tmp = document.createElement("div");
      tmp.innerHTML = sections[i];
      if (
        compact(tmp.textContent) &&
        !(platform === "xiaohongshu" && task.prepared.media.length)
      ) {
        if (platform === "x") {
          await richPaste(
            editor,
            "<p>\u200b</p>",
            i > 0 || Boolean(compact(plainText(editor))),
          );
          await richPaste(editor, sections[i], true);
        } else await richPaste(editor, sections[i], i > 0);
      }
      expected += tmp.textContent;
      if (i < task.prepared.media.length) {
        prefixes.push(compact(expected));
        if (platform !== "xiaohongshu")
          await insertImage(task, editor, platform, i);
      }
    }
    if (platform === "x") stripSpacers(editor);
    if (platform === "x" && compact(plainText(editor)) !== compact(expected)) {
      for (const section of sections) {
        const tmp = document.createElement("div");
        tmp.innerHTML = section;
        const text = compact(tmp.textContent);
        if (!text || compact(plainText(editor)).includes(text)) continue;
        await richPaste(editor, "<p>\u200b</p>", true);
        await richPaste(editor, section, true);
        task._repaired = true;
      }
      stripSpacers(editor);
    }
    if (compact(plainText(editor)) !== compact(expected))
      attention("正文完整性校验未通过，请检查保留的草稿");
    let textBefore = "",
      index = 0;
    function visit(node) {
      if (node.nodeType === 3) {
        textBefore += node.textContent;
        return;
      }
      if (node.nodeType !== 1) return;
      const image =
        node.matches("img") ||
        (node.getAttribute("contenteditable") === "false" &&
          node.querySelector("img"));
      if (image) {
        if (compact(textBefore) !== prefixes[index++])
          attention("配图位置校验未通过，请检查保留的草稿");
        return;
      }
      if (
        node.matches("button,[role=button],[contenteditable=false]") &&
        !node.querySelector("img")
      )
        return;
      for (const child of node.childNodes) visit(child);
    }
    for (const child of editor.childNodes) visit(child);
    if (index !== prefixes.length)
      attention("配图完整性校验未通过，请检查保留的草稿");
  }
  async function saveXhs(task) {
    await status(task, "saving", "保存小红书草稿");
    const before =
      task._draftCount ?? /草稿箱[（(](\d+)/.exec(document.body.innerText)?.[1];
    await clickText(["暂存离开", "保存草稿"]);
    const proof = await wait(
      () => {
        const t = document.body.innerText;
        if (/暂存成功|保存成功|已保存到草稿|草稿已保存/.test(t))
          return "平台提示草稿保存成功";
        const count = /草稿箱[（(](\d+)/.exec(t)?.[1];
        if (count && before !== undefined && Number(count) > Number(before))
          return "平台草稿箱数量已增加";
        return false;
      },
      "未确认草稿保存结果，请检查小红书草稿箱，避免重复创建",
      20000,
    );
    const draftsButton = [...document.querySelectorAll("span,div")]
      .filter(visible)
      .find(
        (el) =>
          /^草稿箱[（(]\d+/.test(norm(el.textContent)) &&
          el.textContent.length < 20,
      );
    if (
      ![...document.querySelectorAll(".draft-item")].some(visible) &&
      draftsButton
    )
      draftsButton.click();
    const card = await wait(
      () =>
        [...document.querySelectorAll(".draft-item[data-draft-id]")].find(
          (el) =>
            visible(el) &&
            norm(el.querySelector(".draft-title-text")?.textContent) ===
              task.title,
        ),
      "草稿已暂存，但未取得对应卡片 ID，请在平台草稿箱检查",
      10000,
    );
    return {
      ...result(task, proof),
      postId: card.dataset.draftId,
      resume: {
        title: task.title,
        kind: task.kind,
        draftId: card.dataset.draftId,
      },
    };
  }
  async function xhsArticle(task) {
    auth();
    task._draftCount = /草稿箱[（(](\d+)/.exec(document.body.innerText)?.[1];
    if (!field('textarea[placeholder="输入标题"]')) {
      await clickText("写长文");
      const create = await wait(() => exact("新的创作"), "未找到新的创作入口");
      // The tab switch briefly retains the old landing controls before Vue mounts.
      await sleep(1000);
      click(exact("新的创作") || create);
    }
    const title = await wait(
      () => field('textarea[placeholder="输入标题"]'),
      "小红书长文标题框未出现",
    );
    textField(title, task.title);
    const editor = await wait(
      () =>
        field(
          "[contenteditable=true].tiptap,[contenteditable=true].ProseMirror",
        ),
      "小红书长文编辑器未出现",
    );
    await status(task, "filling", "填入小红书长文与章节");
    await fillArticle(task, editor, "xiaohongshu");
    const r = await saveXhs(task);
    if (task.aiGenerated)
      r.warnings = ["长文后续排版/发布时，请在平台确认 AI 内容声明"];
    return r;
  }
  async function xArticle(task) {
    auth();
    const create = document.querySelector("button[aria-label=create]");
    if (create) click(create);
    const title = await wait(
      () => field('textarea[placeholder="Add a title"]'),
      "X Articles 尚不可用，请确认账号资格与登录状态",
    );
    if (title.value.trim())
      attention("当前 X 草稿已有标题，请新建空白文章后重试");
    textField(title, task.title);
    const editor = await wait(
      () => field("[data-testid=composer][contenteditable=true]"),
      "未找到 X Articles 编辑器",
    );
    await status(task, "filling", "填入 X Articles 正文");
    await fillArticle(task, editor, "x");
    await status(task, "saving", "等待 X 自动保存");
    await wait(
      () =>
        /Last saved/.test(document.body.innerText) &&
        !/Saving\.\.\.|Uploading media|Processing media/.test(
          document.body.innerText,
        ),
      "未确认 X 自动保存，请打开草稿检查",
      45000,
    );
    if (!/\/compose\/articles\/edit\/\d+/.test(location.pathname))
      attention("X 未返回独立的草稿地址，请打开编辑器检查");
    const saved = result(task, "X 显示 Last saved，且已返回独立文章草稿地址");
    if (task._repaired)
      saved.warnings = ["有段落是核对后补回的，补回的段落可能没有加粗和链接"];
    return saved;
  }
  function wechatBody() {
    const selector =
      '.ProseMirror[contenteditable="true"], #js_editor [contenteditable="true"], #ueditor_0[contenteditable="true"], [contenteditable="true"][data-placeholder*="正文"], [contenteditable="true"][role="textbox"][aria-label*="正文"]';
    const direct = field(selector);
    if (direct) return direct;
    for (const iframe of document.querySelectorAll(
      "#ueditor_0, .edui-editor-iframeholder iframe, #js_editor iframe",
    )) {
      try {
        if (visible(iframe) && iframe.contentDocument?.body?.isContentEditable)
          return iframe.contentDocument.body;
      } catch {}
    }
    return null;
  }
  async function wechatArticle(task) {
    auth();
    const page = new URL(location.href);
    if (
      page.pathname !== "/cgi-bin/appmsg" ||
      page.searchParams.get("t") !== "media/appmsg_edit_v2" ||
      page.searchParams.get("type") !== "10" ||
      page.searchParams.get("action") !== "edit" ||
      page.searchParams.get("isNew") !== "1" ||
      page.searchParams.has("appmsgid")
    )
      attention(
        "请在公众号草稿箱点击「新的创作 → 文章」，打开新文章编辑器后再填充；也可在工作台复制微信正文粘贴。",
      );
    const title = await wait(
      () =>
        field(
          '#title, #js_title, input[placeholder*="标题"], textarea[placeholder*="标题"]',
        ),
      "未找到公众号文章标题，请在工作台复制标题和微信正文手动粘贴",
    );
    const editor = await wait(
      wechatBody,
      "未找到公众号正文编辑器，请在工作台复制微信正文手动粘贴",
    );
    const digest = field(
      '#js_description, #digest, textarea[name="digest"], textarea[placeholder*="摘要"]',
    );
    const assertEmpty = () => {
      if (
        norm(title.value || title.textContent) ||
        norm(plainText(editor)) ||
        editor.querySelector("img,video,iframe") ||
        norm(digest?.value || digest?.textContent)
      )
        attention(
          "编辑器已有内容，已停止以保留你的修改。请新建文章后重试，或在工作台复制正文手动粘贴。",
        );
    };
    assertEmpty();
    if (!task.prepared?.wechat) throw new Error("缺少微信正文，请重新导入文章");
    await status(task, "filling", "准备公众号新文章正文");
    let token = page.searchParams.get("token"),
      user = "",
      ticket = "",
      time = "";
    if (task.prepared.wechat.includes("<img")) {
      const home = await fetch("/", { credentials: "include" });
      const source = await home.text();
      const find = (pattern) => pattern.exec(source)?.[1] || "";
      token ||= find(/data:\s*\{[\s\S]*?t:\s*["']([^"']+)["']/);
      user = find(/user_name:\s*["']([^"']+)["']/);
      ticket = find(/ticket:\s*["']([^"']+)["']/);
      time = find(/time:\s*["'](\d+)["']/);
      if (!token || !user || !ticket)
        attention(
          "未读取到公众号图片上传凭据，请重新登录；也可在工作台复制微信正文手动粘贴。",
        );
    }
    const doc = new DOMParser().parseFromString(
      "<html><body>" + task.prepared.wechat + "</body></html>",
      "text/html",
    );
    let n = 0;
    for (const img of [...doc.querySelectorAll("img")]) {
      const id =
        img.getAttribute("data-asset-id") ||
        img.getAttribute("src")?.replace("publisher-asset:", "");
      const asset = task.assets.find((a) => a.id === id);
      if (!asset) throw new Error("配图清单不匹配");
      await status(
        task,
        "uploading",
        `上传公众号图片 ${++n} / ${task.prepared.media.length}`,
      );
      const f = await file(task, asset),
        form = new FormData();
      form.set("type", f.type);
      form.set("id", String(Date.now()));
      form.set("name", f.name);
      form.set("size", String(f.size));
      form.set("lastModifiedDate", new Date().toString());
      form.set("file", f, f.name);
      const query = new URLSearchParams({
        action: "upload_material",
        f: "json",
        scene: "8",
        writetype: "doublewrite",
        groupid: "1",
        ticket_id: user,
        ticket,
        svr_time: time || String((Date.now() / 1000) | 0),
        token,
        lang: "zh_CN",
        seq: String(Date.now()),
      });
      const response = await fetch("/cgi-bin/filetransfer?" + query, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const data = await response.json();
      if (data.base_resp?.ret !== 0 || !data.cdn_url)
        attention(
          "公众号图片上传失败：" + (data.base_resp?.err_msg || "请在平台确认"),
        );
      img.src = data.cdn_url;
      img.removeAttribute("data-asset-id");
    }
    doc.querySelectorAll("a").forEach((a) => {
      if (!/^https:\/\/([\w-]+\.)?weixin\.qq\.com\//.test(a.href))
        a.replaceWith(...a.childNodes);
    });
    assertEmpty();
    await status(task, "filling", "填入公众号文章标题和正文");
    textField(title, task.title);
    await richPaste(editor, doc.body.innerHTML);
    if (digest && task.description) textField(digest, task.description);
    return {
      state: "needs_attention",
      persisted: false,
      message:
        "已填入公众号新文章标题和正文。请核对配图、封面和摘要，并在平台保存草稿；最终发布由你确认。",
      editorUrl: location.href,
      resume: { title: task.title, kind: task.kind },
    };
  }
  function coverFile(task, roles) {
    for (const role of roles) {
      const asset = task.assets?.find((a) => a.role === role);
      if (asset) return asset;
    }
    return null;
  }
  function controlByText(texts, root = document) {
    const names = Array.isArray(texts) ? texts : [texts];
    const hit = exact(names, root);
    if (hit) return hit;
    const els = queryAll("button,[role=button],a,label,span,div", root).filter(
      visible,
    );
    for (const name of names) {
      const match = els
        .filter((el) => norm(el.textContent).replace(/^\+\s*/, "") === name)
        .sort(
          (a, b) =>
            a.querySelectorAll("*").length - b.querySelectorAll("*").length,
        )[0];
      if (match) return match.closest("button,[role=button],a,label") || match;
    }
    return null;
  }
  function openCoverHost() {
    const hosts = queryAll("[role=dialog],div,section")
      .filter((el) => {
        if (!visible(el)) return false;
        const text = norm(el.textContent);
        return (
          text.length < 8000 &&
          /上传封面|上传图片/.test(text) &&
          /完成|确认|确定/.test(text)
        );
      })
      .sort(
        (a, b) =>
          a.querySelectorAll("*").length - b.querySelectorAll("*").length,
      );
    return coverDialog() || hosts[0] || null;
  }
  function fileFromChunks(message) {
    const chunks = Array.isArray(message.chunks) ? message.chunks : [];
    if (!chunks.length || chunks.length > 32) throw new Error("没有封面数据");
    const parts = chunks.map((chunk) => {
      const binary = atob(chunk);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    });
    return new File(parts, message.name || "cover.png", {
      type: message.mime || "image/png",
    });
  }
  let armedCover = null;
  function deliverCover(target, image) {
    const host =
      target?.closest?.("[role=dialog], ytcp-uploads-dialog, form") ||
      openCoverHost() ||
      document;
    const input = (host && inputFor("image", host)) || coverFileInput();
    if (input) upload(input, image);
    if (typeof DragEvent === "function" && target) {
      const transfer = new DataTransfer();
      transfer.items.add(image);
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    }
  }
  function showDropHint(on) {
    let hint = document.querySelector("[data-omnipost-drop]");
    if (!on) {
      hint?.remove();
      return;
    }
    if (hint) return;
    hint = document.createElement("div");
    hint.setAttribute("data-omnipost-drop", "");
    hint.textContent = "松开鼠标，封面会放进这里";
    hint.style.cssText =
      "position:fixed;left:16px;bottom:16px;z-index:2147483646;padding:8px 12px;border-radius:8px;background:#103d36;color:#dbffb3;font:13px/1.4 sans-serif";
    document.documentElement.append(hint);
  }
  document.addEventListener(
    "dragover",
    (event) => {
      if (!armedCover) return;
      event.preventDefault();
    },
    true,
  );
  document.addEventListener(
    "drop",
    (event) => {
      if (!armedCover) return;
      if (event.dataTransfer?.files?.length) return;
      event.preventDefault();
      event.stopPropagation();
      const point =
        document.elementFromPoint(event.clientX, event.clientY) ||
        document.body;
      const image = armedCover;
      armedCover = null;
      showDropHint(false);
      deliverCover(point, image);
    },
    true,
  );
  function armCover(message) {
    armedCover = fileFromChunks(message);
    showDropHint(true);
  }
  function pageHost() {
    if (location.hostname) return location.hostname;
    const raw = String(location.origin || location.href || "");
    return raw.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0];
  }
  async function placeCover(message) {
    const image = fileFromChunks(message);
    if (pageHost().endsWith("youtube.com")) {
      const input = coverFileInput();
      if (!input)
        throw new Error(
          "左侧还没有缩略图。先点「填入这个页面」，等标题和缩略图出现后再点「替换缩略图」。",
        );
      await upload(input, image);
      return;
    }
    const dialog = openCoverHost();
    let input = (dialog && inputFor("image", dialog)) || coverFileInput();
    if (!input) {
      const button = controlByText(
        ["上传封面", "上传图片", "选择图片", "本地上传"],
        dialog || document,
      );
      if (!button)
        throw new Error("请先在页面上打开封面编辑，再点「用这张做封面」");
      click(button);
      input = await wait(() => coverFileInput(), "未找到封面文件选择框", 4000);
    }
    await upload(input, image);
  }
  function coverDialog() {
    return queryAll("div,section,[role=dialog]")
      .filter((el) => {
        if (!visible(el)) return false;
        const text = norm(el.textContent);
        return (
          text.length < 1500 &&
          (/上传/.test(text) || (/设置封面/.test(text) && /裁剪/.test(text))) &&
          /完成|确认|确定/.test(text)
        );
      })
      .sort(
        (a, b) =>
          a.querySelectorAll("*").length - b.querySelectorAll("*").length,
      )[0];
  }
  async function uploadCoverDialog(task, asset, ratios = [], keepOpen = false) {
    const directEdit = exact(["直接编辑"]);
    if (directEdit) click(directEdit);
    const dialog = await wait(
      () => coverDialog(),
      "封面编辑窗口没有打开",
      8000,
    );
    let input = inputFor("image", dialog);
    if (!input && task.platform === "xiaohongshu") input = coverFileInput();
    if (!input) {
      const button = controlByText(
        ["上传封面", "上传封面图片", "上传图片", "本地上传", "上传"],
        dialog,
      );
      if (!button) attention("封面窗口里没有上传按钮");
      click(button);
      input = await wait(
        () =>
          inputFor("image", coverDialog() || dialog) ||
          (task.platform === "xiaohongshu" && coverFileInput()),
        "未找到封面文件选择框",
        8000,
      );
    }
    await upload(input, await file(task, asset));
    await sleep(task.platform === "douyin" ? 1200 : 400);
    const openDialog = () => coverDialog() || dialog;
    if (ratios.length) {
      let ratio = exact(ratios, openDialog()) || exact(ratios);
      if (!ratio && task.platform === "xiaohongshu") {
        const crop =
          controlByText("裁剪", openDialog()) || controlByText("裁剪");
        if (crop) {
          click(crop);
          ratio = await wait(
            () => exact(ratios, openDialog()) || exact(ratios),
            "封面裁剪面板未提供比例「" + ratios[0] + "」",
            4000,
          );
        }
      }
      if (!ratio)
        note(task, "未找到封面比例「" + ratios[0] + "」，请在平台确认裁切");
      else {
        click(ratio);
        await sleep(200);
        const on =
          ratio.getAttribute("aria-pressed") === "true" ||
          ratio.getAttribute("aria-selected") === "true" ||
          ratio.classList.contains("active") ||
          /\b(active|selected|checked)\b/.test(ratio.className || "");
        if (!on)
          note(
            task,
            "已点封面比例「" + ratios[0] + "」，页面没有显示选中，请核对裁切",
          );
      }
    }
    if (keepOpen) return;
    await finishCoverDialog(task, dialog);
  }
  async function finishCoverDialog(task, dialog) {
    const openDialog = () => coverDialog() || dialog;
    const done = await wait(
      () => {
        const enabled = (control) =>
          control &&
          !control.disabled &&
          control.getAttribute("aria-disabled") !== "true";
        const control = controlByText(["完成", "确认", "确定"], openDialog());
        if (enabled(control)) return control;
        if (task.platform === "xiaohongshu" && controlByText("裁剪")) {
          const candidates = exactLeaves(document, "完成")
            .map((el) => el.closest('button,[role="button"]') || el)
            .filter(enabled);
          if (candidates.length === 1) return candidates[0];
        }
        return null;
      },
      "封面已选择，但窗口里的确认按钮仍不可用",
      8000,
    );
    click(done);
    if (task.platform === "douyin") {
      await sleep(1200);
      const current = coverDialog();
      const confirm = current && controlByText("完成", current);
      if (
        confirm &&
        !confirm.disabled &&
        confirm.getAttribute("aria-disabled") !== "true"
      )
        click(confirm);
    }
    await wait(
      () => !done.isConnected || !visible(done) || !coverDialog(),
      "封面窗口没有关闭，请在页面上确认封面",
      8000,
    );
  }
  function bilibiliCoverNeedsSyncReview() {
    return (
      /检测到个人空间封面[（(]16[:：]9[）)]未修改/.test(
        compact(document.body.innerText),
      ) &&
      ["不同步，手动编辑", "确认同步"].every(
        (label) => exactLeaves(document, label).length,
      )
    );
  }
  async function uploadBilibiliCoverDialog(task, asset) {
    const editor = await wait(
      () =>
        field(".cover-editor") ||
        queryAll('[role="dialog"]').find(
          (dialog) =>
            visible(dialog) && /上传封面|上传图片/.test(dialog.textContent),
        ),
      "B 站封面编辑窗口没有打开",
      8000,
    );
    if (!editor.matches(".cover-editor")) {
      await uploadCoverDialog(task, asset);
      return true;
    }

    const image = await file(task, asset);
    if (bilibiliCoverNeedsSyncReview()) return false;
    if (task.schedule && asset.role === "cover-landscape") {
      const syncLabel = () => {
        const wrappers = queryAll(".sync-checkbox-wrapper", editor).filter(
          (wrapper) =>
            visible(wrapper) && norm(wrapper.textContent) === "双比例同步改动",
        );
        if (wrappers.length !== 1) return null;
        const labels = queryAll("label", wrappers[0]).filter(visible);
        return labels.length === 1 ? labels[0] : null;
      };
      const checkbox = syncLabel();
      if (
        checkbox &&
        !checkbox.classList.contains("bcc-checkbox-checked") &&
        !checkbox.classList.contains("bcc-checkbox-disabled") &&
        !checkbox.querySelector("input:disabled")
      ) {
        click(checkbox);
        await wait(
          () => syncLabel()?.classList.contains("bcc-checkbox-checked"),
          "B 站未确认启用双比例同步改动，请核对封面",
          4000,
        );
      }
    }
    const input = await wait(
      () =>
        editor.querySelector(
          '.cover-upload input[type="file"][accept*="image"]',
        ),
      "未找到 B 站封面文件选择框",
      8000,
    );
    const preview = () =>
      editor.querySelector(".cover-upload .upload-area.has-image")?.style
        .backgroundImage;
    const previous = preview();
    await upload(input, image);
    await wait(
      () => {
        const current = preview();
        return current !== previous && /blob:|data:image\//.test(current || "");
      },
      "B 站没有显示刚选中的本地封面",
      8000,
    );

    const done = await wait(
      () => {
        const button = field(".cover-editor-button .button.submit", editor);
        return norm(button?.textContent) === "完成" &&
          !button.disabled &&
          button.getAttribute("aria-disabled") !== "true"
          ? button
          : null;
      },
      "B 站封面的完成按钮不可用",
      8000,
    );
    click(done);
    const outcome = await wait(
      () => {
        if (bilibiliCoverNeedsSyncReview()) return "review";
        if (
          !field(".cover-editor") &&
          field(".cover-img") &&
          !field(".cover-empty")
        )
          return "saved";
        return null;
      },
      "B 站没有确认保留封面，请核对当前投稿页",
      10000,
    );
    return outcome === "saved";
  }
  async function uploadChosenCover(task, openers, ratios = []) {
    const asset = coverFile(
      task,
      task.platform === "bilibili"
        ? ["cover-landscape", "cover", "cover-portrait"]
        : ["cover-portrait", "cover", "cover-landscape"],
    );
    if (!asset) return false;
    await status(task, "filling", "上传封面");
    let opener = controlByText(openers);
    if (task.platform === "bilibili")
      opener = field(".cover-empty .add-text") || opener;
    if (task.platform === "xiaohongshu" && task.kind === "video") {
      // The actual edit control is overlaid on the preview and can be hidden
      // until pointer hover. Avoid clicking the "设置封面" section heading.
      let tile = queryAll('[style*="spectrum/"]').find(visible);
      for (
        let level = 0;
        level < 4 && tile;
        level++, tile = tile.parentElement
      ) {
        const edit = queryAll("button,[role=button],label,span,div", tile).find(
          (el) => {
            const label = norm(el.textContent);
            return (
              openers.includes(label) &&
              (label !== "设置封面" ||
                el.matches('button,[role="button"],label')) &&
              !Array.from(el.children).some((child) =>
                openers.includes(norm(child.textContent)),
              )
            );
          },
        );
        if (edit) {
          opener = edit.closest('button,[role="button"],label') || edit;
          break;
        }
      }
    }
    if (!opener) attention("未找到封面入口，请在页面上打开封面编辑");
    click(opener);
    if (task.platform === "bilibili")
      return uploadBilibiliCoverDialog(task, asset);
    await uploadCoverDialog(task, asset, ratios);
    return true;
  }
  function coverEdit(label) {
    const seed = queryAll("div,span,p,li,section,button")
      .filter((el) => {
        const text = norm(el.textContent);
        return text === label || text.startsWith(label + " ");
      })
      .sort(
        (a, b) => norm(a.textContent).length - norm(b.textContent).length,
      )[0];
    if (!seed) return null;
    let node = seed;
    for (let i = 0; i < 8 && node; i++) {
      const edit = [
        ...node.querySelectorAll("button,div,span,[role=button]"),
      ].find((el) => {
        const text = norm(el.textContent);
        return text === "编辑" || text === "编辑封面";
      });
      if (edit) return edit.closest("button,[role=button]") || edit;
      node = node.parentElement;
    }
    return null;
  }
  async function uploadChannelCovers(task) {
    const slots = [
      [["cover-portrait", "cover"], "个人主页卡片"],
      [["cover-landscape"], "分享卡片"],
    ];
    let count = 0;
    for (const [roles, label] of slots) {
      const asset = coverFile(task, roles);
      if (!asset) continue;
      if (!count) await status(task, "filling", "上传封面");
      const edit = coverEdit(label);
      if (!edit) attention("未找到视频号「" + label + "」封面");
      click(edit);
      await uploadCoverDialog(task, asset);
      count++;
    }
    return count;
  }
  function douyinCoverOpener(direction) {
    const label = direction === "landscape" ? "横封面4:3" : "竖封面3:4";
    const otherLabel = direction === "landscape" ? "竖封面3:4" : "横封面4:3";
    for (const marker of exactLeaves(document, label)) {
      const card = sectionOf(
        marker.parentElement,
        (element) =>
          !compact(element.textContent).includes(otherLabel) &&
          (controlByText(["选择封面", "编辑封面"], element) ||
            queryAll("img", element).some(visible)),
      );
      if (card)
        return (
          controlByText(["选择封面", "编辑封面"], card) ||
          queryAll("img", card).find(visible)
        );
    }
    return null;
  }
  async function uploadDouyinCovers(task) {
    const slots = [
      [["cover-landscape"], "设置横封面", ["4:3", "4：3"]],
      [["cover-portrait", "cover"], "设置竖封面", ["3:4", "3：4"]],
    ].filter(([roles]) => coverFile(task, roles));
    if (!slots.length) return false;
    await status(task, "filling", "上传封面");
    const opener = controlByText(["选择封面", "编辑封面", "设置封面"]);
    if (!opener) attention("未找到封面入口，请在页面上打开封面编辑");
    click(opener);
    const dialog = await wait(
      () => coverDialog(),
      "封面编辑窗口没有打开",
      8000,
    );
    const preview = () => {
      const text = compact(document.body.innerText);
      if (
        text.includes("竖封面预览（3:4）") ||
        text.includes("竖封面预览(3:4)")
      )
        return "portrait";
      if (
        text.includes("横封面预览（4:3）") ||
        text.includes("横封面预览(4:3)")
      )
        return "landscape";
      return null;
    };
    const firstPreview = preview();
    if (firstPreview) {
      const otherPreview =
        firstPreview === "portrait" ? "landscape" : "portrait";
      const assets = {
        portrait: coverFile(task, ["cover-portrait", "cover"]),
        landscape: coverFile(task, ["cover-landscape"]),
      };
      if (assets[firstPreview])
        await uploadCoverDialog(
          task,
          assets[firstPreview],
          [],
          Boolean(assets[otherPreview]),
        );
      if (assets[otherPreview]) {
        const label =
          otherPreview === "landscape" ? "设置横封面" : "设置竖封面";
        const directionButton = () =>
          queryAll("button,[role=button]").find(
            (element) =>
              visible(element) && compact(element.textContent) === label,
          );
        if (directionButton()) {
          // The footer switch commits the current direction before opening the other.
          const switchCover = await wait(
            () => {
              const button = directionButton();
              return button &&
                !button.disabled &&
                button.getAttribute("aria-disabled") !== "true"
                ? button
                : null;
            },
            "抖音未开放「" + label + "」",
            12000,
          );
          click(switchCover);
        } else {
          // An existing preview can open a single-direction editor.
          if (!assets[firstPreview])
            attention("抖音打开了仅支持另一方向的封面窗口");
          await finishCoverDialog(task, dialog);
          const open = await wait(
            () => douyinCoverOpener(otherPreview),
            "未找到「" + label + "」卡片",
            8000,
          );
          click(open);
        }
        await wait(
          () => preview() === otherPreview,
          "抖音未切换到目标封面，请核对保留的页面",
          8000,
        );
        await uploadCoverDialog(task, assets[otherPreview]);
      }
      return true;
    }
    const tabbed = slots.some(
      ([_, label]) => exact(label, dialog) || exact(label),
    );
    if (!tabbed) {
      await uploadCoverDialog(
        task,
        coverFile(task, slots[0][0]),
        slots.length === 1 ? slots[0][2] : [],
      );
      if (slots.length > 1)
        note(task, "未找到抖音横竖封面页签，只上传了一张封面");
      return true;
    }
    for (let index = 0; index < slots.length; index++) {
      const [roles, label] = slots[index];
      const tab = exact(label, coverDialog() || dialog) || exact(label);
      if (tab) click(tab);
      await uploadCoverDialog(
        task,
        coverFile(task, roles),
        [],
        index < slots.length - 1,
      );
    }
    return true;
  }
  function bilibiliVideoInput(video) {
    const extension = /\.[^.]+$/.exec(video.name.toLowerCase())?.[0];
    const types = new Set(
      [extension, video.type.toLowerCase(), "video/*"].filter(Boolean),
    );
    const accepts = (input) =>
      input.isConnected &&
      !input.disabled &&
      (input.getAttribute("accept") || "")
        .toLowerCase()
        .split(",")
        .some((type) => types.has(type.trim()));
    const primary = queryAll(
      '.upload-wrp .bcc-upload-wrapper input[type="file"]',
    ).filter(accepts);
    if (primary.length === 1) return primary[0];
    if (queryAll(".upload-wrp, .micro-app").some((node) => node.isConnected))
      return null;
    const alternatives = queryAll('input[type="file"]').filter(accepts);
    return alternatives.length === 1 ? alternatives[0] : null;
  }
  function assertBilibiliUploadEmpty(input) {
    const existing = field('input[placeholder*="稿件标题"]');
    if (
      editorText(existing) ||
      input?.files?.length ||
      /上传中|上传完成/.test(document.body.innerText)
    )
      attention("当前 B 站投稿页已有视频，请先核对该稿件，避免重复上传");
  }
  async function bilibiliVideo(task) {
    auth();
    assertBilibiliUploadEmpty();
    await status(task, "uploading", "上传视频素材");
    const asset = task.assets.find((item) => item.role === "video");
    const video = await file(task, asset);
    // The current upload form can mount again while the local file is read.
    // Its real file input is hidden and the auxiliary app has a separate input.
    const input = await wait(() => {
      const candidate = bilibiliVideoInput(video);
      assertBilibiliUploadEmpty(candidate);
      return candidate;
    }, "未找到 B 站视频上传控件");
    assertBilibiliUploadEmpty(input);
    if (!input.isConnected)
      attention("B 站视频上传控件已变化，请核对当前投稿页");
    await upload(input, video);
    const title = await wait(
      () => field('input[placeholder*="稿件标题"]'),
      "等待 B 站编辑表单超时",
      300000,
    );
    textField(title, task.title);
    const desc = field(".ql-editor");
    if (desc) textField(desc, task.description || "");
    const copyMatches = () =>
      editorText(title) === task.title &&
      compact(editorText(desc)) === compact(task.description);
    for (const close of queryAll(
      ".tag-pre-wrp svg.close, .label-item-v2-container .close",
    ))
      if (visible(close)) click(close);
    const tags = tagList(task);
    const tagMax = PLATFORMS.bilibili.copy.video.tagMax;
    const tagInput = field(
      'input[placeholder*="创建标签"],input[placeholder*="标签"]',
    );
    if (tagInput) {
      for (const tag of tags.slice(0, tagMax)) {
        textField(tagInput, tag);
        if (typeof KeyboardEvent === "function") {
          const enter = {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            bubbles: true,
          };
          tagInput.dispatchEvent(new KeyboardEvent("keydown", enter));
          if (tagInput.value === tag)
            tagInput.dispatchEvent(new KeyboardEvent("keyup", enter));
        } else pressEnter(tagInput);
        await sleep(100);
        const chip = queryAll(
          ".label-item-v2-container, .tag-pre-wrp span",
        ).some((el) => norm(el.textContent) === tag);
        if (!chip)
          note(
            task,
            "标签「" + tag + "」没有出现在 B 站标签区，平台可能拒绝了它",
          );
      }
    } else if (tags.length) note(task, "未找到 B 站标签输入框");
    await waitUploadIdle();
    const uploads = queryAll(".task-list-content-item .task").filter(visible);
    if (uploads.length > 1)
      attention("当前 B 站稿件有多个视频，请核对分 P，避免重复投稿");
    if (task.category) await chooseBilibiliCategory(task.category.trim());
    const schedule = task.schedule
      ? await configureBilibiliSchedule(task, copyMatches)
      : null;
    const covered = await uploadChosenCover(task, [
      "更换封面",
      "添加封面",
      "上传封面",
    ]);
    if (!covered && bilibiliCoverNeedsSyncReview())
      return {
        ...schedule,
        state: "needs_attention",
        persisted: false,
        editorUrl: location.href,
        message: withNotes(
          task,
          [schedule?.evidence, "请在同步弹窗中核对 16:9 个人空间封面"]
            .filter(Boolean)
            .join("；"),
        ),
        warnings: task._notes,
      };
    if (schedule) {
      if (!covered || !bilibiliScheduleMatches(task, copyMatches))
        attention("B 站封面、定时或文案还待核对，请检查原页面");
      return {
        ...schedule,
        state: "schedule_ready",
        persisted: false,
        editorUrl: location.href,
        message: "已填入 B 站定时，请在原页面核对分区及稿件并提交",
        warnings: task._notes,
      };
    }
    attention(
      withNotes(
        task,
        covered
          ? "视频、标题、简介和封面已填入 B 站。请补创作声明和分区后自行投稿"
          : "视频和文案已填入 B 站。请补封面、创作声明和分区后自行投稿",
      ),
    );
  }
  async function ensureYoutubeUpload() {
    if (field('input[name="Filedata"]') || inputFor("video")) return;
    const create = exact(["创建", "Create"]);
    if (create) click(create);
    const opener = await wait(
      () => exact(["上传视频", "Upload videos", "Upload video"]),
      "没有找到「上传视频」。请从「创建」里打开上传窗口后再填入。",
      8000,
    );
    click(opener);
    await wait(
      () => field('input[name="Filedata"]') || inputFor("video"),
      "上传窗口还没有出现文件选择框",
      8000,
    );
  }
  async function youtubeVideo(task) {
    auth();
    await status(task, "uploading", "上传视频素材");
    await ensureYoutubeUpload();
    const asset = task.assets.find((item) => item.role === "video");
    const input = await wait(
      () => field('input[name="Filedata"]') || inputFor("video"),
      "未找到 YouTube 视频上传控件",
    );
    await upload(input, await file(task, asset));
    const boxes = () =>
      queryAll('#textbox[contenteditable="true"],[contenteditable="true"]');
    const title = await wait(() => boxes()[0], "未找到 YouTube 标题", 300000);
    textField(title, task.title);
    const desc = boxes()[1];
    if (desc) textField(desc, task.description || "");
    if (compact(plainText(title)) !== compact(task.title))
      attention("YouTube 没有接收标题");
    const thumb = coverFile(task, [
      "cover-landscape",
      "cover",
      "cover-portrait",
    ]);
    if (thumb) {
      const started = Date.now();
      let imageInput = null;
      while (Date.now() - started < 15000) {
        imageInput = coverFileInput();
        if (imageInput) break;
        await sleep(350);
      }
      if (imageInput) await upload(imageInput, await file(task, thumb));
      else
        note(task, "左侧还没有缩略图位置。视频填入后，在侧栏点「替换缩略图」");
    }
    const tagInput = field(
      'input[aria-label="标签"],input[aria-label="Tags"],input[aria-label*="tag"]',
    );
    if (tagInput) {
      for (const tag of tagList(task)) {
        textField(tagInput, tag);
        pressEnter(tagInput);
      }
    }
    attention(
      withNotes(
        task,
        "视频已交给 YouTube，页面会把它存成私享视频。请核对标题、说明、缩略图，并自行选择是否面向儿童和公开范围。插件不会点发布",
      ),
    );
  }
  async function instagramVideo(task) {
    auth();
    await status(task, "uploading", "上传视频素材");
    const asset = task.assets.find((item) => item.role === "video");
    let input = inputFor("video");
    if (!input) {
      const entry = exact(["新帖子", "帖子"]);
      if (entry) click(entry);
      input = await wait(
        () => inputFor("video"),
        "未找到 Instagram 视频选择框。请先打开首页的新帖子",
        8000,
      );
    }
    await upload(input, await file(task, asset));
    const original = exact(["原版", "Original"]);
    if (original) click(original);
    else note(task, "未找到「原版」裁剪，默认比例可能会把横屏裁成方形");
    const caption = await wait(
      () =>
        field('[role="dialog"] [contenteditable="true"]') ||
        field("[contenteditable=true]"),
      "未找到 Instagram 配文框",
    );
    textField(caption, task.description || task.title);
    const cover = coverFile(task, [
      "cover-landscape",
      "cover",
      "cover-portrait",
    ]);
    if (cover) {
      const imageInput = queryAll("input[type=file]").find((el) =>
        /jpeg|png|image/i.test(el.getAttribute("accept") || ""),
      );
      if (imageInput && imageInput !== input)
        await upload(imageInput, await file(task, cover));
      else note(task, "未找到封面上传框，请在封面照片里自行选择");
    }
    attention(
      withNotes(
        task,
        "视频和配文已填入 Instagram。请确认裁剪、封面和配文后自行分享。插件不会点分享，也不会修改页面脚本",
      ),
    );
  }
  function exactLeaves(root, label) {
    return queryAll(
      'button,[role="button"],[role="option"],[role="heading"],h1,h2,h3,h4,h5,h6,p,span,li,td,div',
      root,
    ).filter(
      (el) =>
        visible(el) &&
        norm(el.textContent) === label &&
        !Array.from(el.children).some(
          (child) => norm(child.textContent) === label,
        ),
    );
  }
  function calendarCell(year, month, day) {
    const combined = [`${year}年 ${month}月`, `${year}年${month}月`];
    const visibleMonth =
      combined.some((label) => exactLeaves(document, label).length) ||
      (exactLeaves(document, `${year}年`).length &&
        exactLeaves(document, `${month}月`).length);
    if (!visibleMonth) return null;
    // The date grid and the clocks can share one popover. Unpadded days
    // distinguish the calendar rows from the hours/minutes columns.
    const roots = exactLeaves(document, "1")
      .map((dayOne) =>
        sectionOf(dayOne, (node) =>
          ["5", "8", "15", "22", String(day)].every(
            (label) => exactLeaves(node, label).length,
          ),
        ),
      )
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.querySelectorAll("*").length - b.querySelectorAll("*").length,
      );
    const days = roots[0] ? exactLeaves(roots[0], String(day)) : [];
    return days.length === 1 ? days[0] : null;
  }
  function sectionOf(label, predicate) {
    let node = label;
    for (let depth = 0; node && depth < 7; depth++, node = node.parentElement)
      if (predicate(node)) return node;
    return null;
  }
  function scheduleInput() {
    return queryAll('input,[role="textbox"]').find(
      (el) =>
        visible(el) &&
        /^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}$/.test(
          norm(el.value ?? el.textContent),
        ),
    );
  }
  function scheduleValue() {
    const input = scheduleInput();
    const parts = (input?.value ?? input?.textContent)?.match(/\d+/g);
    return (
      parts &&
      `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")} ${parts[3].padStart(2, "0")}:${parts[4]}`
    );
  }
  function schedulingControl() {
    const selector =
      'input[type="radio"],input[type="checkbox"],[role="switch"],[role="radio"],[role="checkbox"]';
    const toggle = ["定时发布", "定时发表"]
      .flatMap((text) => exactLeaves(document, text))
      .map((label) =>
        sectionOf(
          label,
          (el) =>
            norm(el.textContent) === norm(label.textContent) &&
            (el.matches(
              'input[type="radio"],input[type="checkbox"],[role="switch"],[role="radio"],[role="checkbox"]',
            ) ||
              el.querySelector(
                'input[type="radio"],input[type="checkbox"],[role="switch"],[role="radio"],[role="checkbox"]',
              )),
        ),
      )
      .find(Boolean);
    return toggle?.matches(selector) ? toggle : toggle?.querySelector(selector);
  }
  function schedulingEnabled() {
    const control = schedulingControl();
    return (
      control?.checked === true ||
      control?.getAttribute("aria-checked") === "true"
    );
  }
  async function enableScheduling() {
    if (scheduleInput() && schedulingEnabled()) return;
    const control = schedulingControl();
    if (
      !control ||
      control.disabled ||
      control.getAttribute("aria-disabled") === "true"
    )
      attention("平台定时开关不可用");
    if (!schedulingEnabled()) control.click();
    await wait(
      () => schedulingEnabled() && scheduleInput(),
      "平台未打开日期时间控件",
      5000,
    );
  }
  function pickerColumn(last) {
    const labels = (el) =>
      norm(el.textContent).match(/^(\d{2})(?:时|分)?$/)?.[1];
    const zeros = [
      ...exactLeaves(document, "00"),
      ...exactLeaves(document, last === 23 ? "00时" : "00分"),
    ];
    return zeros
      .map((zero) =>
        sectionOf(zero, (node) => {
          const numbers = new Set(
            queryAll("div,span,li,button", node)
              .filter(visible)
              .map(labels)
              .filter(Boolean)
              .map(Number),
          );
          return numbers.size === last + 1 && numbers.has(last);
        }),
      )
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.querySelectorAll("*").length - b.querySelectorAll("*").length,
      )[0];
  }
  function pickerPart(root, text, suffix) {
    return [...exactLeaves(root, text + suffix), ...exactLeaves(root, text)][0];
  }
  async function setDouyinTimePart(value, suffix, offset, last) {
    const matches = () => scheduleValue()?.slice(offset, offset + 2) === value;
    // The wheel can settle on an intermediate row when the requested
    // option starts outside its visible area.
    for (let attempt = 0; attempt < 8 && !matches(); attempt++) {
      const column = pickerColumn(last);
      if (!column) attention("抖音时分列表已关闭");
      const options = [
        ...exactLeaves(column, value + suffix),
        ...exactLeaves(column, value),
      ];
      if (!options.length)
        attention("抖音时分列表未找到选项 " + value + suffix);
      const moves = options
        .flatMap((option) => {
          const scroll = sectionOf(
            option.parentElement,
            (node) =>
              node.clientHeight > 0 &&
              node.scrollHeight > node.clientHeight &&
              /auto|scroll/.test(getComputedStyle(node).overflowY),
          );
          if (!scroll) return [];
          const row = option.getBoundingClientRect();
          const viewport = scroll.getBoundingClientRect();
          const position =
            scroll.scrollTop +
            row.top +
            row.height / 2 -
            viewport.top -
            viewport.height / 2;
          if (
            position < 0 ||
            position > scroll.scrollHeight - scroll.clientHeight
          )
            return [];
          return [
            {
              scroll,
              position,
              distance: Math.abs(position - scroll.scrollTop),
            },
          ];
        })
        .sort((a, b) => a.distance - b.distance);
      if (moves[0]) moves[0].scroll.scrollTop = moves[0].position;
      else options[0].click();
      await sleep(550);
    }
    if (!matches()) attention("抖音未接受预约时间选项 " + value + suffix);
  }
  async function setNativeTime(task, expected) {
    await enableScheduling();
    if (scheduleValue() === expected) return;
    const [date, clock] = expected.split(" ");
    const [year, month, day] = date.split("-").map(Number);
    const [hour, minute] = clock.split(":");
    const input = scheduleInput();
    input.focus?.();
    await sleep(150);
    if (!calendarCell(year, month, day) && !pickerColumn(23)) click(input);
    if (scheduleValue()?.split(" ")[0] !== date) {
      const dayButton = await wait(
        () => calendarCell(year, month, day),
        "当前日历无法唯一确认预约日期 " + date,
        5000,
      );
      click(dayButton);
      await wait(
        () => scheduleValue()?.startsWith(date),
        "平台未接受预约日期 " + date,
        4000,
      );
    }
    if (scheduleValue() === expected) return;
    if (task.platform === "douyin" && !pickerColumn(23)) {
      const currentClock = scheduleValue()?.split(" ")[1];
      const opener = currentClock && exactLeaves(document, currentClock)[0];
      if (!opener) attention("未找到抖音时间列表");
      click(opener);
    }
    const hours = await wait(() => pickerColumn(23), "未找到小时列表", 4000);
    const minutes = await wait(() => pickerColumn(59), "未找到分钟列表", 4000);
    if (task.platform === "douyin") {
      await setDouyinTimePart(hour, "时", 11, 23);
      await setDouyinTimePart(minute, "分", 14, 59);
    } else if (scheduleValue()?.slice(11, 13) !== hour) {
      click(pickerPart(hours, hour, "时"));
      await wait(
        () => scheduleValue()?.slice(11, 13) === hour,
        "平台未接受预约小时",
        4000,
      );
    }
    if (task.platform !== "douyin" && scheduleValue()?.slice(14) !== minute) {
      click(pickerPart(minutes, minute, "分"));
      await wait(
        () => scheduleValue() === expected,
        "平台未接受完整预约时间 " + expected,
        4000,
      );
    }
    scheduleInput()?.blur?.();
    await sleep(350);
    if (scheduleValue() !== expected)
      attention("日期选择器关闭后预约时间发生变化");
  }
  function bilibiliScheduleValue() {
    const date = field(".time-container .date-picker-date .date-show");
    const timer = field(".time-container .date-picker-timer .date-show");
    return date && timer
      ? norm(date.textContent) + " " + norm(timer.textContent)
      : "";
  }
  async function chooseBilibiliDate(date) {
    const [year, month, day] = date.split("-").map(Number);
    const calendarTitle = () => field(".date-picker-nav-title");
    if (!calendarTitle()) click(field(".time-container .date-picker-date"));
    const heading = await wait(calendarTitle, "B 站未打开预约日历", 4000);
    const monthIndex = (text) => {
      const match = /^(\d{4})年\s*(\d{1,2})月$/.exec(norm(text));
      return match ? Number(match[1]) * 12 + Number(match[2]) : NaN;
    };
    const target = year * 12 + month;
    const distance = target - monthIndex(heading.textContent);
    if (!Number.isInteger(distance) || Math.abs(distance) > 1)
      attention("B 站预约日历没有显示目标月份附近的日期");
    if (distance !== 0) {
      const arrow = field(distance > 0 ? ".next-btn-month" : ".prev-btn-month");
      if (!arrow || arrow.classList.contains("date-select-disabled"))
        attention("B 站预约日历无法切换目标月份");
      click(arrow);
      await wait(
        () => monthIndex(calendarTitle()?.textContent) === target,
        "B 站未显示目标月份",
        3000,
      );
    }
    const cell = await wait(
      () => {
        const options = queryAll(
          ".date-wrp .date-picker-body-item.date-item",
        ).filter(
          (item) =>
            visible(item) &&
            norm(item.textContent) === String(day) &&
            !item.classList.contains("date-item-disabled"),
        );
        return options.length === 1 ? options[0] : null;
      },
      "B 站不能唯一确认可选预约日期 " + date,
      4000,
    );
    click(cell);
    await wait(
      () => bilibiliScheduleValue().startsWith(date + " "),
      "B 站没有保留预约日期 " + date,
      4000,
    );
  }
  async function chooseBilibiliCategory(category) {
    const select = () => {
      const controls = queryAll(
        ".selector-container .select-controller",
      ).filter(visible);
      if (controls.length === 1) return controls[0];
      const heading = exactLeaves(document, "分区");
      if (heading.length !== 1) return null;
      const section = sectionOf(
        heading[0],
        (node) =>
          controls.filter((control) => node.contains(control)).length === 1,
      );
      return section && controls.find((control) => section.contains(control));
    };
    if (norm(select()?.textContent) === category) return;
    click(select());
    const option = await wait(
      () =>
        queryAll(".drop-list-v2-item-cont").find(
          (item) => visible(item) && norm(item.textContent) === category,
        ),
      "B 站没有显示指定分区「" + category + "」",
      5000,
    );
    click(option);
    await wait(
      () => norm(select()?.textContent) === category,
      "B 站未保留指定分区「" + category + "」",
      5000,
    );
  }
  async function chooseBilibiliTime([hour, minute]) {
    const clock = () => field(".time-container .date-picker-timer .date-show");
    const groups = () =>
      queryAll(".time-picker-panel-select-wrp").filter(visible);
    const parts = () => norm(clock()?.textContent).split(":");
    for (const [index, value] of [hour, minute].entries()) {
      if (parts()[index] === value) continue;
      if (!groups().length) click(clock());
      const choice = await wait(
        () => {
          const panels = groups();
          if (panels.length !== 2) return null;
          return [
            ...panels[index].querySelectorAll(".time-picker-panel-select-item"),
          ].find(
            (option) =>
              visible(option) &&
              norm(option.textContent) === value &&
              !option.classList.contains("time-select-disabled"),
          );
        },
        "B 站没有可选的预约时分 " + value,
        4000,
      );
      click(choice);
    }
  }
  function bilibiliZoneMatches() {
    return /^\(UTC\+08:00\)/.test(
      field(".date-picker-timezone-wrp input")?.value || "",
    );
  }
  function bilibiliScheduleMatches(task, copyMatches) {
    return (
      field(".time-container .switch-container")?.classList.contains(
        "switch-container-active",
      ) &&
      bilibiliZoneMatches() &&
      bilibiliScheduleValue() ===
        task.schedule.at.slice(0, 16).replace("T", " ") &&
      copyMatches()
    );
  }
  async function configureBilibiliSchedule(task, copyMatches) {
    const expected = task.schedule.at.slice(0, 16).replace("T", " ");
    const issue = scheduleWindowIssue(task.platform, task.schedule.at);
    if (issue) attention(issue);
    if (!copyMatches()) attention("B 站完整文案还待核对");
    await status(task, "filling", "写入 B 站原生定时");
    const toggle = field(".time-container .switch-container");
    if (!toggle) attention("B 站没有出现定时开关");
    if (!toggle.classList.contains("switch-container-active")) click(toggle);
    await wait(
      () => bilibiliZoneMatches() && bilibiliScheduleValue(),
      "B 站定时或 UTC+08:00 时区未开启",
      5000,
    );
    const [date, timeOfDay] = expected.split(" ");
    if (!bilibiliScheduleValue().startsWith(date + " "))
      await chooseBilibiliDate(date);
    await chooseBilibiliTime(timeOfDay.split(":"));
    const matches = () => bilibiliScheduleMatches(task, copyMatches);
    await wait(matches, "B 站未完整显示预约时间 " + expected, 5000);
    if (task.aiGenerated) {
      await status(task, "filling", "核对 B 站创作声明");
      const disclosure = () => field('input[placeholder*="创作声明"]');
      if (!disclosure()) attention("B 站未显示创作声明，请核对原页面");
      const { statement } = PLATFORMS.bilibili.schedule.disclosure;
      if (disclosure().value !== statement) {
        click(disclosure());
        await clickText(statement);
      }
      await wait(
        () => disclosure()?.value === statement,
        "B 站未保留创作声明「" + statement + "」",
        4000,
      );
    }
    const collection = task.collection ?? task.schedule.collection;
    if (collection) await selectVideoCollection(collection, task.platform);
    if (!matches()) attention("B 站定时或文案发生变化，请核对原页面");
    return {
      scheduledAt: task.schedule.at,
      evidence: "B 站编辑器显示定时 " + expected + " (UTC+08:00)",
    };
  }
  async function selectVideoCollection(collection, platform) {
    if (!collection) return;
    const selected = () =>
      ["加入合集", "添加合集", "合集"].some((label) =>
        exactLeaves(document, label).some((el) =>
          sectionOf(
            el,
            (node) =>
              exactLeaves(node, collection).length === 1 &&
              !exactLeaves(node, "创建合集").length &&
              !exactLeaves(node, "选择合集").length &&
              !exactLeaves(node, "请选择合集").length &&
              norm(node.textContent).length < 180,
          ),
        ),
      );
    if (selected()) return;
    const opener = controlByText(["选择合集", "请选择合集"]);
    if (!opener) attention("未找到平台合集入口");
    click(opener);
    const item = await wait(
      () => {
        const options = exactLeaves(document, collection);
        return options.length === 1 ? options[0] : null;
      },
      "未找到唯一的合集「" + collection + "」",
      6000,
    );
    if (platform === "douyin") {
      const row =
        item.closest('[role="option"]') ||
        sectionOf(
          item,
          (node) =>
            compact(node.textContent).startsWith(compact(collection)) &&
            /共\d+个作品$/.test(compact(node.textContent)),
        ) ||
        item;
      // Use the point over the title that the creator's dropdown exposes
      // for selection. Scrolling the portal can dismiss it.
      const bounds = item.getBoundingClientRect();
      const point = {
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
      };
      const actual = item.ownerDocument.elementFromPoint?.(
        point.clientX,
        point.clientY,
      );
      const target = actual && row.contains(actual) ? actual : item;
      const options = {
        ...point,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      if (typeof PointerEvent === "function")
        target.dispatchEvent(
          new PointerEvent("pointerdown", {
            ...options,
            pointerType: "mouse",
            isPrimary: true,
          }),
        );
      if (typeof MouseEvent === "function") {
        for (const type of ["mousedown", "mouseup", "click"])
          target.dispatchEvent(new MouseEvent(type, options));
      } else target.click();
    } else click(item);
    await wait(selected, "平台未确认选中合集「" + collection + "」", 5000);
  }
  async function selectVideoDisclosure(task) {
    if (!task.aiGenerated) return;
    const rule = PLATFORMS[task.platform].schedule.disclosure;
    if (!rule) {
      note(task, "请在平台核对 AI 内容声明");
      return;
    }
    const { opener, statement, confirm } = rule;
    const control = controlByText(opener);
    const disclosureOption = () =>
      controlByText(statement) ||
      exactLeaves(document, statement)[0] ||
      queryAll('button,[role="option"],[role="menuitem"],label,li,span,div')
        .filter(
          (element) =>
            visible(element) &&
            compact(element.textContent) === compact(statement),
        )
        .sort(
          (a, b) =>
            a.querySelectorAll("*").length - b.querySelectorAll("*").length,
        )[0];
    if (control) {
      click(control);
      await sleep(500);
      if (!disclosureOption() && task.platform === "xiaohongshu") {
        const row = sectionOf(
          control,
          (node) =>
            norm(node.textContent) === opener &&
            node.querySelector('svg,i,[role="combobox"],[aria-haspopup]'),
        );
        if (row) {
          const bounds = row.getBoundingClientRect();
          const root = row.getRootNode();
          const arrow = root.elementFromPoint?.(
            bounds.right - 10,
            bounds.top + bounds.height / 2,
          );
          const trigger =
            arrow && row.contains(arrow)
              ? arrow
              : queryAll('svg,i,[role="combobox"],[aria-haspopup]', row)
                  .filter(visible)
                  .at(-1);
          if (trigger && typeof MouseEvent === "function") {
            // The disclosure dropdown can put its handler on the chevron,
            // independently of the adjacent text label.
            for (const type of ["mousedown", "mouseup", "click"])
              trigger.dispatchEvent(
                new MouseEvent(type, { bubbles: true, composed: true }),
              );
          } else if (trigger?.click) click(trigger);
          else if (row !== control) click(row);
        }
      }
      click(
        await wait(
          disclosureOption,
          "未找到平台 AI 声明「" + statement + "」",
          8000,
        ),
      );
      if (confirm) await clickText(confirm);
    }
    await wait(disclosureOption, "平台未确认 AI 内容声明", 5000);
  }
  async function configureVideoSchedule(task, coverOk, copyMatches) {
    const schedule = task.schedule;
    const { collectionAfterTime, submitLabel, receiptPath } =
      PLATFORMS[task.platform].schedule;
    const expected = schedule.at.slice(0, 16).replace("T", " ");
    const collection = task.collection ?? schedule.collection;
    const issue = scheduleWindowIssue(task.platform, schedule.at);
    if (issue) attention(issue);
    if (
      !coverOk ||
      task._notes?.some((note) =>
        /没有完整写入|只上传了一张|未找到封面比例|核对裁切/.test(note),
      )
    )
      attention("请先核对文案和要求的封面，再继续设置定时");
    if (!collectionAfterTime) {
      await status(task, "filling", "选择合集");
      await selectVideoCollection(collection, task.platform);
    }
    await status(task, "filling", "写入平台原生定时");
    await setNativeTime(task, expected);
    if (!copyMatches()) attention("设置定时后标题或描述发生变化，已保留原页面");
    const ready = {
      state: "schedule_ready",
      persisted: false,
      scheduledAt: schedule.at,
      editorUrl: location.href,
      evidence:
        "平台编辑器显示定时 " +
        expected +
        (collection ? "，合集「" + collection + "」" : ""),
    };
    await status(task, "filling", "核对平台内容声明");
    try {
      await selectVideoDisclosure(task);
    } catch (error) {
      if (
        !error.needsAttention ||
        !copyMatches() ||
        scheduleValue() !== expected ||
        !schedulingEnabled()
      )
        throw error;
      if (collectionAfterTime)
        await selectVideoCollection(collection, task.platform);
      return {
        ...ready,
        message: "定时和合集已写入，AI 声明待确认，尚未提交",
        warnings: [...(task._notes || []), error.message],
      };
    }
    if (collectionAfterTime) {
      await status(task, "filling", "选择合集");
      await selectVideoCollection(collection, task.platform);
    }
    if (!schedule.submit || task.fillOnly || !submitLabel)
      return {
        ...ready,
        message: "已填入定时，请在原页面核对并提交",
        warnings: task._notes,
      };
    const button = queryAll('button,[role="button"]').find(
      (el) =>
        visible(el) &&
        !el.disabled &&
        el.getAttribute("aria-disabled") !== "true" &&
        norm(el.textContent) === submitLabel,
    );
    if (
      !button ||
      !schedulingEnabled() ||
      scheduleValue() !== expected ||
      scheduleWindowIssue(task.platform, schedule.at)
    )
      attention("无法核对平台定时提交按钮或完整预约时间");
    // General editing helpers still reject Publish. Only the verified
    // scheduled action above may be submitted with the explicit CLI flag.
    const beforeUrl = location.href;
    if (/发布成功|预约成功/.test(document.body.innerText))
      attention("页面已有成功提示，请核对对应作品，避免重发");
    let accepted;
    try {
      accepted = await status(
        task,
        "submitting",
        "提交平台原生定时 " + expected,
      );
    } catch (error) {
      accepted = { error: error.message };
    }
    if (accepted?.ok !== true)
      return {
        ...ready,
        message: "定时已写入，提交状态未保存，尚未点击提交",
        warnings: [...(task._notes || []), accepted?.error].filter(Boolean),
      };
    if (
      !schedulingEnabled() ||
      scheduleValue() !== expected ||
      !button.isConnected ||
      !visible(button) ||
      button.disabled ||
      button.getAttribute("aria-disabled") === "true" ||
      norm(button.textContent) !== submitLabel ||
      scheduleWindowIssue(task.platform, schedule.at) ||
      !copyMatches()
    )
      return {
        ...ready,
        state: "needs_attention",
        message: "点击提交前的平台状态发生变化，请核对原页面",
      };
    button.click();
    try {
      const receipt = await wait(
        () => {
          const result =
            document.body.innerText.match(/定时发布成功|预约成功|发布成功/);
          if (result && !scheduleInput()) return result[0];
          if (
            receiptPath?.test(location.pathname) &&
            location.href !== beforeUrl
          )
            return "小红书进入发布成功页";
          return null;
        },
        "未取得平台回执",
        20000,
      );
      return {
        ...ready,
        state: "scheduled",
        persisted: true,
        message: "平台已确认定时 " + expected,
        evidence: ready.evidence + "；" + receipt,
      };
    } catch {
      return {
        ...ready,
        state: "schedule_unconfirmed",
        message: "已点击定时提交但没有回执；先核对作品管理，避免重发",
      };
    }
  }
  async function video(task) {
    auth();
    if (
      task.platform === "channels" &&
      /\/platform\/post\/coverEdit\/?$/.test(location.pathname)
    ) {
      await fillChannelsCopy(task, 30000);
      attention(
        withNotes(
          task,
          "描述和短标题已写入修改页；请核对后自行点完成。插件不会点完成",
        ),
      );
    }
    let channelsReuse = false;
    if (task.fillOnly) {
      const uploaded = queryAll("video").some(
        (el) => el.currentSrc || el.src || el.querySelector("source[src]"),
      );
      if (task.platform === "channels") {
        const desc = channelsDescription();
        const title = channelsTitle();
        const started = uploaded || Boolean(editorText(title));
        if (started && desc && !editorText(desc)) channelsReuse = true;
        else if (started || editorText(desc))
          attention(
            "页面已有内容，请先核对或打开空白发布页，避免覆盖或重复上传",
          );
      } else {
        const fields = queryAll(
          "input:not([type]),input[type=text],textarea,[contenteditable=true]",
        );
        const existing = fields.some(
          (el) => visible(el) && norm(el.value || el.textContent),
        );
        if (existing || uploaded)
          attention(
            "页面已有内容，请先核对或打开空白发布页，避免覆盖或重复上传",
          );
      }
    }
    if (channelsReuse) {
      await fillChannelsCopy(task, 30000);
      attention(
        withNotes(
          task,
          "描述已写入当前页；请核对后自行保存或发表。插件不会点发表",
        ),
      );
    }
    task._draftCount = /草稿箱[（(](\d+)/.exec(document.body.innerText)?.[1];
    await status(task, "uploading", "上传视频素材");
    const asset = task.assets.find((a) => a.role === "video");
    let input = inputFor("video");
    if (!input && task.platform === "xiaohongshu") {
      const uploadTab = exact("上传视频");
      if (uploadTab) click(uploadTab);
      input = await wait(() => inputFor("video"), "未找到小红书视频上传控件");
    }
    if (!input && task.platform === "x")
      input = await wait(
        () => document.querySelector('input[type=file][accept*="video"]'),
        "未找到 X 视频上传控件",
      );
    if (!input && task.platform === "douyin")
      input = await wait(
        () => inputFor("video") || document.querySelector("input[type=file]"),
        "抖音上传页未出现视频选择框，请检查账号和页面",
        20000,
      );
    if (!input) attention("未找到视频上传控件，请先进入平台的视频上传页");
    await upload(input, await file(task, asset));
    if (task.platform === "xiaohongshu") {
      const title = await wait(
        () =>
          field(
            'input[placeholder*="填写标题"],input[placeholder*="请输入标题"]',
          ),
        "等待视频编辑页面超时",
        300000,
      );
      await wait(
        () => {
          const save = document.querySelector("xhs-publish-btn");
          const cover = document.querySelector('[style*="spectrum/"]');
          return (
            cover &&
            save?.getAttribute("save-disabled") === "false" &&
            !/上传中|正在上传|转码中/.test(document.body.innerText)
          );
        },
        "等待小红书视频上传与封面准备完成",
        300000,
      );
      textField(title, task.title);
      const desc = await wait(
        () => field("[contenteditable=true]"),
        "未找到视频简介框",
      );
      textField(desc, task.description || "");
      await confirmTopics(task, desc);
      await sleep(1000);
      if (
        title.value !== task.title ||
        compact(plainText(desc)) !== compact(task.description || "")
      )
        attention("平台仍在初始化视频文案，请检查保留的页面");
      const covered = await uploadChosenCover(
        task,
        ["编辑封面", "设置封面", "修改封面"],
        ["3:4", "3：4"],
      );
      if (task.schedule)
        return configureVideoSchedule(
          task,
          covered,
          () =>
            title.value === task.title &&
            compact(plainText(desc)) === compact(task.description || ""),
        );
      if (task.fillOnly)
        attention(
          covered
            ? "视频、文案和封面已填入；请检查 AI 声明后自行保存或发布"
            : "视频与文案已填入；请检查封面和 AI 声明后自行保存或发布",
        );
      const saved = await saveXhs(task);
      const warnings = [...(task._notes || [])];
      if (task.aiGenerated) warnings.unshift("发布前请在平台确认 AI 内容声明");
      if (warnings.length) saved.warnings = warnings;
      return saved;
    }
    if (task.platform === "channels") {
      await fillChannelsCopy(task);
      await waitUploadIdle();
      const covered = await uploadChannelCovers(task);
      if (task.schedule)
        return configureVideoSchedule(
          task,
          covered,
          () =>
            editorText(channelsTitle()) === task.title &&
            compact(editorText(channelsDescription())) ===
              compact(task.description || ""),
        );
      if (task.fillOnly)
        attention(
          withNotes(
            task,
            covered
              ? "视频、文案和封面已填入；请检查上传进度和 AI 声明后自行保存或发布"
              : "视频与文案已填入；请检查上传进度、短标题和 AI 声明后自行保存或发布",
          ),
        );
      const save = exact(["保存草稿", "暂存离开"]);
      if (!save)
        attention(
          "视频与文案已准备，平台未提供可确认的保存草稿按钮，请在原页面继续编辑",
        );
      click(save);
      const proof = await wait(
        () => /草稿保存成功|已保存草稿|暂存成功/.test(document.body.innerText),
        "未确认视频号草稿保存，请打开原页面检查",
      );
      return result(task, "视频号显示保存草稿成功");
    }
    if (task.platform === "douyin") {
      const title = await wait(
        () => {
          const input = douyinTitle();
          if (input) return input;
          const editable = field("[contenteditable=true]");
          if (editable && !douyinDescription(null)) return editable;
          return null;
        },
        "等待抖音编辑表单超时",
        300000,
      );
      const copy = task.description || "";
      const desc = copy
        ? await wait(
            () => douyinDescription(title),
            "未找到抖音作品描述",
            60000,
          )
        : null;
      if (desc && desc !== title) {
        textField(title, task.title);
        await fillEditable(desc, copy, { pasteFirst: copy.includes("\n") });
        if (compact(plainText(desc)) !== compact(copy))
          note(task, "作品描述没有完整写入，请在描述框核对");
      } else if (title.matches("input,textarea")) {
        textField(title, task.title);
        if (copy) note(task, "作品描述没有完整写入，请在描述框核对");
      } else
        await fillEditable(
          title,
          [task.title, copy].filter(Boolean).join("\n"),
        );
      const topicsHost = desc && desc !== title ? desc : title;
      if (topicsHost) await confirmTopics(task, topicsHost);
      await waitUploadIdle();
      const covered = await uploadDouyinCovers(task);
      if (task.schedule)
        return configureVideoSchedule(
          task,
          covered,
          () =>
            editorText(title) === task.title &&
            compact(editorText(desc)) === compact(copy),
        );
      attention(
        withNotes(
          task,
          covered
            ? "视频、文案和封面已填入抖音；请核对后自行发布"
            : "视频与文案已填入抖音；请检查封面后自行发布",
        ),
      );
    }
    const editor = await wait(
      () => field('[data-testid="tweetTextarea_0"][contenteditable=true]'),
      "未找到 X 视频文案框",
      300000,
    );
    if (norm(editor.textContent))
      attention("X 编辑框已有内容，请在原页面继续编辑");
    const copy = task.description || task.title;
    const description = document.createElement("p");
    description.textContent = copy;
    await richPaste(editor, description.outerHTML);
    let weight = 0;
    for (const ch of copy) weight += ch.charCodeAt(0) > 127 ? 2 : 1;
    if (weight > 280)
      note(task, "文案按中文计 2、英文计 1 已超过 280，发出需要 Premium");
    await wait(
      () =>
        document.querySelector("video") &&
        /: Ready|上传完成|视频已上传/.test(document.body.innerText),
      "视频仍在上传，请稍后在平台保存",
      300000,
    );
    await sleep(500);
    if (compact(editor.textContent) !== compact(task.description || task.title))
      attention("视频文案完整性校验未通过，请检查保留的编辑页面");
    if (task.fillOnly)
      attention(
        withNotes(task, "视频与文案已填入；请检查封面后自行保存或发布"),
      );
    const close = document.querySelector('[data-testid="app-bar-close"]');
    if (!close) attention("X 视频已准备，请手动关闭编辑器并选择保存草稿");
    click(close);
    await clickText(["Save", "保存"]);
    await wait(
      () =>
        /post was saved|saved.*draft|草稿已保存|已保存到草稿/i.test(
          document.body.innerText,
        ) || !location.pathname.startsWith("/compose/post"),
      "未确认 X 已离开保存窗口",
      15000,
    );
    const compose = document.querySelector('a[href="/compose/post"]');
    if (compose) compose.click();
    await clickText(["Drafts", "草稿"]);
    const row = await wait(
      () => xVideoDraftRow(task),
      "草稿箱未找到对应视频，请检查平台，避免重复创建",
      20000,
    );
    const saved = result(
      task,
      "X 草稿箱出现匹配文案与视频缩略图",
      "https://x.com/compose/post/unsent/drafts",
    );
    if (task._notes?.length) saved.warnings = task._notes;
    return saved;
  }
  function xVideoDraftRow(task) {
    const rows = [
      ...document.querySelectorAll('[data-testid="unsentTweet"]'),
    ].filter(
      (row) =>
        compact(row.querySelector('[data-testid="tweetText"]')?.textContent) ===
          compact(task.description || task.title) &&
        row.querySelector('a[href*="video_thumb"]'),
    );
    if (rows.length > 1)
      attention("存在多个相同视频草稿，请在平台选择，避免打开错误条目");
    return rows[0]?.closest("button");
  }

  async function resume(task) {
    if (task.platform === "x" && task.kind === "video") {
      const row = await wait(
        () => xVideoDraftRow(task),
        "请在 X 草稿箱中选择对应视频",
        15000,
      );
      click(row);
      await wait(
        () =>
          field('[data-testid="tweetTextarea_0"][contenteditable=true]') &&
          document.querySelector("video"),
        "X 视频草稿尚未恢复",
      );
      return;
    }
    if (task.platform !== "xiaohongshu") return;
    const currentTitle = field(
      'textarea[placeholder="输入标题"],input[placeholder*="填写标题"],input[placeholder*="请输入标题"]',
    );
    if (currentTitle?.value === task.title) return;
    const drafts = exact("草稿箱");
    const candidate =
      drafts ||
      [...document.querySelectorAll("button,div,span")]
        .filter(visible)
        .find(
          (e) =>
            /^草稿箱[（(]\d+/.test(norm(e.textContent)) &&
            e.textContent.length < 20,
        );
    if (candidate) click(candidate);
    const card = await wait(
      () => {
        const cards = [
          ...document.querySelectorAll(".draft-item[data-draft-id]"),
        ].filter(visible);
        if (task.resume?.draftId)
          return cards.find((el) => el.dataset.draftId === task.resume.draftId);
        const matches = cards.filter(
          (el) =>
            norm(el.querySelector(".draft-title-text")?.textContent) ===
            task.title,
        );
        if (matches.length > 1)
          attention("存在同名草稿，请在平台选择需要编辑的条目");
        return matches[0];
      },
      "请在平台草稿箱中选择“" + task.title + "”",
      10000,
    );
    const edit = exact("编辑", card);
    if (!edit) attention("未找到该草稿的编辑入口");
    click(edit);
    await wait(
      () =>
        field(
          'textarea[placeholder="输入标题"],input[placeholder*="填写标题"],input[placeholder*="请输入标题"]',
        )?.value === task.title,
      "尚未恢复对应草稿，请在原页面检查",
    );
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === "ARM_COVER" || message?.type === "PLACE_COVER") {
      const run =
        message.type === "ARM_COVER"
          ? Promise.resolve().then(() => armCover(message))
          : placeCover(message);
      run
        .then(() => reply({ ok: true }))
        .catch((error) => reply({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type !== "RUN_DRAFT") return false;
    const task = message.task;
    const platform = PLATFORMS[task.platform];
    if (!platform || new URL(platform.url).origin !== location.origin) {
      reply({ ok: false, error: "当前页面与目标平台不匹配" });
      return false;
    }
    const heartbeat = setInterval(
      () =>
        chrome.runtime
          .sendMessage({ type: "CONTENT_HEARTBEAT", id: task.id })
          .catch(() => {}),
      20000,
    );
    (async () => {
      if (message.resumeOnly) {
        await resume(task);
        return {
          state: "needs_attention",
          message: "已打开现有草稿",
          resumed: true,
          editorUrl: location.href,
        };
      }
      if (task.kind === "article") {
        if (task.platform === "wechat") return wechatArticle(task);
        if (task.platform === "xiaohongshu") return xhsArticle(task);
        if (task.platform === "x") return xArticle(task);
      }
      if (task.schedule) {
        const issue = scheduleWindowIssue(task.platform, task.schedule.at);
        if (issue) attention(issue);
      }
      if (task.platform === "bilibili") return bilibiliVideo(task);
      if (task.platform === "youtube") return youtubeVideo(task);
      if (task.platform === "instagram") return instagramVideo(task);
      return video(task);
    })()
      .then((result) => reply({ ok: true, result }))
      .catch((error) =>
        reply({
          ok: true,
          result: {
            state: error.needsAttention ? "needs_attention" : "failed",
            persisted: false,
            message: error.message,
            editorUrl: location.href,
            resume: { title: task.title, kind: task.kind },
          },
        }),
      )
      .finally(() => clearInterval(heartbeat));
    return true;
  });
})();
