/* ============================================================================
 * 20-ball.js — 悬浮球：挂载 Grok Ball 引擎、鼠标注视跟随、拖动定位、
 * 拖动/点击手势判定、位置与配置持久化、键盘表情快捷键。
 *
 * 引擎本体（src/vendor/grok-ball.engine.js）以独立模块注册进客户端模块表，
 * 通过 Util.Engine 拿到句柄；它自带 32 种表情与渲染循环。
 * ========================================================================== */

/* 引擎由构建脚本通过 initUtil 注入到 Util 上（本文件在 factory 顶部求值时
 * Util.Engine 还没有接线），因此始终通过这个取值器惰性读取。 */
function ballEngine() { return Util.Engine; }

/** 归一化表情列表：{ id, group, name, color }[] */
/** 高精度时间戳，带 performance 兜底。 */
function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function emotionList(engine) {
  var raw = (engine && engine.EMOTIONS) || [];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var item = raw[i];
    if (!item || typeof item.id !== "string") continue;
    out.push({
      id: item.id,
      group: item.group || "custom",
      name: item.name || item.id,
      color: item.color || "#F3F0EA"
    });
  }
  return out;
}

function findEmotion(list, id) {
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

/** 按分组返回 { key, name, items }[]，顺序取自引擎自带的 GROUPS。 */
function groupEmotions(engine, list) {
  var groups = (engine && engine.GROUPS) || [];
  var out = [];
  var seen = {};
  for (var i = 0; i < groups.length; i++) {
    var key = groups[i] && groups[i].key;
    if (!key || key === "custom" || seen[key]) continue;
    var label = groups[i].name;
    for (var j = 0; j < GROUP_LABELS.length; j++) {
      if (GROUP_LABELS[j].key === key) { label = GROUP_LABELS[j].name; break; }
    }
    var items = [];
    for (var k = 0; k < list.length; k++) {
      if (list[k].group === key) items.push(list[k]);
    }
    if (!items.length) continue;
    seen[key] = true;
    out.push({ key: key, name: label, items: items });
  }
  return out;
}

/* ============================== 共享动作槽 ============================== */

/**
 * 悬浮球与面板是两棵组件树（面板 Portal 到 body 以避免被布局容器裁剪），
 * 因此用这个动作槽连接：悬浮球挂载时填充，面板与入口按钮调用。
 */
var FloatBallActions = {
  selectEmotion: null,
  resetPos: null,
  placeAt: null,
  open: null,
  sayFor: null,
  sayText: null
};

/* ============================== 注视跟随 ============================== */

/**
 * 鼠标跟随：以球心为原点把光标位置归一化到 -1..1 交给引擎。
 * dragging 为真时暂停（拖动中不必让眼球乱转），指针离开文档时清空注视。
 */
function useGaze(ref, enabled, dragging) {
  var ctrl = react.useRef({ x: 0, y: 0, w: 0, h: 0 });

  react.useEffect(
    function () {
      if (typeof window === "undefined") return undefined;
      var cachedAt = 0;

      function measure() {
        var el = ref.current;
        if (!el) return;
        var r = el.getBoundingClientRect();
        ctrl.current = { x: r.left, y: r.top, w: r.width, h: r.height };
        cachedAt = now();
      }

      function onMove(e) {
        if (!enabled || dragging || !e) return;
        /* 球可能刚被拖动 / 页面刚滚动过：最多每 250ms 校正一次自己的矩形。
         * 早期版本用 500ms 定时轮询，即使鼠标不动也白读一次布局，已去掉。 */
        if (!cachedAt || now() - cachedAt > 250) measure();
        var c = ctrl.current;
        if (!c.w || !c.h) return;
        var el = ref.current;
        var ball = el && el.__dfbEngine;
        if (!ball || !ball.setGaze) return;
        ball.setGaze(
          clampNum((e.clientX - (c.x + c.w / 2)) / (c.w / 2), -1, 1),
          clampNum((e.clientY - (c.y + c.h / 2)) / (c.h / 2), -1, 1)
        );
      }

      function onLeave(e) {
        if (e && e.relatedTarget) return;
        var el = ref.current;
        var ball = el && el.__dfbEngine;
        if (ball && ball.clearGaze) ball.clearGaze();
      }

      measure();
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("resize", measure);
      window.addEventListener("scroll", measure, true);
      document.addEventListener("pointerleave", onLeave);

      return function () {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("resize", measure);
        window.removeEventListener("scroll", measure, true);
        document.removeEventListener("pointerleave", onLeave);
      };
    },
    [ref, enabled, dragging]
  );
}

/* ====================== 跑任务时的“生命循环”（见 24-life.js） ======================
 * 心率与动作都在 24-life.js 里，这里只负责在「会话在跑」期间开启它。
 */

/* 任务跑完的「松一口气」：短暂一个情绪化收尾，再交回大脑 / 待机 */
var RELIEF_EMOTIONS = ["19", "10", "33"];
var RELIEF_MS = 1400;

/* ============================== 聊天气泡 ==============================
 * 挂在球旁边，跟着球的位置走（拖动时是 200ms 轮询定位，不参与拖动热路径）。
 * 文字逐字打出，看起来像在说话而不是弹窗。
 */
var BUBBLE_GAP = 10;
var BUBBLE_MAX_W = 230;
var BUBBLE_TYPE_MS = 42;
/* 停留时长 = 打字时间 + 读数时间：读数按剩余字数 × 65ms，最少 2.6 秒、最多 9 秒。
 * 点一下可以再多留 5 秒慢慢看（不再需要「点掉」它）。 */
var BUBBLE_TYPE_LEAD_MS = 600;
var BUBBLE_READ_PER_CHAR_MS = 65;
var BUBBLE_READ_MIN_MS = 2600;
var BUBBLE_READ_MAX_MS = 9000;
var BUBBLE_LINGER_MS = 5000;

/** 心情 -> 气泡色调：让「开心」和「失落」看起来就不一样。 */
function bubbleTone(moodId) {
  var id = String(moodId || "").trim();
  if (/^\d$/.test(id)) id = "0" + id;      /* 数字 12 也要认，别掉进 plain */
  if (id === "10" || id === "19" || id === "33" || id === "14" || id === "13") return "warm";
  if (id === "12" || id === "15" || id === "18" || id === "21") return "blue";
  if (id === "17" || id === "34" || id === "38") return "alert";
  if (id === "30" || id === "16" || id === "32" || id === "40" || id === "31" || id === "37") return "work";
  return "plain";
}

function Bubble(props) {
  var anchorRef = props.anchorRef;
  var text = props.text || "";
  var boxRef = react.useRef(null);
  var [shown, setShown] = react.useState("");
  /* 每点一次多留 5 秒；不重置打字动画，也不清掉已显示的文字 */
  var [extraMs, setExtraMs] = react.useState(0);

  /* ---- 逐字说出 ---- */
  react.useEffect(function () {
    setShown("");
    if (!text) return undefined;
    var i = 0;
    /* 长句子（比如时段播报）打字快一点，别让「打字」本身占掉一半停留时间 */
    var speed = text.length > 30 ? Math.round(BUBBLE_TYPE_MS * 0.6) : BUBBLE_TYPE_MS;
    var timer = setInterval(function () {
      i++;
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(timer);
    }, speed);
    return function () { clearInterval(timer); };
  }, [text]);

  /* ---- 位置 + 小尖尖：气泡会跟着球跑，尖尖始终指向球心 ----
   * 气泡宽高与球心位置都在变（球可以拖、窗口可以缩），所以每一帧重新算：
   *   1. 横向：气泡尽量居中在球上，贴边时被夹进视口；
   *   2. 纵向：默认在球上方，上方放不下就翻到下方；
   *   3. 尖尖：横向偏移 = 球心 - 气泡左边（夹在圆角内），纵向跟着翻面。
   */
  react.useEffect(function () {
    function place() {
      var box = boxRef.current;
      var anchor = anchorRef && anchorRef.current;
      if (!box || !anchor || !anchor.getBoundingClientRect) return;
      var vp = viewport();
      var rect = anchor.getBoundingClientRect();
      var bw = box.offsetWidth || BUBBLE_MAX_W;
      var bh = box.offsetHeight || 44;
      var ballCx = rect.left + rect.width / 2;

      var left = clampNum(ballCx - bw / 2, 8, Math.max(8, vp.w - bw - 8));
      var above = rect.top - bh - BUBBLE_GAP >= 8;
      var top = above
        ? rect.top - bh - BUBBLE_GAP
        : clampNum(rect.top + rect.height + BUBBLE_GAP, 8, Math.max(8, vp.h - bh - 8));

      /* 尖尖指向球心的水平位置，夹在左右 14px 圆角内 */
      var tip = clampNum(ballCx - left, 14, Math.max(14, bw - 14));

      box.style.left = Math.round(left) + "px";
      box.style.top = Math.round(top) + "px";
      box.style.setProperty("--dfb-tip-x", Math.round(tip) + "px");
      box.setAttribute("data-side", above ? "top" : "bottom");
    }

    var raf = 0;
    function frame() {
      place();
      raf = window.requestAnimationFrame(frame);
    }

    place();
    frame();
    window.addEventListener("resize", place);
    return function () {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef, text]);

  /* ---- 停留时长 = 打字 + 读数 + 用户点的续时（点一次 +5 秒） ---- */
  react.useEffect(function () {
    if (!text || !props.onDone) return undefined;
    var typing = BUBBLE_TYPE_LEAD_MS + text.length * BUBBLE_TYPE_MS;
    var reading = clampNum(text.length * BUBBLE_READ_PER_CHAR_MS, BUBBLE_READ_MIN_MS, BUBBLE_READ_MAX_MS);
    var timer = setTimeout(function () { props.onDone(); }, typing + reading + extraMs);
    return function () { clearTimeout(timer); };
  }, [text, props.onDone, extraMs]);

  return jsx("div", {
    ref: boxRef,
    className: "dfb-bubble",
    "data-kind": props.source || "local",
    /* 按情绪给气泡换个观感：暖色心情 / 冷色低落 / 工作安静 / 慌张急促 */
    "data-tone": bubbleTone(props.mood),
    role: "status",
    "aria-live": "polite",
    title: extraMs > 0 ? "已多留 " + Math.round(extraMs / 1000) + " 秒（再点还能加）" : "点一下让它多留 5 秒",
    onClick: function () {
      /* 点一下是「我还没看完」：续时，而不是把话点掉 */
      setExtraMs(function (prev) { return prev + BUBBLE_LINGER_MS; });
    },
    children: shown
  });
}

/* ============================== 悬浮球组件 ============================== */

function FloatBall() {
  var ui = useUi();
  var cfg = ui.cfg;
  var ref = react.useRef(null);
  var dragRef = react.useRef(null);
  var holdTimer = react.useRef(null);
  var saveTimer = react.useRef(null);
  var firstRun = react.useRef(true);
  var hintShown = react.useRef(false);
  var mounted = react.useRef(false);
  var [dragging, setDragging] = react.useState(false);
  var [pos, setPos] = react.useState(initialPos);
  var [hint, setHint] = react.useState(false);
  var posRef = react.useRef(pos);
  var rafId = react.useRef(0);

  /**
   * 拖动期间直接改 DOM，不走 React：
   *   - 每个 pointermove 只更新 posRef，并用 rAF 合并成一帧一次 style 写入；
   *   - 不再 setState，避免每次移动都重渲染（球本体 + 表情面板两棵树）。
   * 松手时（persist=true）再同步回 React state，用于持久化与面板重排。
   */
  function applyPos(next, persist) {
    var el = ref.current;
    posRef.current = next;
    if (el) {
      el.style.left = next.x + "px";
      el.style.top = next.y + "px";
    }
    if (rafId.current) {
      window.cancelAnimationFrame(rafId.current);
      rafId.current = 0;
    }
    if (persist) {
      var vp = viewport();
      if (next.custom && vp.w && vp.h) savePosPref(next.x / vp.w, next.y / vp.h, next.size);
    }
  }

  function scheduleApply(next) {
    posRef.current = next;
    if (rafId.current) return;
    rafId.current = window.requestAnimationFrame(function () {
      rafId.current = 0;
      var el = ref.current;
      var latest = posRef.current;
      if (!el || !latest) return;
      el.style.left = latest.x + "px";
      el.style.top = latest.y + "px";
    });
  }

  function initialPos() {
    var pref = loadPosPref();
    var vp = viewport();
    var size = pref.size || SIZE_DEFAULT;
    if (pref.x !== null && pref.y !== null) {
      return { x: pref.x * vp.w, y: pref.y * vp.h, size: size, custom: true };
    }
    return { x: vp.w - size - 26, y: vp.h - size - 26, size: size, custom: false };
  }

  /* ---- 挂载引擎：表情 / 主题 / 空闲行为变化时重建，保证内部状态干净 ---- */
  react.useEffect(
    function () {
      var host = ref.current;
      if (!host) return undefined;
      var node = host.querySelector("[data-dfb-mount]");
      if (!node) return undefined;

      var colors = themeColors(cfg.theme);
      var inst = null;
      try {
        /* 重建引擎时不要直接落在「用户偏好」表情上：如果此刻正在跑任务或有
         * 大脑心情，应该直接以那个表情起步，否则会先闪一下待机再切回去。 */
        var stateNow = uiStore.get();
        var startEmotion = stateNow.mood
          || (cfg.auto !== false && stateNow.running ? AUTO_RUNNING_EMOTION : cfg.emotion);
        inst = ballEngine().create(node, {
          emotion: startEmotion,
          color: colors.color,
          eyeColor: colors.eyeColor,
          idle: cfg.idle === false ? false : undefined,
          label: "AI 表情球"
        });
        host.__dfbEngine = inst;
        if (inst.on) {
          inst.on("change", function (ev) {
            if (ev && ev.id) uiStore.set({ live: ev.id });
          });
        }
        uiStore.set({ live: inst.emotionId || cfg.emotion, ready: true });
      } catch (err) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[dsh-float-ball] 表情球创建失败：", err);
        }
      }

      return function () {
        host.__dfbEngine = null;
        if (inst && inst.destroy) {
          try { inst.destroy(); } catch (e) { /* ignore */ }
        }
        uiStore.set({ ready: false });
      };
    },
    [cfg.emotion, cfg.theme, cfg.idle]
  );

  /* state 变化（尺寸、位置预设、窗口修正）时同步回 ref 与 DOM */
  react.useLayoutEffect
    ? react.useLayoutEffect(function () { applyPos(pos, false); }, [pos])
    : react.useEffect(function () { applyPos(pos, false); }, [pos]);

  useGaze(ref, cfg.gaze === true, dragging);

  /* ---- 代理工作状态 -> 表情 ----
   * 会话在跑任务时，把球自动切到「思考中」；任务结束回到自己选的表情。
   * 不写进用户配置，只作为临时 mood 叠加，用户选择始终保留。 */
  react.useEffect(
    function () {
      var el = ref.current;
      var ball = el && el.__dfbEngine;
      if (!ball || !ball.setEmotion) return;
      /* 优先级：
       *   跑任务中   -> 小动作挑的工作表情，默认「思考中」
       *   任务结束   -> AI 大脑判断的心情（若开启）
       *   其余       -> 待机放空
       */
      var wanted = null;
      var brainId = ui.brain && ui.brain.id;
      if (ui.running) {
        wanted = (cfg.anim !== false && ui.taskMood) || AUTO_RUNNING_EMOTION;
        if (cfg.auto === false) wanted = null;
      } else if (cfg.brain === true && brainId) {
        wanted = brainId;
      } else if (cfg.auto !== false) {
        wanted = AUTO_IDLE_EMOTION;
      }
      if (wanted === ui.mood) return;
      var prevMood = ui.mood;
      uiStore.set({ mood: wanted });
      ball.setEmotion(wanted || cfg.emotion);
      if (ball.resetIdle) ball.resetIdle();
      /* 心情换了就说一句（sayNow 自带 20 秒节流，不会喋喋不休）。
       * 这里必须把「想要的表情」直接传下去：引擎的 setEmotion 是渐变的，
       * 立刻回读 emotionId 还会是旧表情，台词就会说错情绪。 */
      if (wanted && wanted !== prevMood) {
        speakNow(wanted, ui.brain && ui.brain.reason, false, true);
      }
    },
    [ui.running, ui.mood, ui.taskMood, cfg.auto, cfg.anim, cfg.brain, ui.brain && ui.brain.id, cfg.emotion]
  );

  /* ---- 生命循环：会话在跑时开启心跳与动作；结束即停 ---- */
  var runningRef = react.useRef(false);
  runningRef.current = ui.running === true;

  react.useEffect(
    function () {
      if (!ui.running || cfg.auto === false || cfg.anim === false) return undefined;
      var stop = startLifeLoop(ref, function () { return runningRef.current; });
      return function () {
        stop();
        uiStore.set({ taskMood: null });
      };
    },
    /* 只依赖“是否在跑 + 开关”：taskMood 由 mood 效果消费，不能进这里，
     * 否则每一拍都会重启心跳 */
    [ui.running, cfg.auto, cfg.anim]
  );

  /* ---- 敲字时看输入框：被打断就抬头看你一眼 ---- */
  react.useEffect(
    function () {
      if (cfg.anim === false) return undefined;
      var watcher = createComposerWatcher(ref);
      return watcher.start();
    },
    [cfg.anim]
  );

  /* ---- 会话由「跑」变「歇」的瞬间：松一口气 ---- */
  var reliefTimer = react.useRef(0);
  var wasRunning = react.useRef(false);
  react.useEffect(
    function () {
      if (ui.running) {
        wasRunning.current = true;
        return undefined;
      }
      if (!wasRunning.current) return undefined;
      wasRunning.current = false;
      if (cfg.anim === false) return undefined;

      /* 先把工作表情清掉，让 mood 效果接管，再盖一层“收尾表情” */
      uiStore.set({ taskMood: null });
      var id = RELIEF_EMOTIONS[Math.floor(Math.random() * RELIEF_EMOTIONS.length)];
      easeOut(ref, id);
      if (reliefTimer.current) clearTimeout(reliefTimer.current);
      reliefTimer.current = setTimeout(function () {
        reliefTimer.current = 0;
        var el = ref.current;
        var ball = el && el.__dfbEngine;
        var cfgNow = currentCfg();
        var brainId = uiStore.get().brain && uiStore.get().brain.id;
        var back = cfgNow.brain === true && brainId ? brainId
          : (cfgNow.auto !== false ? AUTO_IDLE_EMOTION : cfgNow.emotion);
        if (ball && ball.setEmotion) ball.setEmotion(back);
      }, RELIEF_MS);
      return undefined;
    },
    [ui.running, cfg.anim]
  );

  /* ---- 窗口尺寸变化后把球拉回可视区域 ---- */
  react.useEffect(function () {
    function onResize() {
      setPos(function (prev) {
        var vp = viewport();
        var x = clampNum(prev.x, 0, Math.max(0, vp.w - prev.size));
        var y = clampNum(prev.y, 0, Math.max(0, vp.h - prev.size));
        if (x === prev.x && y === prev.y) return prev;
        return { x: x, y: y, size: prev.size, custom: true };
      });
    }
    window.addEventListener("resize", onResize);
    return function () { window.removeEventListener("resize", onResize); };
  }, []);

  /* ---- 位置落盘：拖动结束与尺寸变化时写入（比例为值，跟随窗口缩放） ---- */
  react.useEffect(
    function () {
      if (!mounted.current) { mounted.current = true; return; }
      if (!pos.custom) return;
      var vp = viewport();
      if (!vp.w || !vp.h) return;
      savePosPref(pos.x / vp.w, pos.y / vp.h, pos.size);
    },
    [pos.x, pos.y, pos.size, pos.custom]
  );

  /* ---- 配置落盘：本地缓存立即写，宿主文件合并去抖后写 ---- */
  react.useEffect(
    function () {
      if (firstRun.current) { firstRun.current = false; return undefined; }
      writeLocal(STORE_CFG, cfg);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(function () {
        saveTimer.current = null;
        hostCall("float-ball/config", { config: cfg }, 4000);
      }, 600);
      return undefined;
    },
    [cfg.emotion, cfg.size, cfg.theme, cfg.gaze, cfg.idle, cfg.auto, cfg.anim, cfg.bubble, cfg.sayLocal, cfg.pricing, cfg.pricingMode, cfg.brain, cfg.brainOn, cfg.brainProvider, cfg.brainModel, cfg.seenHint]
  );

  /* ---- 首次提示：一次性气泡，几秒后自动消失并记忆 ---- */
  react.useEffect(
    function () {
      if (cfg.seenHint || hintShown.current) return undefined;
      hintShown.current = true;
      setHint(true);
      var t = setTimeout(function () {
        setHint(false);
        var next = Object.assign({}, currentCfg(), { seenHint: true });
        applyCfg(next);
        writeLocal(STORE_CFG, next);
        hostCall("float-ball/config", { config: next }, 4000);
      }, 6500);
      return function () { clearTimeout(t); };
    },
    [cfg.seenHint]
  );

  /* ---- 长按（触屏 / 鼠标通用）：打开设置面板 ----
   * 手机上没有右键，长按是最自然的手势；球本身 user-select:none +
   * -webkit-touch-callout:none，所以长按不会触发系统“复制文字”菜单。 */
  function clearHold() {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  function armHold(pointerType) {
    clearHold();
    holdTimer.current = setTimeout(function () {
      holdTimer.current = null;
      var d = dragRef.current;
      if (d && d.moved) return;
      dragRef.current = null;
      setDragging(false);
      if (pointerType === "touch" && window.navigator && window.navigator.vibrate) {
        try { window.navigator.vibrate(18); } catch (err) { /* ignore */ }
      }
      openPanel(ref.current);
    }, HOLD_MS);
  }

  /* ---- 手势：拖动定位 / 单击自旋 / 长按开面板（鼠标也可以右键） ---- */
  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType !== "touch") return;
    var el = ref.current;
    if (!el) return;
    var r = el.getBoundingClientRect();
    dragRef.current = {
      id: e.pointerId,
      px: e.clientX,
      py: e.clientY,
      bx: r.left,
      by: r.top,
      x: e.clientX,
      y: e.clientY,
      size: posRef.current.size || r.width,
      moved: false,
      pointerType: e.pointerType || "mouse"
    };
    /* 拖动前先清掉待执行的 rAF，避免旧位置把球拽回去 */
    if (rafId.current) {
      window.cancelAnimationFrame(rafId.current);
      rafId.current = 0;
    }
    armHold(e.pointerType);
  }

  function onPointerMove(e) {
    var d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    if (d.x === e.clientX && d.y === e.clientY) return;
    var dx = e.clientX - d.px;
    var dy = e.clientY - d.py;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) <= DRAG_THRESHOLD) return;
    if (!d.moved) {
      d.moved = true;
      clearHold();
      try { ref.current.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      d.vw = window.innerWidth || 390;
      d.vh = window.innerHeight || 844;
      setDragging(true);
    }
    d.x = e.clientX;
    d.y = e.clientY;
    var size = d.size;
    scheduleApply({
      x: clampNum(d.bx + dx, 0, Math.max(0, d.vw - size)),
      y: clampNum(d.by + dy, 0, Math.max(0, d.vh - size)),
      size: size,
      custom: true
    });
  }

  function endDrag(e) {
    clearHold();
    var d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    if (!d.moved) return;
    if (rafId.current) {
      window.cancelAnimationFrame(rafId.current);
      rafId.current = 0;
    }
    var final = posRef.current;
    applyPos(final, true);
    setDragging(false);
    /* 一次 state 同步：面板下次打开时按新位置摆放 */
    setPos({ x: final.x, y: final.y, size: final.size, custom: true });
    try { ref.current.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  /** 单击：撒花 + 自旋 + 弹跳，并把空闲计时归零；顺手回一句话。 */
  function onClick() {
    var el = ref.current;
    var ball = el && el.__dfbEngine;
    if (!ball) return;
    if (ball.burst) ball.burst(20);
    if (ball.spin) ball.spin(1);
    if (ball.bounce) ball.bounce();
    if (ball.resetIdle) ball.resetIdle();
    speakNow(uiStore.get().live || cfg.emotion, "", true);
  }

  /**
   * 说一句：由 18-speech.js 决定走模型还是本地台词。
   * @param moodId 目标表情（心情切换时传「想要的」，点击互动时传引擎当前值）
   * @param authoritative 为真表示 moodId 就是权威情绪，不要用引擎回读覆盖
   */
  function speakNow(moodId, reason, force, authoritative) {
    var engineNow = ballEngine();
    var list = emotionList(engineNow);
    var found = findEmotion(list, moodId);
    var brain = uiStore.get().brain || {};
    var context = brain.context || {};
    if (currentCfg().bubble === false) return;
    /* 本地台词的兜底要与「发这句话时的表情」一致：非权威场景（点击互动）用引擎
     * 当前值；权威场景（心情刚切到 12）直接用目标值，避免回读到旧表情。 */
    var el = ref.current;
    var shownNow = authoritative ? "" : (el && el.__dfbEngine ? el.__dfbEngine.emotionId : "");
    sayNow({
      mood: shownNow || moodId,
      moodName: found ? found.name : "",
      reason: reason || brain.reason || "",
      user: context.user || "",
      assistant: context.assistant || "",
      force: force === true
    });
  }

  function onKeyDown(e) {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      onClick();
    } else if (e.key === "Delete") {
      e.preventDefault();
      resetPos();
    }
  }

  /** 贴边落位：spot 为 'tl' | 'tr' | 'bl' | 'br' | 'center'，margin 语义为距边距离。 */
  function placeAt(spot, size) {
    var vp = viewport();
    var s = size || loadPosPref().size || SIZE_DEFAULT;
    var m = 26;
    var x;
    var y;
    if (spot === "tl") { x = m; y = m; }
    else if (spot === "tr") { x = vp.w - s - m; y = m; }
    else if (spot === "bl") { x = m; y = vp.h - s - m; }
    else if (spot === "center") { x = (vp.w - s) / 2; y = (vp.h - s) / 2; }
    else { x = vp.w - s - m; y = vp.h - s - m; }
    setPos({
      x: clampNum(x, 0, Math.max(0, vp.w - s)),
      y: clampNum(y, 0, Math.max(0, vp.h - s)),
      size: s,
      custom: spot !== "br"
    });
    if (spot === "br") {
      try { window.localStorage.removeItem(STORE_POS); } catch (err) { /* ignore */ }
    }
  }

  function resetPos() {
    placeAt("br");
  }

  /** 切换表情：同时清掉空闲计时，避免刚选完就被待机/睡眠覆盖。 */
  function selectEmotion(id) {
    var el = ref.current;
    var ball = el && el.__dfbEngine;
    var next = Object.assign({}, currentCfg(), { emotion: id, seenHint: true });
    if (ball && ball.setEmotion) {
      ball.setEmotion(id);
      if (ball.resetIdle) ball.resetIdle();
    }
    applyCfg(next);
  }

  /* ---- 键盘快捷键：1..9 对应前 9 个表情，0 对应第 10 个 ---- */
  react.useEffect(function () {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      var list = emotionList(ballEngine());
      if (e.key === "0") {
        if (list[9]) selectEmotion(list[9].id);
        return;
      }
      var n = parseInt(e.key, 10);
      if (String(n) === e.key && n >= 1 && n <= 9 && list[n - 1]) selectEmotion(list[n - 1].id);
    }
    window.addEventListener("keydown", onKey);
    return function () { window.removeEventListener("keydown", onKey); };
  }, []);

  /* ---- 把动作交给面板与入口按钮 ---- */
  react.useEffect(function () {
    FloatBallActions.selectEmotion = selectEmotion;
    FloatBallActions.resetPos = resetPos;
    FloatBallActions.placeAt = placeAt;
    FloatBallActions.open = function () { openPanel(ref.current); };
    /**
     * 直接说一句指定的内容（时段播报等固定文案用它）。
     * 不走模型、不查台词库：内容必须准，也不能花 token。
     */
    FloatBallActions.sayText = function (moodId, text) {
      if (!text) return;
      if (currentCfg().bubble === false) return;
      showSpeech(text, "pricing", String(moodId || ""), "");
    };

    /* 按指定表情说一句（走模型/台词库） */
    FloatBallActions.sayFor = function (moodId) {
      speakNow(String(moodId), "", true, true);
    };
    return function () {
      FloatBallActions.selectEmotion = null;
      FloatBallActions.resetPos = null;
      FloatBallActions.placeAt = null;
      FloatBallActions.open = null;
      FloatBallActions.sayFor = null;
      FloatBallActions.sayText = null;
    };
  });

  var liveId = ui.live || cfg.emotion;
  var live = findEmotion(emotionList(ballEngine()), liveId);

  var hintBox = null;
  if (hint) {
    var gap = 10;
    var hw = 208;
    var vp = viewport();
    var left = pos.x + pos.size + gap;
    if (left + hw > vp.w - 8) left = Math.max(8, pos.x - hw - gap);
    var top = clampNum(pos.y + pos.size / 2 - 20, 8, Math.max(8, vp.h - 72));
    hintBox = jsx("div", {
      className: "dfb-hint",
      style: { left: left, top: top, width: hw },
      children: "拖动我换位置 · 单击会自旋 · 长按打开表情面板"
    });
  }

  return jsxs(Fragment, {
    children: [
      jsx("div", {
        ref: ref,
        className: "dfb-ball",
        style: { left: pos.x, top: pos.y, width: pos.size, height: pos.size },
        "data-drag": dragging ? "1" : undefined,
        role: "button",
        tabIndex: 0,
        "aria-label": "表情球：" + (live ? live.name : liveId) + "（可拖动；单击自旋；长按或右键打开面板）",
        title: "拖动移动 · 单击自旋 · 长按或右键打开面板 · 数字键 1-9 换表情",
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
        onLostPointerCapture: endDrag,
        /* 开面板：长按（触屏/鼠标）、右键（鼠标）、侧边栏「表情球」。
         * 双击原本也开面板，但和单击自旋容易互相打架，已去掉。 */
        onContextMenu: function (e) { e.preventDefault(); openPanel(ref.current); },
        onClick: onClick,
        onKeyDown: onKeyDown,
        children: jsx("div", {
          "data-dfb-mount": "1",
          className: "dfb-ball-svg",
          style: { width: "100%", height: "100%" }
        })
      }),
      hintBox,
      ui.say && cfg.bubble !== false
        ? jsx(Bubble, {
            anchorRef: ref,
            text: ui.say.text || "",
            source: ui.say.source || "local",
            mood: ui.say.mood || "",
            moodName: ui.say.moodName || "",
            /* 读完了就换下一条排队的（没有排队则收起气泡） */
            onDone: function () { advanceSpeech(); }
          })
        : null
    ]
  });
}
