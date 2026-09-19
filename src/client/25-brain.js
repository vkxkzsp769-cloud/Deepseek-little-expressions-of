/* ============================================================================
 * 25-brain.js — AI 大脑：把「用户和 AI 刚聊了什么」交给模型判断，选一个表情。
 *
 * 触发时机：会话从 running 变回空闲（一轮对话结束），且面板里的「AI 心情」开着。
 * 开销控制：每次只发用户最后一句 + 助手最后一段（各截断），要求模型只回两位
 * 表情 ID；真正花钱的只有每轮一次的极短分类调用。
 * 所有失败都静默降级（表情回到用户的默认选择），绝不影响界面。
 * ========================================================================== */

/* 会话事件窗口里倒着找几段文本的扫描上限，避免超长会话每次都全量遍历 */
var BRAIN_SCAN_LIMIT = 240;
var BRAIN_USER_CHARS = 360;
var BRAIN_ASSISTANT_CHARS = 480;

/* 最小调用间隔（同一会话）：连续消息 / 连续任务收尾都按这个节流，
 * 避免“用户连发三条”就触发三次调用。20 秒 ≈ 一轮工具调用的量级。 */
var BRAIN_MIN_GAP_MS = 20000;

/* 单次大脑请求的兜底时限：超过它就不再认为“还在调用中” */
var BRAIN_REQUEST_TIMEOUT_MS = 25000;

/** 从内容块里拼出纯文本（只取 text 块，忽略图片/工具块）。 */
function blocksToText(content, max) {
  if (!content) return "";
  var list = Array.isArray(content) ? content : [content];
  var out = "";
  for (var i = 0; i < list.length && out.length < max; i++) {
    var block = list[i];
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") out += block.text;
    else if (typeof block.text === "string") out += block.text;
  }
  return out.slice(0, max).trim();
}

/** 把 chunk 行里的多条事件也摊平成事件流（历史窗口可能被压缩成 chunk 行）。 */
function flattenEntries(entries) {
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!entry) continue;
    if (entry.type === "event" && entry.event) {
      out.push(entry.event);
    } else if (entry.type === "chunks" && entry.event) {
      var events = entry.event.events || entry.event;
      if (Array.isArray(events)) {
        for (var j = 0; j < events.length; j++) if (events[j]) out.push(events[j]);
      }
    }
  }
  return out;
}

/** 取最近一轮对话：最后一条用户消息 + 最后一条助手回复。 */
function latestPair(eventSource) {
  try {
    if (!eventSource || typeof eventSource.getSnapshot !== "function") return null;
    var win = eventSource.getSnapshot();
    if (!win || !Array.isArray(win.entries)) return null;
    var events = flattenEntries(win.entries);
    var user = "";
    var assistant = "";
    var scanned = 0;
    for (var i = events.length - 1; i >= 0 && scanned < BRAIN_SCAN_LIMIT; i--, scanned++) {
      var ev = events[i];
      if (!ev || !ev.data) continue;
      if (!assistant && ev.type === "assistant/message" && ev.data.message) {
        assistant = blocksToText(ev.data.message.content, BRAIN_ASSISTANT_CHARS);
      } else if (!user && ev.type === "user/message") {
        user = blocksToText(ev.data.content, BRAIN_USER_CHARS);
      }
      if (user && assistant) break;
    }
    if (!user && !assistant) return null;
    return { user: user, assistant: assistant };
  } catch (err) {
    return null;
  }
}

/**
 * 当前会话「正在使用的模型」。
 *
 * 取 dsh 自己的模型目录（客户端共享服务 modelDirectories）：它的 current 就是
 * 那条会话下一次请求会用的 provider/model（用户选过就用用户选的，没选过就是
 * Host 默认），和聊天输入框上方显示的模型是同一份状态。所以表情球的大脑用的
 * 模型始终跟当前会话一致，不需要单独配置。
 */
function currentModel() {
  try {
    var ctx = Util.appCtx;
    var sessions = Util.sessions;
    var directories = ctx && typeof ctx.get === 'function' ? ctx.get('modelDirectories') : null;
    if (!directories || typeof directories.directoryFor !== 'function') return null;
    var list = sessions && sessions.list;
    if (!list || typeof list.getSnapshot !== 'function') return null;
    var state = list.getSnapshot();
    var id = (state && state.current) || (state && state.ids && state.ids[0]);
    if (!id) return null;
    var directory = directories.directoryFor(id);
    var snapshot = directory && directory.store && directory.store.getSnapshot
      ? directory.store.getSnapshot()
      : null;
    var current = snapshot && snapshot.current;
    if (!current || !current.provider || !current.model) return null;
    return { provider: current.provider, model: current.model, reasoningEffort: current.reasoningEffort };
  } catch (err) {
    return null;
  }
}

/** 订阅模型目录的变化，把「当前模型」写进 store（面板展示 + 供大脑请求使用）。 */
function watchModel(sessions) {
  var ctx = Util.appCtx;
  var directories = ctx && typeof ctx.get === 'function' ? ctx.get('modelDirectories') : null;
  if (!directories || typeof directories.directoryFor !== 'function') return function () {};
  var bound = null;
  var unsubscribe = null;

  function pick() {
    var list = sessions && sessions.list;
    if (!list || typeof list.getSnapshot !== 'function') return null;
    var state = list.getSnapshot();
    return (state && state.current) || (state && state.ids && state.ids[0]) || null;
  }

  function publish() {
    var next = currentModel();
    var prev = uiStore.get().model;
    if (next === null && prev === null) return;
    if (next && prev && next.provider === prev.provider && next.model === prev.model) return;
    uiStore.set({ model: next });
  }

  function rebind() {
    var id = pick();
    if (id === bound) return;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    bound = id;
    if (!id) { publish(); return; }
    try {
      var directory = directories.directoryFor(id);
      if (directory && directory.store && typeof directory.store.subscribe === 'function') {
        unsubscribe = directory.store.subscribe(publish);
      }
    } catch (err) { unsubscribe = null; }
    publish();
  }

  return function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  };
}

/** 当前选中会话的事件源（没有选中时返回 null）。 */
function currentEventSource(sessions) {
  if (!sessions || typeof sessions.binding !== "function") return null;
  var list = sessions.list;
  if (!list || typeof list.getSnapshot !== "function") return null;
  var id;
  try {
    var state = list.getSnapshot();
    id = state && state.current;
    if (!id && state && state.ids && state.ids.length) id = state.ids[0];
  } catch (err) {
    return null;
  }
  if (!id) return null;
  try {
    var binding = sessions.binding(id);
    return binding && binding.eventSource ? binding.eventSource : null;
  } catch (err) {
    return null;
  }
}

/**
 * 问一次「大脑」：把最近一对消息发给宿主，宿主调用已配置的模型选表情。
 * 结果写进 uiStore.brain，mood 由 20-ball 的叠加逻辑消费。
 */
function requestBrainMood(sessions, services) {
  var pair = latestPair(currentEventSource(sessions));
  if (!pair) return Promise.resolve(null);
  var cfg = uiStore.get().cfg || {};
  var route = currentModel() || {};
  var ids = [];
  var engine = Util.Engine;
  var emotions = (engine && engine.EMOTIONS) || [];
  for (var i = 0; i < emotions.length; i++) ids.push({ id: emotions[i].id, name: emotions[i].name });
  if (!ids.length) return Promise.resolve(null);

  uiStore.set({ brain: { busy: true, id: null, reason: "", error: null } });
  return hostCall(
    "float-ball/mood",
    {
      user: pair.user,
      assistant: pair.assistant,
      emotions: ids,
      /* 跟随当前会话正在用的模型；拿不到就让宿主回退到 dsh 默认模型 */
      provider: cfg.brainProvider || route.provider || null,
      model: cfg.brainModel || route.model || null,
      reasoningEffort: route.reasoningEffort || null
    },
    25000
  ).then(function (value) {
    if (!value || !value.id) {
      uiStore.set({ brain: { busy: false, id: null, reason: "", error: (value && value.error) || "大脑没有返回表情", context: { user: pair.user, assistant: pair.assistant } } });
      return null;
    }
    uiStore.set({ brain: { busy: false, id: value.id, reason: value.reason || "", error: null, context: { user: pair.user, assistant: pair.assistant } } });
    return value.id;
  }).catch(function (err) {
    uiStore.set({ brain: { busy: false, id: null, reason: "", error: String((err && err.message) || err), context: { user: pair.user, assistant: pair.assistant } } });
    return null;
  });
}

/**
 * 会话观察 + 大脑触发。
 *
 * 两种触发时机（面板「心情」里切换）：
 *   task（默认）—— 整轮任务结束（running true→false）判断一次；
 *   message      —— 每收到一条新的 assistant/message 判断一次，并按
 *                   BRAIN_MIN_GAP_MS 节流，避免连续消息把调用打爆。
 *
 * 两种时机都复用同一套判断：模型没配 / 报错 / 已关大脑都只是不换表情。
 */
function createAgentObserver(services) {
  var sessions = services && services.sessions;
  var list = sessions && sessions.list;
  var state = {
    running: false,
    pending: false,
    inFlight: false,
    inFlightSince: 0,
    watchdog: 0,
    lastCallAt: 0,
    lastSeq: 0,
    boundSession: null,
    unsubscribeEvents: null
  };
  var idle = { state: state, start: function () { return function () {}; } };
  if (!sessions || !list || typeof list.subscribe !== 'function' || typeof list.getSnapshot !== 'function') {
    return idle;
  }

  function currentId() {
    try {
      var snapshot = list.getSnapshot();
      if (snapshot && snapshot.current) return snapshot.current;
      if (snapshot && snapshot.ids && snapshot.ids.length) return snapshot.ids[0];
    } catch (err) { /* ignore */ }
    return null;
  }

  /** 一次调用：关掉大脑 / 正在调用 / 距上次太近 都直接跳过。 */
  function fire(reason) {
    var cfg = uiStore.get().cfg || {};
    if (cfg.brain === false) return;
    /* 超过 BRAIN_REQUEST_TIMEOUT_MS 仍算“上一轮已结束”，避免任何卡住的请求
     * 把之后的触发永久吃掉（请求本身另有 25 秒超时）。 */
    if (state.inFlight && Date.now() - state.inFlightSince < BRAIN_REQUEST_TIMEOUT_MS) return;
    var now = Date.now();
    if (now - state.lastCallAt < BRAIN_MIN_GAP_MS) return;
    state.lastCallAt = now;
    state.inFlight = true;
    state.inFlightSince = now;

    function settle() {
      state.inFlight = false;
      state.inFlightSince = 0;
    }
    /* 成功/失败/异常三条路都必须复位 inFlight：
     * 只挂成功回调曾经让一次异常把后面所有触发静默吃掉。 */
    requestBrainMood(sessions, services, reason).then(settle, settle);
    state.watchdog = setTimeout(settle, BRAIN_REQUEST_TIMEOUT_MS + 5000);
    if (state.watchdog && typeof state.watchdog.unref === "function") state.watchdog.unref();
  }

  /** 事件窗口里最新的 assistant/message 序号；没变化就不触发。 */
  function watchEvents() {
    var id = currentId();
    if (id === state.boundSession) return;
    if (state.unsubscribeEvents) {
      state.unsubscribeEvents();
      state.unsubscribeEvents = null;
    }
    state.boundSession = id;
    /* -1 而不是 0：会话里已有的最后一条助手消息就是“下一件新事”，
     * 归零会让它被误判成已处理过，message 模式下第一条永远不触发。 */
    state.lastSeq = -1;
    if (!id) return;
    var source = null;
    try {
      var binding = sessions.binding(id);
      source = binding && binding.eventSource;
    } catch (err) { source = null; }
    if (!source || typeof source.subscribe !== 'function') return;
    state.unsubscribeEvents = source.subscribe(function () {
      var cfg = uiStore.get().cfg || {};
      if (cfg.brain === false || cfg.brainOn !== 'message') return;
      var seq = 0;
      try {
        var win = source.getSnapshot();
        var entries = (win && win.entries) || [];
        for (var i = entries.length - 1; i >= 0 && i > entries.length - 41; i--) {
          var entry = entries[i];
          var ev = entry && entry.type === 'event' ? entry.event : null;
          if (ev && ev.type === 'assistant/message') { seq = ev.seq || 0; break; }
        }
      } catch (err) { return; }
      if (!seq || seq === state.lastSeq) return;
      state.lastSeq = seq;
      fire('message');
    });
  }

  function evaluate() {
    /* 直接从 store 读当前快照：不要依赖任何在模块求值期捕获下来的配置对象 */
    var liveCfg = uiStore.get().cfg || {};
    var running = false;
    try { running = pickRunning(list.getSnapshot()); } catch (err) { running = false; }
    if (running !== state.running) {
      state.running = running;
      uiStore.set({ running: running });
      if (running) state.pending = true;
    }
    if (state.pending && !running) {
      state.pending = false;
      if (liveCfg.brainOn !== 'message') fire('task');
    }
    watchEvents();
  }

  return {
    state: state,
    start: function () {
      evaluate();
      var unsubscribeList = list.subscribe(evaluate);
      /* 面板里改「时机 / 开关」时也要立刻重算（订阅还没建起来就改成 message 的场景） */
      var stopCfg = uiStore.subscribe(evaluate);
      var stopModel = watchModel(sessions);
      return function () {
        if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = 0; }
        if (typeof unsubscribeList === 'function') unsubscribeList();
        stopCfg();
        stopModel();
        if (state.unsubscribeEvents) {
          state.unsubscribeEvents();
          state.unsubscribeEvents = null;
        }
      };
    }
  };
}
