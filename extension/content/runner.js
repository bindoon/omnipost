(() => {
  if (globalThis.__OMNIPOST__) return;
  globalThis.__OMNIPOST__ = true;
  const origins = {
    wechat: "https://mp.weixin.qq.com",
    xiaohongshu: "https://creator.xiaohongshu.com",
    x: "https://x.com",
    channels: "https://channels.weixin.qq.com",
    douyin: "https://creator.douyin.com",
  };
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
    if (/^(发布|发表|Publish|Post)$/i.test(norm(el.textContent)))
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
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, value);
    } catch {}
    if (!inserted || compact(el.textContent) !== compact(value)) {
      el.textContent = value;
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertText",
          data: value,
        }),
      );
    }
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
    const previous = plainText(el);
    if (!append && norm(previous))
      attention("编辑器已有内容，已停住以保留平台中的修改。请新建草稿后重试。");
    el.focus();
    {
      const range = document.createRange();
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
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      if (typeof MouseEvent !== "undefined")
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await sleep(100);
    }
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    const tmp = document.createElement("div");
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
        document.execCommand("insertHTML", false, html);
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
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
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
    visit(start);
    return out;
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
    await chrome.runtime.sendMessage({
      type: "CONTENT_STATUS",
      id: task.id,
      platform: task.platform,
      patch: { state, message },
    });
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
    await sleep(500);
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
      )
        await richPaste(editor, sections[i], i > 0);
      expected += tmp.textContent;
      if (i < task.prepared.media.length) {
        prefixes.push(compact(expected));
        if (platform !== "xiaohongshu")
          await insertImage(task, editor, platform, i);
      }
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
    return result(task, "X 显示 Last saved，且已返回独立文章草稿地址");
  }
  async function wechatArticle(task) {
    auth();
    await status(task, "filling", "读取当前公众号并准备图文草稿");
    const home = await fetch("/", { credentials: "include" });
    const source = await home.text();
    const find = (pattern) => pattern.exec(source)?.[1] || "";
    const token = find(/data:\s*\{[\s\S]*?t:\s*["']([^"']+)["']/);
    const user = find(/user_name:\s*["']([^"']+)["']/),
      ticket = find(/ticket:\s*["']([^"']+)["']/),
      time = find(/time:\s*["'](\d+)["']/);
    if (!token || !user || !ticket)
      attention("未读取到公众号登录状态，请重新登录后台");
    const doc = new DOMParser().parseFromString(
      "<html><body>" + task.prepared.wechat + "</body></html>",
      "text/html",
    );
    let cover = "";
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
      cover ||= data.cdn_url;
    }
    doc.querySelectorAll("a").forEach((a) => {
      if (!/^https:\/\/([\w-]+\.)?weixin\.qq\.com\//.test(a.href))
        a.replaceWith(...a.childNodes);
    });
    const form = new URLSearchParams({
      token,
      lang: "zh_CN",
      f: "json",
      ajax: "1",
      random: String(Math.random()),
      AppMsgId: "",
      count: "1",
      data_seq: "0",
      operate_from: "Chrome",
      isnew: "0",
      title0: task.title,
      author0: "",
      fileid0: "",
      digest0: task.description || "",
      auto_gen_digest0: task.description ? "0" : "1",
      content0: doc.body.innerHTML,
      sourceurl0: "",
      need_open_comment0: "1",
      only_fans_can_comment0: "0",
      cdn_url0: cover,
      cdn_235_1_url0: cover,
      cdn_1_1_url0: cover,
      cdn_url_back0: cover,
      show_cover_pic0: cover ? "1" : "0",
      copyright_type0: "0",
      comment_id0: "",
      music_id0: "",
      video_id0: "",
      voteid0: "",
      crop_list0: "",
      categories_list0: "[]",
      dot0: "{}",
    });
    await status(task, "saving", "保存公众号图文草稿");
    let data;
    try {
      const response = await fetch(
        "/cgi-bin/operate_appmsg?" +
          new URLSearchParams({
            t: "ajax-response",
            sub: "create",
            type: "77",
            token,
            lang: "zh_CN",
          }),
        { method: "POST", credentials: "include", body: form },
      );
      data = await response.json();
    } catch {
      attention("公众号保存响应中断，请先检查草稿箱，避免重复创建");
    }
    if (!data.appMsgId)
      attention(
        "公众号未返回草稿 ID：" +
          (data.base_resp?.err_msg || data.ret || "请在后台检查"),
      );
    const url =
      "https://mp.weixin.qq.com/cgi-bin/appmsg?" +
      new URLSearchParams({
        t: "media/appmsg_edit",
        action: "edit",
        type: "77",
        appmsgid: String(data.appMsgId),
        token,
        lang: "zh_CN",
      });
    return {
      ...result(task, "公众号返回独立图文草稿 ID " + data.appMsgId, url),
      postId: String(data.appMsgId),
      editorUrl: url,
    };
  }
  async function video(task) {
    auth();
    if (task.fillOnly) {
      const uploaded = queryAll("video").some(
        (el) => el.currentSrc || el.src || el.querySelector("source[src]"),
      );
      const fields =
        task.platform === "channels"
          ? queryAll(
              '.post-desc-box [contenteditable="true"], .input-editor[contenteditable="true"], textarea[placeholder*="描述"], .short-title-wrap input, input[placeholder*="短标题"], input[placeholder*="概括视频"]',
            )
          : queryAll(
              "input:not([type]),input[type=text],textarea,[contenteditable=true]",
            );
      const existing = fields.some(
        (el) => visible(el) && norm(el.value || el.textContent),
      );
      if (existing || uploaded)
        attention("页面已有内容，请先核对或打开空白发布页，避免覆盖或重复上传");
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
      input = document.querySelector("input[type=file]");
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
      await sleep(1000);
      if (
        title.value !== task.title ||
        compact(plainText(desc)) !== compact(task.description || "")
      )
        attention("平台仍在初始化视频文案，请检查保留的页面");
      if (task.fillOnly)
        attention("视频与文案已填入；请检查封面和 AI 声明后自行保存或发布");
      const cover = task.assets.find((a) => a.role.startsWith("cover"));
      if (cover)
        attention("视频已上传并填入文案，请在平台设置封面后点“暂存离开”");
      const saved = await saveXhs(task);
      if (task.aiGenerated) saved.warnings = ["发布前请在平台确认 AI 内容声明"];
      return saved;
    }
    if (task.platform === "channels") {
      const hintOf = (el) =>
        [
          el.getAttribute?.("placeholder"),
          el.getAttribute?.("data-placeholder"),
          el.getAttribute?.("aria-placeholder"),
          el.getAttribute?.("aria-label"),
          el.className,
          el.parentElement?.className,
        ].join(" ");
      const editable = () =>
        queryAll(
          '[contenteditable], textarea, input, [data-placeholder], [class*="editor"], [class*="desc"]',
        );
      const desc = await wait(
        () =>
          editable().find((el) => {
            const hint = hintOf(el);
            return (
              /描述|添加描述|input-editor|post-desc/.test(hint) &&
              !/短标题|位置|地点|链接|合集/.test(hint)
            );
          }),
        "等待视频号编辑表单超时",
        300000,
      );
      textField(desc, task.description || task.title);
      const title = editable().find((el) =>
        /短标题|概括视频/.test(hintOf(el)),
      );
      if (title) textField(title, task.title);
      if (task.fillOnly)
        attention(
          "视频与文案已填入；请检查上传进度、短标题、横竖封面和 AI 声明后自行保存或发布",
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
        () =>
          field(
            'input[placeholder*="作品标题"],input[placeholder*="填写标题"],textarea[placeholder*="作品标题"]',
          ) || field("[contenteditable=true]"),
        "等待抖音编辑表单超时",
        300000,
      );
      const desc = field(
        'textarea[placeholder*="简介"],textarea[placeholder*="描述"],textarea[placeholder*="添加作品"],[data-placeholder*="简介"],[data-placeholder*="描述"]',
      );
      if (desc && desc !== title) {
        textField(title, task.title);
        textField(desc, task.description || "");
      } else if (title.matches("input,textarea")) textField(title, task.title);
      else
        textField(
          title,
          [task.title, task.description].filter(Boolean).join("\n"),
        );
      attention("视频与文案已填入抖音；请检查封面和话题后自行发布");
    }
    const editor = await wait(
      () => field('[data-testid="tweetTextarea_0"][contenteditable=true]'),
      "未找到 X 视频文案框",
      300000,
    );
    if (norm(editor.textContent))
      attention("X 编辑框已有内容，请在原页面继续编辑");
    const description = document.createElement("p");
    description.textContent = task.description || task.title;
    await richPaste(editor, description.outerHTML);
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
      attention("视频与文案已填入；请检查封面后自行保存或发布");
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
    return result(
      task,
      "X 草稿箱出现匹配文案与视频缩略图",
      "https://x.com/compose/post/unsent/drafts",
    );
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
    if (message?.type !== "RUN_DRAFT") return false;
    const task = message.task;
    if (origins[task.platform] !== location.origin) {
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
