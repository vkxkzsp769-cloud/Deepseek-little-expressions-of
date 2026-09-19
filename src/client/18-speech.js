/* ============================================================================
 * 18-speech.js — 说话模块：给表情球配一个聊天气泡。
 *
 * 两种来源：
 *   模型（默认）——把「当前心情 + 原因 + 最近一轮对话」发给宿主，要一句话；
 *   本地台词库 —— 模型没配好 / 调用失败 / 用户选了「只用本地台词」时兜底。
 *
 * 节流：两次说话至少间隔 SAY_MIN_GAP_MS，且同一句不会连续重复，
 * 避免「每换一次表情就喋喋不休」。
 * ========================================================================== */

var SAY_MIN_GAP_MS = 20000;
var SAY_MAX_CHARS = 40;
var SAY_HISTORY = 3;

/* 本地台词库：key 用 mood 的表情 ID，命中不到就退回 * 通用台词。
 * 语气按情绪分组：正向欢快、负向小声委屈、工作状态安静。 */
var SPEECH_LINES = {
  "10": ["嘿嘿，今天顺顺利利的～", "这事办得漂亮，我有点小得意", "开心！转一圈给你看"],
  "12": ["……我是不是又搞砸了", "对不起，我再小心一点", "你别生气嘛，我记住了"],
  "13": ["欸？还能这样！", "哇，这个我没料到", "等等等等，让我看清楚"],
  "14": ["别、别这么夸我啦……", "我我我脸有点烫", "这种话听着怪不好意思的"],
  "17": ["别慌别慌，我这就去查", "啊呀，好像捅娄子了", "手忙脚乱中，稍等"],
  "18": ["行吧，那就先这样", "我也没办法呀……", "唉，又绕回来了"],
  "19": ["嗯，这样就很舒服了", "妥了，收工", "稳稳当当，我喜欢"],
  "20": ["等等，这里我有点绕晕了", "让我理一理……", "唔，好像哪里对不上"],
  "21": ["哼，我不说话了", "这就有点过分了吧", "气鼓鼓地蹲一会儿"],
  "30": ["我在想……别催我", "转两圈就有思路了", "让我把线索捋一根"],
  "16": ["安静点，我在看日志", "别打扰，快找到了", "专注中……"],
  "15": ["呼……有点累了", "这一轮好长啊", "我想找个角落歇会儿"],
  "35": ["我在这儿，你说", "等你的下一句", "要我做点什么吗"],
  "33": ["完成！撒个花庆祝一下", "跑通了，我请你看彩带", "搞定，叉腰"],
  "07": ["我来我来，这个我会！", "让我上，看着点", "交给我准没错"],
  "34": ["哎哟，出错了……", "这里红了，我看看", "抱歉，我碰到了个坎"],
  "40": ["在翻资料，别急", "一页一页找呢", "等等，我把文档捞出来"],
  "*": ["我在呢", "嗯……我在看着", "别管我，你忙你的"]
};

/* 本地台词的节流：同一句不要连着说两次 */
var speechLastLine = "";
var speechLastAt = 0;
var speechLastMood = "";
var speechHistory = [];

/** 取一句本地台词（模板模式或模型失败时用）。 */
function localLine(moodId) {
  var pool = SPEECH_LINES[moodId] || SPEECH_LINES["*"];
  var candidates = [];
  for (var i = 0; i < pool.length; i++) {
    if (pool[i] !== speechLastLine) candidates.push(pool[i]);
  }
  if (!candidates.length) candidates = pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** 说话节流：太近就不说（返回 false）。 */
function speechAllowed(force) {
  var now = Date.now();
  if (force) return true;
  if (now - speechLastAt < SAY_MIN_GAP_MS) return false;
  return true;
}

/** 上屏：写进 store，气泡组件负责展示与计时。 */
function showSpeech(text, source, mood) {
  if (!text) return;
  speechLastLine = text;
  speechLastMood = mood || "";
  speechLastAt = Date.now();
  speechHistory.push(text);
  if (speechHistory.length > SAY_HISTORY) speechHistory.shift();
  /* mood 一并记下来：气泡是「哪个表情说的话」，测试与排查都要看这个 */
  uiStore.set({ say: { text: text, at: Date.now(), source: source || "local", mood: mood || "" } });
}

function recentSpeech() {
  return speechHistory.join(" / ");
}

/** 说话节流状态的读写（读用于测试断言，写用于冒烟测试跳过 20 秒等待）。 */
function speechState() {
  return { lastAt: speechLastAt, lastLine: speechLastLine, lastMood: speechLastMood };
}

function resetSpeechThrottle() {
  speechLastAt = 0;
}

/**
 * 让球说一句。
 * @param {object} opts { mood, moodName, reason, force, services }
 */
function sayNow(opts) {
  var options = opts || {};
  var cfg = uiStore.get().cfg || {};
  if (cfg.bubble === false) return Promise.resolve(null);
  if (!speechAllowed(options.force)) return Promise.resolve(null);

  /* 本地台词先上屏，模型回来再替换（也有“先说一句”的手感） */
  if (cfg.sayLocal === true) {
    showSpeech(localLine(options.mood), "local", options.mood);
    return Promise.resolve(null);
  }

  var local = localLine(options.mood);
  var payload = {
    mood: options.mood || "",
    moodName: options.moodName || "",
    reason: options.reason || "",
    user: options.user || "",
    assistant: options.assistant || "",
    recent: recentSpeech()
  };
  uiStore.set({ sayBusy: true });
  return hostCall("float-ball/say", payload, 26000).then(function (value) {
    uiStore.set({ sayBusy: false });
    if (value && value.text) {
      showSpeech(value.text, "model", options.mood);
      return value.text;
    }
    /* 失败：用本地台词兜底，保证气泡不是空的 */
    showSpeech(local, "local-fallback", options.mood);
    return null;
  }, function () {
    uiStore.set({ sayBusy: false });
    showSpeech(local, "local-fallback", options.mood);
    return null;
  });
}
