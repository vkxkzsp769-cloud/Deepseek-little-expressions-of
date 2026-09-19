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
var SAY_HISTORY = 6;

/* 「人味」的两条硬规则，客户端先兜一道：
 *   1) 不重复最近说过的句子（开头两个字撞车也换掉）；
 *   2) 不像客服道歉模板。模型再犯就重试一次，还不行才用本地台词。 */
var SAY_BANNED_PREFIX = /^\s*(?:非常|十分|很抱歉|对不起我|抱歉，我|不好意思我)/;
var SAY_TEMPLATE_HINTS = [
  { re: /再看一遍|重新看|再检查/, why: '重复“再看一遍”' },
  { re: /^我[^，。！？…]{0,3}[，,]?我/, why: '两个“我”连着' },
  /* 模型偶尔会把系统提示抄进正文（实测见过“10-26字…不能道歉，不能客服腔”） */
  { re: /不能道歉|客服腔|内心\s*OS|第一人称|\d+\s*[-~到]\s*\d+\s*字|风格偏向|语气必须|不许重复|这不是台词/, why: '疑似把提示词抄出来了' }
];

/** 与最近说过的话重复度：相同开头 2 字，或出现同样的 4 字短语。 */
function repeatsRecent(text) {
  if (!text) return true;
  var head = text.slice(0, 2);
  for (var i = 0; i < speechHistory.length; i++) {
    var old = speechHistory[i];
    if (!old) continue;
    if (old.slice(0, 2) === head) return true;
    for (var j = 0; j + 4 <= text.length; j++) {
      if (old.indexOf(text.slice(j, j + 4)) >= 0 && j === 0) return true;
    }
  }
  return false;
}

/** 是不是太像「客服道歉」/ 太像模板。 */
function looksTemplate(text) {
  if (SAY_BANNED_PREFIX.test(text)) return true;
  for (var i = 0; i < SAY_TEMPLATE_HINTS.length; i++) {
    if (SAY_TEMPLATE_HINTS[i].re.test(text)) return true;
  }
  return false;
}

/** 这句话够不够「像人」：要有一点情绪词或语气词，且不能太短太干。 */
function livelyEnough(text) {
  if (text.length < 6) return false;
  return /[～…！？嘛呀啦吧哦喔欸唔哼嘻哈诶嘿嘞咧]|[.。]{2,}|[?？!！]/.test(text) || text.length >= 12;
}

/** 走模型之前先本地筛：不合格就让调用方重试。 */
function acceptableLine(text) {
  return !!text && !repeatsRecent(text) && !looksTemplate(text) && livelyEnough(text);
}

/* 本地台词库：key 用 mood 的表情 ID，命中不到就退回 * 通用台词。
 * 每组 4-5 句、带性格（会撒娇、会嘴硬、会自嘲、会偷懒），零 token 也要有趣。 */
var SPEECH_LINES = {
  "10": ["嘿嘿，顺顺利利的，今天风都往我这边吹～", "我叉会儿腰，你别拦我", "开心到想原地转三圈给你看", "这事儿我记住了，下次还找我"],
  "12": ["……我蹲在角落缓一缓，一会儿就好", "你不喜欢我也没办法呀，我先难过一下下", "是我拖后腿了，我认", "委屈，但我不吵你"],
  "13": ["欸？！这个我可真没料到", "等等等等，我得再看一眼", "哇——还有这种操作", "眼睛都睁圆了，你看见没"],
  "14": ["别、别这么夸我啦……", "你再说我就要躲到球背面去了", "我我我脸有点烫，先转个圈", "这种话听着怪不好意思的嘛"],
  "17": ["别慌别慌，我先去翻日志", "啊呀，好像捅娄子了", "手忙脚乱中，你稍等我一下", "慢一点慢一点，我跟不上节奏了"],
  "18": ["行吧，那就先这样", "我也没办法呀，这事不归我管", "唉，又绕回原点了", "摊平，先不挣扎"],
  "19": ["嗯，这样就很舒服了", "妥了，我收工", "稳稳当当，我喜欢这种节奏", "这波配合得不错嘛"],
  "20": ["等等，我有点绕晕了", "唔……哪里对不上呢", "让我把这几根线抽出来理一理", "脑子里的线团打结了"],
  "21": ["哼，我暂时不说话了", "这就有点过分了吧", "气鼓鼓地蹲着，别理我", "我生气三秒钟，你数着"],
  "30": ["我在想……别催我", "转两圈就有思路了", "让我把线索捋一根出来", "别急，脑子正在转，真的"],
  "16": ["安静点，我在看日志", "别打扰，快找到了", "专注中……外面的世界先静音", "这行代码有点眼熟"],
  "15": ["呼……有点累了", "这一轮好长啊，我想趴会儿", "我需要一勺能量", "眼皮开始打架了"],
  "35": ["我在这儿，你说", "等你的下一句呢", "要我做点什么吗，说一声就行", "闲着也是闲着，随时待命"],
  "33": ["完成！撒个花庆祝一下", "跑通了，我请你看彩带", "搞定，叉腰三秒", "成了成了，我就说能行吧"],
  "07": ["我来我来，这个我会！", "让我上，你看着点", "交给我准没错，抖擞一下", "精神了，说吧干什么"],
  "34": ["哎哟，出错了……", "这里红了，我凑近看看", "碰到坎了，我绕一下", "唔，坏消息，但还没完蛋"],
  "40": ["在翻资料，别急", "一页一页找呢，别催", "我把文档捞出来看看", "资料堆里翻半天了"],
  "*": ["我在呢", "嗯……我在看着", "别管我，你忙你的", "有需要就喊我一声"]
};

/* 本地台词的节流：同一句不要连着说两次 */
var speechLastLine = "";
var speechLastAt = 0;
var speechLastMood = "";
/* 同一心情连续说了几次：告诉模型「第 N 次说这类话，换个角度」 */
var speechStreak = 0;
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
function showSpeech(text, source, mood, moodName) {
  if (!text) return;
  speechStreak = mood && mood === speechLastMood ? speechStreak + 1 : 1;
  speechLastLine = text;
  speechLastMood = mood || "";
  speechLastAt = Date.now();
  speechHistory.push(text);
  if (speechHistory.length > SAY_HISTORY) speechHistory.shift();
  /* mood / moodName 一并记下来：气泡按情绪换样式，测试与排查也要看这个 */
  uiStore.set({
    say: { text: text, at: Date.now(), source: source || "local", mood: mood || "", moodName: moodName || "" }
  });
}

function recentSpeech() {
  return speechHistory.join(" / ");
}

/** 说话节流状态的读写（读用于测试断言，写用于冒烟测试跳过 20 秒等待）。 */
function speechState() {
  return { lastAt: speechLastAt, lastLine: speechLastLine, lastMood: speechLastMood, streak: speechStreak };
}

/** 供冒烟测试检查「像人」的两道闸门。 */
function speechQuality(text) {
  return { repeats: repeatsRecent(text), template: looksTemplate(text), lively: livelyEnough(text), ok: acceptableLine(text) };
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
    showSpeech(localLine(options.mood), "local", options.mood, options.moodName);
    return Promise.resolve(null);
  }

  var local = localLine(options.mood);
  var payload = {
    mood: options.mood || "",
    moodName: options.moodName || "",
    reason: options.reason || "",
    user: options.user || "",
    assistant: options.assistant || "",
    recent: recentSpeech(),
    /* 让模型知道这是第几次说同类的话，好换个说法（>1 时宿主会加一句约束） */
    streak: options.mood && options.mood === speechLastMood ? speechStreak + 1 : 1
  };
  uiStore.set({ sayBusy: true });
  return hostCall("float-ball/say", payload, 26000).then(function (value) {
    uiStore.set({ sayBusy: false });
    var text = value && value.text;
    /* 模型说了句重复的 / 客服腔的，就再要一次（宿主的 retry 参数会加强约束） */
    if (text && !acceptableLine(text)) {
      return hostCall("float-ball/say", Object.assign({}, payload, { retry: true, avoid: text }), 26000).then(function (second) {
        var better = second && second.text;
        if (better && acceptableLine(better)) {
          showSpeech(better, "model", options.mood, options.moodName);
          return better;
        }
        /* 两次都不行：挑一句不重复的本地台词，保证不出戏 */
        showSpeech(localLine(options.mood), "local-fallback", options.mood, options.moodName);
        return null;
      }, function () {
        showSpeech(localLine(options.mood), "local-fallback", options.mood, options.moodName);
        return null;
      });
    }
    if (text) {
      showSpeech(text, "model", options.mood, options.moodName);
      return text;
    }
    /* 失败：用本地台词兜底，保证气泡不是空的 */
    showSpeech(local, "local-fallback", options.mood, options.moodName);
    return null;
  }, function () {
    uiStore.set({ sayBusy: false });
    showSpeech(local, "local-fallback", options.mood, options.moodName);
    return null;
  });
}
