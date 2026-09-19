/* ============================================================================
 * 24-life.js — 拟人化层：让球「活」起来的节奏、动作与视线。
 *
 * 三件事：
 *   1. 心跳：节拍不固定——偶尔来个连拍（像深呼吸两下），偶尔停久一点发呆；
 *   2. 动作：自旋 / 弹跳 / 撒花 / 甩头 / 眨眼，参数每次都不一样（可重可轻）；
 *   3. 视线：用户敲字时扭头看向输入框，敲完看回来；没人理时自己瞟一眼。
 * 所有动作都走引擎公开 API（setEmotion/spin/burst/bounce/setGaze），
 * 不碰引擎内部状态。
 * ========================================================================== */

/* 工作状态表情：跑任务时来回换（和 20-ball 的 TASK_WORK_EMOTIONS 一致） */
var LIFE_WORK_EMOTIONS = ["32", "40", "31", "37"];
var LIFE_FLASH_EMOTIONS = ["13", "16", "14"];
var LIFE_EAGER_EMOTIONS = ["07", "19", "33"];

/* 节拍：轻/重两档 + 偶发连拍，避免机械的等间隔 */
var BEAT_LIGHT_MS = 3200;
var BEAT_HEAVY_MS = 9500;
var BEAT_IDLE_MS = 15000;

/* 用户敲字 → 球的视线先转过去看一眼 */
var COMPOSER_BLOCK_SELECTOR = [
  "textarea",
  "[contenteditable='true']",
  "[role='textbox']",
  ".cm-content",
  ".ProseMirror"
].join(",");

var composerCache = { el: null, at: 0 };

/** 找「用户正在打字的那个框」：优先取当前聚焦的可编辑元素，退而求其次取最大的编辑区。 */
function findComposer() {
  if (typeof document === "undefined") return null;
  var now = Date.now();
  var active = document.activeElement;
  if (active && active.closest && active.closest(COMPOSER_BLOCK_SELECTOR)) return active;
  if (composerCache.el && now - composerCache.at < 5000 && composerCache.el.isConnected) {
    return composerCache.el;
  }
  var nodes = document.querySelectorAll(COMPOSER_BLOCK_SELECTOR);
  var best = null;
  var bestArea = 0;
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var rect = node.getBoundingClientRect();
    var area = rect.width * rect.height;
    if (area > bestArea) { bestArea = area; best = node; }
  }
  composerCache = { el: best, at: now };
  return best;
}

function rectOf(target) {
  if (!target) return null;
  if (target.current) target = target.current;          /* React ref */
  if (!target.getBoundingClientRect) return null;
  var rect = target.getBoundingClientRect();
  if (!rect || !rect.width || !rect.height) return null;
  return rect;
}

/* ============================== 视线 ============================== */

/**
 * 把视线对准某个矩形（引擎的 setGaze 取值范围 -1..1，2 - 3 对应 45° 左右的偏移）。
 * 返回是否成功设置。
 */
/** 由「球」和「目标」两个矩形算出注视方向（-1..1）。纯函数，便于单测。 */
function gazeVector(self, rect) {
  if (!self || !rect) return null;
  var nx = (rect.left + rect.width / 2 - (self.left + self.width / 2)) / ((self.width || 1) * 1.4);
  /* 垂直方向只往下看：输入框几乎总在球下方或同一水平线，对称缩放会算出负值
   * 把眼睛往上抬，看起来像在看天花板。 */
  var ny = (rect.top + rect.height / 2 - (self.top + self.height / 2)) / ((self.height || 1) * 1.4);
  return { x: clampNum(nx, -1, 1), y: clampNum(Math.max(0, ny), 0, 1) };
}

function gazeAt(fromRef, target) {
  var host = fromRef && fromRef.current;
  var ball = host && host.__dfbEngine;
  if (!ball || !ball.setGaze) return false;
  var vec = gazeVector(rectOf(host), rectOf(target));
  if (!vec) return false;
  ball.setGaze(vec.x, vec.y);
  return true;
}

/**
 * 敲字时看输入框：先扭头看一眼（像个被打断又注意到你的小宠物），
 * 敲完 / 停手后看回鼠标（清掉注视，交还给鼠标跟随）。
 */
function createComposerWatcher(hostRef) {
  var peekTimer = 0;
  var returnTimer = 0;
  var bound = null;

  function onInput(e) {
    var target = e && e.target;
    if (!target || !target.closest || !target.closest(COMPOSER_BLOCK_SELECTOR)) return;
    if (!peekTimer) {
      /* 只在该轮敲字开始时看一眼，不是每敲一个字都动 */
      if (gazeAt(hostRef, target)) {
        peekTimer = setTimeout(function () {
          peekTimer = 0;
          var host = hostRef.current;
          var ball = host && host.__dfbEngine;
          if (ball && ball.clearGaze) ball.clearGaze();
        }, 1100);
      }
    }
    if (returnTimer) clearTimeout(returnTimer);
    returnTimer = setTimeout(function () {
      returnTimer = 0;
      var host = hostRef.current;
      var ball = host && host.__dfbEngine;
      if (ball && ball.clearGaze) ball.clearGaze();
    }, 2500);
  }

  return {
    start: function () {
      document.addEventListener("input", onInput, true);
      bound = document.activeElement;
      return function () {
        document.removeEventListener("input", onInput, true);
        if (peekTimer) clearTimeout(peekTimer);
        if (returnTimer) clearTimeout(returnTimer);
        peekTimer = 0;
        returnTimer = 0;
        bound = null;
      };
    }
  };
}

/* ============================== 心跳与动作 ============================== */

/** 跑任务时的动作权重：工作换表情最勤，其他动作按“轻/重”混着来。 */
var WORK_ACTIONS = ["work", "work", "work", "gaze", "flash", "bounce", "spin", "shy", "burst", "eager"];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomBetween(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

/**
 * 跑任务期间的「生命循环」：不规则心跳 + 参数随机的动作。
 * 返回 { tick, stop }；tick 供构建机测试直接驱动。
 */
function startLifeLoop(hostRef, isRunning) {
  var timer = 0;
  var flashTimer = 0;
  var stopped = false;
  var beats = 0;

  function engine() {
    var el = hostRef && hostRef.current;
    var ball = el && el.__dfbEngine;
    return ball && ball.setEmotion ? ball : null;
  }

  function alive() {
    return !stopped && isRunning() && currentCfg().anim !== false;
  }

  /** 下一次心跳间隔：多数轻拍，偶尔长停顿，偶尔连拍。 */
  function nextBeat() {
    beats++;
    if (beats % 7 === 0) return BEAT_IDLE_MS + randomBetween(0, 6000);
    if (Math.random() < 0.22) return randomBetween(1800, 3200);   /* 连拍 */
    return randomBetween(BEAT_LIGHT_MS, BEAT_HEAVY_MS);
  }

  function setMood(id) {
    uiStore.set({ taskMood: id });
    var ball = engine();
    if (ball) {
      ball.setEmotion(id);
      if (ball.resetIdle) ball.resetIdle();
    }
  }

  function act(action) {
    var ball = engine();
    if (!ball) return;
    if (action === "work") {
      var work = pick(LIFE_WORK_EMOTIONS);
      if (work !== uiStore.get().taskMood) setMood(work);
    } else if (action === "flash") {
      /* 闪一下情绪再回来：节奏 1.6-2.6 秒，长短随机 */
      setMood(pick(LIFE_FLASH_EMOTIONS));
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(function () {
        flashTimer = 0;
        if (!alive()) return;
        setMood(pick(LIFE_WORK_EMOTIONS));
      }, randomBetween(1600, 2600));
    } else if (action === "eager") {
      /* 兴致上来：连换两次，像“我来我来” */
      setMood(pick(LIFE_EAGER_EMOTIONS));
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(function () {
        flashTimer = 0;
        if (!alive()) return;
        setMood(pick(LIFE_WORK_EMOTIONS));
      }, randomBetween(900, 1500));
    } else if (action === "shy") {
      setMood("14");
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(function () {
        flashTimer = 0;
        if (!alive()) return;
        setMood(pick(LIFE_WORK_EMOTIONS));
      }, randomBetween(1200, 2000));
    } else if (action === "bounce") {
      /* 轻弹 / 重弹：连续弹两下也有 */
      if (ball.bounce) {
        ball.bounce();
        if (Math.random() < 0.35) setTimeout(function () { if (alive() && ball.bounce) ball.bounce(); }, randomBetween(260, 420));
      }
    } else if (action === "spin") {
      if (ball.spin) ball.spin(Math.random() < 0.25 ? 2 : 1);
    } else if (action === "burst") {
      if (ball.burst) ball.burst(Math.random() < 0.3 ? 16 : 8);
    } else if (action === "gaze") {
      /* 自己瞟一眼别处：输入框 → 右边 → 回正 */
      var composer = findComposer();
      var ok = composer ? gazeAt(hostRef, composer) : false;
      if (!ok) {
        var ball2 = engine();
        if (ball2 && ball2.setGaze) ball2.setGaze(randomBetween(-0.8, 0.8), randomBetween(-0.5, 0.2));
      }
      setTimeout(function () {
        if (!alive()) return;
        var b = engine();
        if (b && b.clearGaze) b.clearGaze();
      }, randomBetween(700, 1400));
    }
  }

  function tick() {
    timer = 0;
    if (!alive()) { schedule(); return; }
    act(pick(WORK_ACTIONS));
    var ball = engine();
    if (ball && ball.resetIdle) ball.resetIdle();
    schedule();
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(tick, nextBeat());
  }

  schedule();

  var stop = function () {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = 0; }
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = 0; }
  };
  stop.tick = tick;
  return stop;
}

/**
 * 任务刚结束的「松一口气」：给一个情绪化的收尾表情，再交回给大脑/待机。
 * 只是短暂一帧过渡，不改用户配置。
 */
function easeOut(hostRef, emotionId) {
  var el = hostRef && hostRef.current;
  var ball = el && el.__dfbEngine;
  if (!ball || !ball.setEmotion) return;
  ball.setEmotion(emotionId);
  if (ball.bounce) ball.bounce();
}
