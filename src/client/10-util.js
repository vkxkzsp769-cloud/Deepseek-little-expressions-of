/* ============================================================================
 * 10-util.js — 工具层：共享小 store、位置/配置存储（localStorage + 宿主文件
 * 双写）、宿主 RPC 客户端、主题与小工具。
 *
 * 本文件与其他 src/client/*.js 会被 build-client.mjs 依次拼接进同一个
 * 客户端 bundle 工厂函数体，因此：
 *   - 只能使用 `require()`，不能使用 import/export；
 *   - module / exports / react / jsx / jsxs / Fragment 由构建脚本注入。
 * ========================================================================== */

var NS = "dshFloatBall";
var BALL_PKG = "@dsh-local/dsh-client-ui-float-ball";
var ENGINE_PKG = BALL_PKG + "/engine/grok-ball";
var RPC_CHANNEL = "/float-ball-rpc";

var STORE_POS = "dsh.floatball.pos.v1";
var STORE_CFG = "dsh.floatball.cfg.v1";

/* 球的默认尺寸与可调范围（px，正方形挂载盒） */
var SIZE_MIN = 48;
var SIZE_MAX = 160;
var SIZE_DEFAULT = 84;

/* 拖动判定阈值：位移小于该像素数视为“点击”，否则视为“拖动” */
var DRAG_THRESHOLD = 4;

/* 长按判定时长（ms）：触屏上没有右键，长按用于打开设置面板 */
var HOLD_MS = 480;

/* 内联 SVG 图标，避免任何外部资源请求 */
var ICON_BALL =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9.2" fill="currentColor" opacity=".18"/>' +
  '<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
  '<circle cx="8.7" cy="11" r="2.5" fill="currentColor"/>' +
  '<circle cx="15.3" cy="11" r="2.5" fill="currentColor"/>' +
  '<circle cx="9.6" cy="10.2" r=".85" fill="#fff"/>' +
  '<circle cx="16.2" cy="10.2" r=".85" fill="#fff"/></svg>';

/* 表情分组中文名（引擎自带 GROUPS 里也有 name，这里作为兜底与顺序来源） */
var GROUP_LABELS = [
  { key: "life", name: "生命周期" },
  { key: "emotion", name: "情绪反应" },
  { key: "agent", name: "代理状态" }
];

var DEFAULT_CFG = {
  emotion: "02",
  size: SIZE_DEFAULT,
  theme: "ink",
  gaze: true,
  idle: true,
  /* auto：跑任务时自动进入“思考中”，跑完自动回到自己选的表情 */
  auto: true,
  /* brain：是否让模型判断“用户心情”，据此换表情。
   * 默认开启——这是“表情球有意识”的那部分；不想花 token 就在面板里关掉。 */
  brain: true,
  /* anim：跑任务时除了「思考中」还要有小动作（换表情 / 自旋 / 弹跳） */
  anim: true,
  /* bubble：聊天气泡（让它把情绪说出来） */
  bubble: true,
  /* sayLocal：只用本地台词库，不调用模型 */
  sayLocal: false,
  /* brainOn：触发时机
   *   'task'    默认：整轮任务结束才判断一次（最省，30 分钟任务 ≈ 1 次调用）
   *   'message' 每条助手消息结束时判断一次（更灵敏，按 25 秒节流）
   */
  brainOn: "task",
  /* 大脑用哪个模型；留空 = 用 dsh 的默认 Agent 模型 */
  brainProvider: "",
  brainModel: "",
  seenHint: false
};

/* 代理工作状态 -> 表情（引擎的 emotionId 契约：30-49 为代理状态段） */
var AUTO_RUNNING_EMOTION = "30";
var AUTO_IDLE_EMOTION = "02";

/* store 字段：live 以引擎为真值、mood 记录自动表情、running 为会话运行状态 */
var DEFAULT_UI = {
  live: null,
  mood: null,
  running: false,
  ready: false,
  open: false,
  /* brain：{ busy, id, reason, error } —— AI 心情的最近一次结果 */
  brain: { busy: false, id: null, reason: "", error: null },
  /* model：当前会话正在使用的模型 { provider, model }（大脑跟随它） */
  model: null,
  /* task：跑任务时小动作用的临时表情（与 mood 分开，免得和大脑的心情打架） */
  taskMood: null,
  /* say：气泡当前要说的话 { text, at, source, mood }
   * pending：排队等展示的话（最多 2 条）——**新话不会打断正在显示的那条**，
   *          等当前这条读完了再上，避免「来不及看完就被顶掉」。
   * sayBusy：正在等模型返回 */
  say: null,
  pending: [],
  sayBusy: false,
  /* sessions：会话服务句柄（供 25-brain.js 复用，避免每处都注入一遍） */
  sessions: null,
  cfg: DEFAULT_CFG
};

/* ============================== 基础工具 ============================== */

function clampNum(v, lo, hi) {
  if (typeof v !== "number" || !isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function viewport() {
  if (typeof window === "undefined") return { w: 1280, h: 800 };
  return { w: window.innerWidth || 1280, h: window.innerHeight || 800 };
}

/** size 合法化：只接受 SIZE_MIN..SIZE_MAX，其余回退默认值。 */
function normSize(v) {
  if (typeof v !== "number" || !isFinite(v)) return SIZE_DEFAULT;
  return Math.round(clampNum(v, SIZE_MIN, SIZE_MAX));
}

/** 主题 -> 引擎颜色参数。 */
function themeColors(theme) {
  if (theme === "cream") return { color: "#F3F0EA", eyeColor: "#1A1A1A" };
  return { color: "#1A1A1A", eyeColor: "#F5F5F5" };
}

/** 焦点在输入控件里时不响应全局快捷键。 */
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  var tag = String(el.tagName).toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

/* ============================== 共享 store ============================== */

/** 极简可订阅 store，配 React 的 useSyncExternalStore 使用。 */
function createStore(initial) {
  var box = { state: initial };
  var listeners = new Set();
  return {
    /**
     * 读当前快照。刻意每次从 box 里取：早期版本把 state 捕获进闭包，
     * 结果任何在模块求值期“顺手存下来”的 get 都会永远读到初值
     * （曾导致面板改了触发时机、观察器却一直读到旧配置）。
     */
    get: function () { return box.state; },
    subscribe: function (fn) {
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    },
    set: function (patch) {
      /* 状态放在盒子里：捕获出去的 get 也必须读到最新值 */
      box.state = Object.assign({}, box.state, patch);
      listeners.forEach(function (fn) { fn(); });
    }
  };
}

/** UI 状态：live 是引擎回报的当前表情，cfg 是生效中的配置。 */
var uiStore = createStore(DEFAULT_UI);

function useUi() {
  return react.useSyncExternalStore(uiStore.subscribe, uiStore.get, uiStore.get);
}

/* ============================== 存储层 ============================== */

function readLocal(key) {
  try {
    var raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { /* 隐私模式 / 配额异常：忽略 */ }
  return null;
}

function writeLocal(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

/** 位置存储：以比例保存，窗口尺寸变化后仍落在同一相对位置。 */
function loadPosPref() {
  var raw = readLocal(STORE_POS);
  if (!raw || typeof raw !== "object") return { x: null, y: null, size: null };
  var x = typeof raw.x === "number" && raw.x >= 0 && raw.x <= 1 ? raw.x : null;
  var y = typeof raw.y === "number" && raw.y >= 0 && raw.y <= 1 ? raw.y : null;
  var size = typeof raw.size === "number" ? normSize(raw.size) : null;
  if (x === null || y === null) return { x: null, y: null, size: size };
  return { x: x, y: y, size: size };
}

function savePosPref(xRatio, yRatio, size) {
  writeLocal(STORE_POS, { x: xRatio, y: yRatio, size: size });
}

/** 配置合并：任何来源（本地缓存 / 宿主文件）都先过这里，坏值一律回退默认。 */
function mergeCfg(raw) {
  var src = raw && typeof raw === "object" ? raw : {};
  return {
    emotion: typeof src.emotion === "string" && /^\d{2}$/.test(src.emotion) ? src.emotion : DEFAULT_CFG.emotion,
    size: normSize(typeof src.size === "number" ? src.size : DEFAULT_CFG.size),
    theme: src.theme === "cream" ? "cream" : "ink",
    gaze: src.gaze === false ? false : true,
    idle: src.idle === false ? false : true,
    auto: src.auto === false ? false : true,
    brain: src.brain !== false,
    anim: src.anim !== false,
    bubble: src.bubble !== false,
    sayLocal: src.sayLocal === true,
    brainOn: src.brainOn === "message" ? "message" : "task",
    brainProvider: typeof src.brainProvider === "string" ? src.brainProvider : "",
    brainModel: typeof src.brainModel === "string" ? src.brainModel : "",
    seenHint: src.seenHint === true
  };
}

function applyCfg(cfg) {
  uiStore.set({ cfg: cfg });
}

function currentCfg() {
  return uiStore.get().cfg;
}

/* ========================= 代理工作状态 -> 表情 ========================= */

/**
 * dsh 的会话列表是客户端共享状态：每个会话行都带 running 位，
 * 列表本身是可订阅快照（getSnapshot/subscribe）。悬浮球不绑定任何单个
 * 会话，所以取“当前选中的会话”，没有选中时退化为“有没有任何会话在跑”。
 */
function pickRunning(state) {
  if (!state || typeof state !== "object") return false;
  var byId = state.byId || {};
  var current = state.current;
  if (current && byId[current]) return byId[current].running === true;
  var ids = state.ids || [];
  for (var i = 0; i < ids.length; i++) {
    var row = byId[ids[i]];
    if (row && row.running === true) return true;
  }
  return false;
}

/** 把会话运行状态写进 store（观察与触发逻辑在 25-brain.js 的 createAgentObserver）。 */
function setRunning(running) {
  uiStore.set({ running: running === true });
}

/* ============================== 宿主 RPC ============================== */

/**
 * 调用宿主半的 /float-ball-rpc 通道。带超时，任何异常都返回 null，
 * 由调用方决定回退策略（本插件在宿主不可用时完全依赖 localStorage）。
 */
function hostCall(endpoint, payload, timeoutMs) {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return Promise.resolve(null);
  }
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  var timer = setTimeout(function () {
    if (controller) controller.abort();
  }, timeoutMs || 4000);
  return window
    .fetch(RPC_CHANNEL + "/" + endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      signal: controller ? controller.signal : undefined,
      body: JSON.stringify({
        rpcId: "fb-" + Math.random().toString(36).slice(2) + Date.now().toString(36),
        type: "client-request",
        method: endpoint,
        payload: payload || {}
      })
    })
    .then(function (res) {
      if (!res.ok) return null;
      return res.json();
    })
    .then(function (body) {
      if (!body || body.type !== "server-response") return null;
      var result = body.result;
      if (!result || result.ok !== true) return null;
      /* HostConnectionService 的返回形状：{ ok: true, value } */
      return result.value || {};
    })
    .catch(function () { return null; })
    .then(function (value) {
      clearTimeout(timer);
      return value;
    });
}

/* ============================== 模块出入口 ============================== */

/**
 * 构建脚本会把同一工厂内的兄弟模块句柄注入进来，避免在源码里散落
 * require() 路径字符串，也让依赖关系一眼可见。
 */
function initUtil(refs) {
  Util.Engine = refs.Engine;
  Util.FloatBall = refs.FloatBall;
  Util.Panel = refs.Panel;
}

/** 记下插件上下文与会话服务，供 25-brain.js 解析当前模型。 */
function bindServices(services) {
  Util.appCtx = services && services.ctx ? services.ctx : null;
  Util.sessions = services && services.sessions ? services.sessions : null;
  uiStore.set({ sessions: Util.sessions || null });
}

var Util = {
  NS: NS,
  BALL_PKG: BALL_PKG,
  ENGINE_PKG: ENGINE_PKG,
  RPC_CHANNEL: RPC_CHANNEL,
  SIZE_MIN: SIZE_MIN,
  SIZE_MAX: SIZE_MAX,
  SIZE_DEFAULT: SIZE_DEFAULT,
  DRAG_THRESHOLD: DRAG_THRESHOLD,
  HOLD_MS: HOLD_MS,
  ICON_BALL: ICON_BALL,
  GROUP_LABELS: GROUP_LABELS,
  DEFAULT_CFG: DEFAULT_CFG,
  STORE_POS: STORE_POS,
  STORE_CFG: STORE_CFG,
  /* 由 initUtil 注入 */
  Engine: null,
  FloatBall: null,
  Panel: null,
  initUtil: initUtil,
  bindServices: bindServices,
  appCtx: null,
  sessions: null,
  /* 工具函数 */
  clampNum: clampNum,
  viewport: viewport,
  normSize: normSize,
  themeColors: themeColors,
  isTypingTarget: isTypingTarget,
  createStore: createStore,
  uiStore: uiStore,
  useUi: useUi,
  readLocal: readLocal,
  writeLocal: writeLocal,
  loadPosPref: loadPosPref,
  savePosPref: savePosPref,
  mergeCfg: mergeCfg,
  applyCfg: applyCfg,
  currentCfg: currentCfg,
  hostCall: hostCall,
  pickRunning: pickRunning,
  setRunning: setRunning,
  AUTO_RUNNING_EMOTION: AUTO_RUNNING_EMOTION,
  AUTO_IDLE_EMOTION: AUTO_IDLE_EMOTION
};
