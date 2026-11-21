import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import * as model from "../extension/shared/model.js";
import * as target from "../extension/shared/target.js";
import * as replacement from "../extension/shared/video-replacement.js";
import {
  NATIVE_SCHEDULE_CAPABILITY,
  PLATFORM_SCHEDULE_CAPABILITIES,
} from "../extension/shared/platforms/index.js";

const token = "ab".repeat(32);

test("保存过令牌后会自动连接，空令牌也能再次连接", async (t) => {
  const storage = {
    bridgeConfig: { url: "http://127.0.0.1:4318", token },
  };
  const sockets = [];
  const sent = [];
  const intervals = [];
  class FakeWS {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWS.CONNECTING;
      this.handlers = {};
      sockets.push(this);
      setTimeout(() => this.emit("open", {}), 0);
    }
    addEventListener(type, fn, options) {
      const list = (this.handlers[type] ||= []);
      const wrapped = (event) => {
        if (options?.once)
          this.handlers[type] = (this.handlers[type] || []).filter(
            (item) => item !== wrapped,
          );
        fn(event);
      };
      list.push(wrapped);
    }
    emit(type, event) {
      const prop = this["on" + type];
      if (typeof prop === "function") prop(event);
      for (const listener of [...(this.handlers[type] || [])]) listener(event);
    }
    send(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      if (message.type !== "hello") return;
      this.readyState = FakeWS.OPEN;
      this.emit("message", {
        data: JSON.stringify({ type: "hello", ok: true }),
      });
    }
    close() {
      if (this.readyState === FakeWS.CLOSED) return;
      this.readyState = FakeWS.CLOSED;
      this.emit("close", {});
    }
  }
  let listener;
  const source = (
    await fs.readFile(
      new URL("../extension/background.js", import.meta.url),
      "utf8",
    )
  ).replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
  vm.runInNewContext(source, {
    ...model,
    ...target,
    ...replacement,
    NATIVE_SCHEDULE_CAPABILITY,
    PLATFORM_SCHEDULE_CAPABILITIES,
    chrome: {
      runtime: {
        id: "ext",
        getURL: (path) => "chrome-extension://ext/" + path,
        onMessage: { addListener: (fn) => (listener = fn) },
      },
      storage: {
        local: {
          get: async (key) =>
            typeof key === "string" ? { [key]: storage[key] } : { ...storage },
          set: async (value) => Object.assign(storage, value),
        },
      },
      alarms: { onAlarm: { addListener() {} }, create() {} },
      tabs: {
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
      },
      action: { onClicked: { addListener() {} } },
    },
    console,
    URL,
    Map,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      intervals.push(id);
      return id;
    },
    clearInterval: (id) => {
      clearInterval(id);
    },
    WebSocket: FakeWS,
    get: async () => null,
    put: async () => {},
    all: async () => [],
    remove: async () => {},
    fileChunk: async () => "",
  });
  t.after(() => {
    for (const id of intervals) clearInterval(id);
  });
  const send = (message) =>
    new Promise((resolve) =>
      listener(
        message,
        { id: "ext", url: "chrome-extension://ext/workbench.html" },
        resolve,
      ),
    );
  for (let i = 0; i < 50 && sent.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent[0]?.type, "hello");
  assert.equal(sent[0].token, token);
  assert.ok(sent[0].capabilities.includes(NATIVE_SCHEDULE_CAPABILITY));
  assert.ok(
    PLATFORM_SCHEDULE_CAPABILITIES.every((value) =>
      sent[0].capabilities.includes(value),
    ),
  );
  const state = await send({ type: "STATE" });
  assert.equal(state.ok, true);
  assert.equal(state.bridge.connected, true);
  assert.equal(state.bridge.paired, true);
  const again = await send({
    type: "CONNECT",
    url: "http://127.0.0.1:4318",
    token: "",
  });
  assert.equal(again.ok, true);
  assert.equal(sent.length, 1);
});
