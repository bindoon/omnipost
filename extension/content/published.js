(() => {
  if (globalThis.__OMNIPOST_WORKS__) return;
  globalThis.__OMNIPOST_WORKS__ = true;
  const norm = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  const blocked = new Set([
    "首页",
    "数据",
    "数据中心",
    "内容管理",
    "上传",
    "发布",
    "退出",
    "登录",
    "home",
    "upload",
  ]);
  function queryAll(selector, root = document) {
    const out = [];
    const seen = new Set();
    const visit = (node) => {
      if (!node?.querySelectorAll || seen.has(node)) return;
      seen.add(node);
      try {
        out.push(...node.querySelectorAll(selector));
        for (const el of node.querySelectorAll("*")) {
          if (el.shadowRoot) visit(el.shadowRoot);
          try {
            const closed = chrome.dom?.openOrClosedShadowRoot?.(el);
            if (closed) visit(closed);
          } catch {}
        }
      } catch {}
    };
    visit(root);
    return out;
  }
  function goodTitle(title) {
    if (!title || title.length < 2 || title.length > 80) return false;
    if (blocked.has(title.toLowerCase())) return false;
    return /[\u4e00-\u9fffA-Za-z0-9]/.test(title);
  }
  function likesText(row) {
    const text = norm(row?.innerText || row?.textContent || "");
    const match =
      text.match(
        /(?:点赞|喜欢|获赞|赞|likes?)\s*[:：]?\s*([\d,.]+\s*[万亿kKmM]?)/i,
      ) || text.match(/([\d,.]+\s*[万亿])\s*(?:赞|喜欢|like)/i);
    return match ? match[1] : "";
  }
  const WORK_ROW_SELECTOR =
    'tr, li, article, [role="listitem"], ytcp-video-row, .video-item, .note-item, .content-item, .post-item';
  const ACTION_SELECTOR = 'button, [role="button"], a';
  function pendingStatus(row, titleNode) {
    if (!row) return "";
    const texts = queryAll("span, div, p, time, [class*='status']", row)
      .filter(
        (node) =>
          !node.contains(titleNode) &&
          !titleNode.contains(node) &&
          !node.closest(`${ACTION_SELECTOR}, [hidden], [aria-hidden="true"]`) &&
          !node.querySelector(ACTION_SELECTOR),
      )
      .map((node) => norm(node.innerText || node.textContent));
    if (texts.some((text) => /^定时发布(?:$|\s*[:：]?\s*\d)/.test(text)))
      return "定时发布";
    return (
      texts.find((text) =>
        /^(审核中|转码中|发布中|发布失败|草稿|待发布)$/.test(text),
      ) || ""
    );
  }
  function fromNodes(nodes) {
    const items = [];
    const seen = [];
    for (const node of nodes) {
      const title = norm(node.textContent || node.getAttribute?.("alt"));
      if (!goodTitle(title)) continue;
      if (node.closest?.("nav, header, footer")) continue;
      const row = node.closest(WORK_ROW_SELECTOR);
      const sameItem = seen.some(
        (item) =>
          item.title === title &&
          ((row && item.row === row) ||
            item.node.contains(node) ||
            node.contains(item.node)),
      );
      if (sameItem) continue;
      seen.push({ title, row, node });
      const link = node.closest?.("a") || node.querySelector?.("a");
      items.push({
        title,
        likesText: likesText(
          row || node.closest("section") || node.parentElement,
        ),
        href: link?.href || node.href || "",
        pendingStatus: pendingStatus(row, node),
      });
      if (items.length >= 80) break;
    }
    return items;
  }
  function specificNodes() {
    const host = location.hostname;
    if (host.endsWith("youtube.com"))
      return queryAll("#video-title, a#video-title");
    if (host.endsWith("bilibili.com"))
      return queryAll(".video-title, a.title, .title-content");
    if (host.endsWith("xiaohongshu.com"))
      return queryAll("[class*='title'], [class*='note-title']");
    if (host.endsWith("douyin.com"))
      return queryAll("[class*='title'], [class*='content-title']");
    if (host.endsWith("weixin.qq.com"))
      return queryAll(
        ".post-title, .weui-desktop-mass-appmsg__title, .appmsg_title, [class*='title']",
      );
    if (host.endsWith("x.com")) return queryAll("[data-testid='tweetText']");
    if (host.endsWith("instagram.com")) return queryAll("img[alt]");
    return [];
  }
  function nextUrl(items) {
    if (items.length) return "";
    const host = location.hostname;
    if (host === "x.com") {
      const profile = document.querySelector(
        "a[data-testid='AppTabBar_Profile_Link']",
      );
      if (profile?.href && !location.pathname.startsWith("/home")) return "";
      return profile?.href || "";
    }
    if (host.endsWith("youtube.com")) {
      const link = queryAll("a[href*='/videos']").find((anchor) => {
        try {
          return /\/videos\/?$/.test(new URL(anchor.href).pathname);
        } catch {
          return false;
        }
      });
      return link?.href || "";
    }
    return "";
  }
  function readWorks() {
    const body = norm(document.body?.innerText || "");
    let nodes = specificNodes().filter((node) =>
      goodTitle(norm(node.textContent || node.alt)),
    );
    if (!nodes.length)
      nodes = queryAll("a, h1, h2, h3, [class*='title']").filter((node) =>
        goodTitle(norm(node.textContent)),
      );
    const items = fromNodes(nodes);
    const loggedOut =
      !items.length &&
      /登录|登入|sign in|log in/i.test(body.slice(0, 500)) &&
      !/已登录/.test(body.slice(0, 200));
    return {
      items,
      loggedOut,
      nextUrl: nextUrl(items),
      note: items.length ? "" : "这个页面没有列出标题",
    };
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== "READ_WORKS") return;
    if (sender.id !== chrome.runtime.id) return;
    try {
      reply({ ok: true, ...readWorks() });
    } catch (error) {
      reply({ ok: false, error: error.message });
    }
  });
})();
