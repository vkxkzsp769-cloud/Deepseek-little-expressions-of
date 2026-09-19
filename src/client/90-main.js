/* ============================================================================
 * 90-main.js — 插件主体：引导（读配置 -> 空闲后落位）、样式注入、
 * 槽位注册（shell.overlay 座位 + sidebar.footer.action 设置入口）。
 * ========================================================================== */

var reactDom = require("react-dom");

/* ============================== Portal ============================== */

/**
 * 把面板渲染到 body 上的独立容器里：布局槽位都处在会被裁剪 / 滚动的容器
 * 内，浮层挂到 body 才不会被裁剪。这里不 require("react-dom/client")，
 * 因为模块表只保证 react-dom 可用，createPortal 一样能渲染到别处。
 */
function Portal(props) {
  var box = react.useMemo(function () {
    var el = document.createElement("div");
    el.className = "dfb-portal";
    document.body.appendChild(el);
    return el;
  }, []);

  react.useEffect(function () {
    return function () {
      if (box.parentNode) box.parentNode.removeChild(box);
    };
  }, [box]);

  return reactDom.createPortal(props.children, box);
}

/* ============================== 挂载层 ============================== */

function FloatBallLayer() {
  /* 必须订阅 store：面板内容由 panelState 驱动，这一层不订阅就永远不会
   * 因为“面板被打开”而重渲染，Portal 也就拿不到内容。 */
  useUi();
  return jsxs(Fragment, {
    children: [
      jsx(FloatBall, {}),
      jsx(Portal, {
        children: panelState.content ? jsx(PanelContent, { onClose: panelState.close }) : null
      })
    ]
  });
}

/* ============================== 引导 ============================== */

var booted = false;

/** 三处配置合并：内置默认 -> 本地缓存 -> 宿主文件（后者优先）。 */
function resolveConfig() {
  var local = mergeCfg(readLocal(STORE_CFG));
  var remote = hostCall("float-ball/config", {}, 4000);
  var timeout = new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, 4500);
  });
  return Promise.race([remote, timeout]).then(function (value) {
    if (value && value.config) return mergeCfg(value.config);
    return local;
  });
}

/** 等浏览器空闲再落位，避免与 GUI 首帧抢时间。 */
function nextIdle() {
  return new Promise(function (resolve) {
    var fired = false;
    function go() {
      if (fired) return;
      fired = true;
      resolve();
    }
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(go, { timeout: 1200 });
    } else {
      setTimeout(go, 260);
    }
    setTimeout(go, 1600);
  });
}

function bootstrap() {
  if (booted) return Promise.resolve();
  booted = true;
  return resolveConfig()
    .then(function (cfg) {
      applyCfg(cfg);
      return nextIdle();
    })
    .then(function () {
      if (typeof document === "undefined" || !document.body) return;
      if (document.getElementById("dsh-float-ball-root")) return;
      var container = document.createElement("div");
      container.id = "dsh-float-ball-root";
      document.body.appendChild(container);
      reactDom.render(jsx(FloatBallLayer, {}), container);
    })
    .catch(function (err) {
      booted = false;
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[dsh-float-ball] 启动失败：", err);
      }
    });
}

/* ============================== 样式注入 ============================== */

var STYLE_ID = "dsh-float-ball-style";

function injectStyle() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  var el = document.createElement("style");
  el.id = STYLE_ID;
  el.setAttribute("data-plugin", NS);
  el.textContent = CSS;
  document.head.appendChild(el);
}

function cleanup() {
  if (typeof document === "undefined") return;
  var el = document.getElementById(STYLE_ID);
  if (el) el.remove();
  var root = document.getElementById("dsh-float-ball-root");
  if (root && root.parentNode) root.parentNode.removeChild(root);
  var portal = document.querySelector(".dfb-portal");
  if (portal && portal.parentNode) portal.parentNode.removeChild(portal);
  panelState.content = null;
  booted = false;
}

/* ============================== 插件入口 ============================== */

function apply(ctx) {
  injectStyle();

  var kick = window.setTimeout(function () { bootstrap(); }, 80);
  ctx.effect(function () {
    return function () { window.clearTimeout(kick); };
  }, "dsh-float-ball: boot timer");

  /* 会话观察：
   *   running 变 true  -> 表情球进「思考中」
   *   running 变 false -> 一轮对话结束，若开了「AI 心情」就把最近一对消息
   *                       交给宿主调用模型选表情（见 25-brain.js）
   * 会话服务缺失时静默降级。 */
  ctx.effect(function () {
    var sessions = ctx.get ? ctx.get("sessions") : ctx.sessions;
    bindServices({ ctx: ctx, sessions: sessions });
    var observer = createAgentObserver({ sessions: sessions, ctx: ctx });
    /* 把观察器状态挂在导出对象上：构建机上的 jsdom 冒烟测试会读它来
     * 验证节流行为（线上没有任何副作用）。 */
    module.exports.__observer = observer.state;
  /* 构建机冒烟测试入口：按指定表情说一句（等价于心情刚切到该表情）。
   * speakNow 是组件内部函数，必须走 FloatBallActions 这个动作槽。 */
  module.exports.__dshFloatBallInternalSay = function (moodId) {
    if (FloatBallActions && typeof FloatBallActions.sayFor === "function") FloatBallActions.sayFor(moodId);
  };
    var stop = observer.start();
    return function () { stop(); };
  }, "dsh-float-ball: agent observer + brain");

  /* 悬浮球本体的座位：条目渲染 null，真正的球由 bootstrap 挂到 body 上，
   * 这样它拥有自己的 fixed 容器，不受叠加层布局与滚动影响。 */
  ctx.effect(function () {
    return ctx.slots.inject("shell.overlay", function () {
      return ctx.slots.register(
        { name: "shell.overlay", id: "dsh-float-ball", order: 60, label: "表情球" },
        function () { return null; }
      );
    });
  }, "dsh-float-ball: overlay seat");

  /* 侧边栏入口：打开与右键球同一块设置面板，不必先找到球在哪 */
  ctx.effect(function () {
    return ctx.slots.inject("sidebar.footer.action", function () {
      return ctx.slots.register(
        { name: "sidebar.footer.action", id: "dsh-float-ball-entry", order: 60 },
        FloatBallEntry
      );
    });
  }, "dsh-float-ball: sidebar entry");

  ctx.effect(function () {
    return function () { cleanup(); };
  }, "dsh-float-ball: cleanup");
}

/* 客户端 apply 用到的 cordis 服务：
 *   ctx.slots     由 dsh-client-runtime 提供（槽位注册）
 *   ctx.connection 由 dsh-client-connection 提供（宿主 RPC 通道）
 *   ctx.sessions  由 dsh-api-session-controller 提供（会话 running 位，驱动“思考中”）
 * 未声明的服务一旦访问就会抛 “cannot get property ... without inject”，
 * 因此必须在这里声明。注意：声明即在服务缺失时阻止插件加载，所以只列必要项。 */
var inject = ["slots", "connection", "sessions"];

module.exports = {
  name: "dsh-client-ui-float-ball",
  NS: NS,
  apply: apply,
  inject: inject,
  version: "0.1.0"
};
