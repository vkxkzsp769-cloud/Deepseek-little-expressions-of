/* ============================================================================
 * 22-pricing.js — 时段播报：每次开始会话时告诉用户现在是「高峰时段」还是
 * 「空闲时段」，以及对应的价格。
 *
 * 规则（DeepSeek 开放平台，北京时间 UTC+8）：
 *   高峰：周一至周五 9:00-12:00 与 14:00-18:00（不含中国法定节假日）
 *   空闲：其余所有时间（含周末、节假日全天）
 *   空闲价 = 高峰价的一半
 *
 * 价格表放在宿主半（lib/index.js）的 PRICING 表里，客户端只负责算时段、
 * 拼一句人话、告诉球说出来。这样调价时只改一处。
 * ========================================================================== */

/* 北京的分钟数边界：9:00-12:00、14:00-18:00 */
var PRICE_PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];
var PRICE_TZ_OFFSET_MIN = 8 * 60;

/* 同一条播报的最短重播间隔（时段变了会立刻重播） */
var PRICE_REPEAT_MS = 30 * 60 * 1000;

var priceState = { busy: false, at: 0, tier: null, line: "", table: null };

/**
 * 北京时间下的时段判定；返回 { tier, minutes, day, isWeekend, reason }。
 * 用 UTC 时间戳自己加 8 小时，不依赖运行环境的时区设置。
 */
function computePricingTier(whenMs) {
  /* 直接按 UTC + 8 小时算北京时间，不掺本地时区，和宿主口径一致 */
  var d = new Date(whenMs || Date.now());
  var bj = new Date(d.getTime() + PRICE_TZ_OFFSET_MIN * 60000);
  var day = bj.getUTCDay();                       /* 0 周日 … 6 周六 */
  var minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  var isWeekend = day === 0 || day === 6;
  var inWindow = false;
  for (var i = 0; i < PRICE_PEAK_WINDOWS.length; i++) {
    var w = PRICE_PEAK_WINDOWS[i];
    if (minutes >= w[0] && minutes < w[1]) { inWindow = true; break; }
  }
  return {
    tier: !isWeekend && inWindow ? "peak" : "offpeak",
    minutes: minutes,
    day: day,
    isWeekend: isWeekend,
    bjHour: bj.getUTCHours(),
    hhmm: pad2(bj.getUTCHours()) + ":" + pad2(bj.getUTCMinutes())
  };
}

function pad2(n) { return n < 10 ? "0" + n : String(n); }

/** 距离下一次时段切换还有多久（人话）。 */
function untilNextSwitch(info) {
  var minutes = info.minutes;
  var next = null;
  if (info.isWeekend) return "整个周末都是空闲时段";
  for (var i = 0; i < PRICE_PEAK_WINDOWS.length; i++) {
    var w = PRICE_PEAK_WINDOWS[i];
    if (minutes < w[0]) { next = w[0]; break; }
    if (minutes >= w[0] && minutes < w[1]) { next = w[1]; break; }
  }
  if (next === null) {
    /* 18:00 之后到次日 9:00 都是空闲 */
    return info.tier === "offpeak" ? "到明天 9:00 前都是空闲时段" : "";
  }
  var gap = next - minutes;
  if (gap <= 0) return "";
  var h = Math.floor(gap / 60);
  var m = gap % 60;
  var human = (h > 0 ? h + " 小时" : "") + (m > 0 ? m + " 分钟" : "");
  return info.tier === "peak" ? "还有 " + human + " 恢复空闲价" : "还有 " + human + " 就到高峰时段";
}

/* 播报的语气：这句话会出现很多次，得像个活物在提醒你，而不是复制粘贴。
 * 数字必须准（来自价格表），语气随时段、周末与否、你现在在不在干活而变。
 * 占位符：{pi}{po} 高峰输入/输出，{oi}{oo} 空闲输入/输出，{unit} 单位（只出现一次），{tip} 下一段时段。 */
var PRICE_TONE = {
  peak: {
    work: [
      "高峰时段咯——输入 {pi}、输出 {po}，钱包在滴血。{tip}",
      "现在是高峰价：输入 {pi}、输出 {po}，忍一忍。{tip}",
      "提醒一下：高峰期，输入 {pi}、输出 {po}，贵一倍。{tip}"
    ],
    idle: [
      "现在是高峰时段：输入 {pi}、输出 {po}。{tip}",
      "高峰时段，输入 {pi}、输出 {po}，比空闲贵一倍。{tip}",
      "提醒你一声，现在是高峰价：输入 {pi}、输出 {po}。{tip}"
    ]
  },
  offpeak: {
    night: [
      "半夜最划算——空闲价，输入 {oi}、输出 {oo}，只有高峰的一半。{tip}",
      "这个点儿便宜：输入 {oi}、输出 {oo}，高峰要 {pi}、{po}。{tip}",
      "夜里半价哦：输入 {oi}、输出 {oo}。{tip}"
    ],
    early: [
      "早上好，现在还是空闲价：输入 {oi}、输出 {oo}，赶紧用。{tip}",
      "赶在高峰前，便宜：输入 {oi}、输出 {oo}，高峰是 {pi}、{po}。{tip}"
    ],
    weekend: [
      "周末整天空闲价：输入 {oi}、输出 {oo}，高峰要 {pi}、{po}。{tip}",
      "周末不打高峰价：输入 {oi}、输出 {oo}。{tip}"
    ],
    work: [
      "现在是空闲时段（半价）：输入 {oi}、输出 {oo}，高峰要 {pi}、{po}。{tip}",
      "这会是便宜时段：输入 {oi}、输出 {oo}，趁现在。{tip}",
      "空闲价，输入 {oi}、输出 {oo}，高峰的一半。{tip}"
    ],
    idle: [
      "空闲时段（半价）：输入 {oi}、输出 {oo}。{tip}",
      "现在是空闲价：输入 {oi}、输出 {oo}。{tip}",
      "便宜时段，输入 {oi}、输出 {oo}，高峰要 {pi}、{po}。{tip}"
    ]
  }
};

/** 按「时段 + 用户当前在不在干活 + 北京时间」挑一组语气。 */
function pickPriceTone(info) {
  if (info.manual) return info.tier === "peak" ? "peak-idle" : "offpeak-idle";
  if (info.tier === "peak") return uiStore.get().running ? "peak-work" : "peak-idle";
  if (info.isWeekend) return "offpeak-weekend";
  if (info.bjHour === undefined) return "offpeak-idle";
  if (info.bjHour >= 23 || info.bjHour < 6) return "offpeak-night";
  if (info.bjHour < 9) return "offpeak-early";
  return uiStore.get().running ? "offpeak-work" : "offpeak-idle";
}

/** 拼一句播报（不用模型：价格必须准，也不能花 token）。 */
function buildPricingLine(info, table) {
  var peak = table && table.peak;
  var off = table && table.offpeak;
  if (!peak || !off) return "";

  var key = pickPriceTone(info);
  var parts = key.split("-");
  var group = PRICE_TONE[parts[0]] || {};
  var bank = group[parts[1]] || group.idle || group.work || [];
  if (!bank.length) return "";

  var template = bank[Math.floor(Math.random() * bank.length)];
  var tip = untilNextSwitch(info);
  var unit = "元每百万 tokens";

  var line = template
    .replace(/\{pi\}/g, peak.inputCacheMiss)
    .replace(/\{po\}/g, peak.output)
    .replace(/\{oi\}/g, off.inputCacheMiss)
    .replace(/\{oo\}/g, off.output);

  /* 单位统一补在第一个数字后面，只出现一次：不手写进模板就不会写得啰嗦或漏掉 */
  line = line.replace(/(输入 [\d.]+)/, "$1（" + unit + "）");

  /* 拼 tip：模板里 {tip} 前面有句号就让它独立成句，否则用逗号接上 */
  if (tip) {
    line = /。\s*\{tip\}/.test(line)
      ? line.replace(/。\s*\{tip\}/, "。" + tip)
      : line.replace(/\s*\{tip\}/, "，" + tip);
  } else {
    line = line.replace(/\s*\{tip\}/, "");
  }

  return line.trim()
    .replace(/\s+([，。！？])/g, "$1")
    .replace(/[，、]{2,}/g, "，")
    .replace(/。[，、]/g, "。")
    .replace(/[，、]$/, "。")
    .replace(/\(\)/g, "")
    .replace(/([^。！？…～])$/, "$1。");
}

/**
 * 一次播报：算时段 -> 取价格表（宿主，带缓存）-> 让球说出来。
 * @param force 为真则忽略「同一条 30 分钟内不重播」的限制。
 */
function announcePricing(force) {
  var cfg = uiStore.get().cfg || {};
  if (cfg.pricing === false) return Promise.resolve(null);
  var manual = cfg.pricingMode;
  var info = (manual === "peak" || manual === "offpeak")
    ? Object.assign(computePricingTier(), { tier: manual, manual: true })
    : computePricingTier();

  if (!force && priceState.tier === info.tier && Date.now() - priceState.at < PRICE_REPEAT_MS) {
    return Promise.resolve(null);
  }

  function speak(table) {
    var model = (uiStore.get().model && uiStore.get().model.model) || "";
    var line = buildPricingLine(info, table, model);
    if (!line) return null;
    priceState = { busy: false, at: Date.now(), tier: info.tier, line: line, table: table };
    if (FloatBallActions && typeof FloatBallActions.sayText === "function") {
      /* 用「专注」的心情、直接把这句话说出去（不走模型） */
      FloatBallActions.sayText("16", line);
    } else {
      uiStore.set({ say: { text: line, at: Date.now(), source: "pricing", mood: "16", moodName: "专注" } });
    }
    return line;
  }

  priceState.busy = true;
  return hostCall("float-ball/pricing", { model: (uiStore.get().model && uiStore.get().model.model) || "" }, 6000)
    .then(function (value) {
      var table = value && value.pricing ? value.pricing : null;
      /* 时段以本地口径为准：宿主的 tier 只在显式要求时覆盖（见 pricingMode）。
       * 两边口径不一致时（例如节假日），宁可跟用户看到的日历一致。 */
      if (value && value.forceTier) info.tier = value.forceTier;
      if (!table) table = FALLBACK_PRICING;
      return speak(table);
    }, function () {
      return speak(FALLBACK_PRICING);
    });
}

/** 宿主不可用时的兜底价格表（DeepSeek flash 档，元/百万 tokens）。 */
var FALLBACK_PRICING = {
  model: "deepseek-flash",
  peak: { inputCacheHit: "0.04", inputCacheMiss: "2", output: "8" },
  offpeak: { inputCacheHit: "0.02", inputCacheMiss: "1", output: "4" }
};

/**
 * 会话开始时的播报：每次「用户开口」都会检查一次，但同一条 30 分钟内只说一次，
 * 时段变了会立刻重播。是否已经有了对话由会话事件窗口判断。
 */
function startPricing(services) {
  var sessions = services && services.sessions;
  var list = sessions && sessions.list;
  var announce = function (force) { announcePricing(force); };

  /* 应用启动就播一次（页面刚打开 = 一次会话的开始） */
  var bootTimer = setTimeout(function () { announce(false); }, 2500);

  var unsubscribe = null;
  var bound = null;
  function pick() {
    if (!list || typeof list.getSnapshot !== "function") return null;
    try {
      var state = list.getSnapshot();
      return (state && state.current) || (state && state.ids && state.ids[0]) || null;
    } catch (err) { return null; }
  }
  function rebind() {
    var id = pick();
    if (id === bound) return;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    bound = id;
    if (!id || !sessions || typeof sessions.binding !== "function") return;
    var source = null;
    try {
      var b = sessions.binding(id);
      source = b && b.eventSource;
    } catch (err) { source = null; }
    if (!source || typeof source.subscribe !== "function") return;
    var lastSeq = -1;
    unsubscribe = source.subscribe(function () {
      var seq = -1;
      try {
        var win = source.getSnapshot();
        var entries = (win && win.entries) || [];
        for (var i = entries.length - 1; i >= 0 && i > entries.length - 31; i--) {
          var entry = entries[i];
          var ev = entry && entry.type === "event" ? entry.event : null;
          if (ev && ev.type === "user/message") { seq = ev.seq || 0; break; }
        }
      } catch (err) { return; }
      if (seq < 0 || seq === lastSeq) return;
      lastSeq = seq;
      /* 用户刚开口 = 一次新的会话开始 */
      announce(false);
    });
  }

  var poll = setInterval(rebind, 3000);
  rebind();
  if (list && typeof list.subscribe === "function") {
    var unsubList = list.subscribe(rebind);
    return function () {
      clearTimeout(bootTimer);
      clearInterval(poll);
      if (unsubList) unsubList();
      if (unsubscribe) unsubscribe();
    };
  }
  return function () {
    clearTimeout(bootTimer);
    clearInterval(poll);
    if (unsubscribe) unsubscribe();
  };
}

/** 供面板/测试读取当前时段与上次播报。 */
/** 面板切了判定/开关后立刻重播一次（用户要马上看到效果）。 */
function refreshPricing() {
  var cfg = uiStore.get().cfg || {};
  if (cfg.pricing === false) {
    priceState = { busy: false, at: 0, tier: null, line: "", table: priceState.table || null };
    return Promise.resolve(null);
  }
  return announcePricing(true);
}

function pricingState(nowMs) {
  var cfg = uiStore.get().cfg || {};
  var info = computePricingTier(nowMs);
  if (cfg.pricingMode === "peak" || cfg.pricingMode === "offpeak") info.tier = cfg.pricingMode;
  return {
    tier: info.tier,
    hhmm: info.hhmm,
    isWeekend: info.isWeekend,
    until: untilNextSwitch(info),
    lastLine: priceState.line,
    lastAt: priceState.at
  };
}
