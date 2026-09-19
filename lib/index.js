import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * dsh-client-ui-float-ball — host half（宿主半）。
 *
 * 浏览器半把悬浮球的配置写到 $DSH_HOME/float-ball.json（用户级），
 * 宿主半只提供一个通用的 Connection RPC 通道：
 *
 *   POST /float-ball-rpc/float-ball/config
 *     payload: {}                     -> { ok: true, value: { config } }
 *     payload: { config: {...} }      -> 规范化后写入文件，回 { ok: true, value: { config } }
 *   POST /float-ball-rpc/float-ball/reset
 *     payload: {}                     -> 删除配置文件，回 { ok: true, value: { config: null } }
 *   POST /float-ball-rpc/float-ball/say
 *     payload: { mood, moodName, reason?, user?, assistant?, recent? }
 *       -> 让模型说一句符合当前心情的短句，回 { ok: true, value: { text } }
 *   POST /float-ball-rpc/float-ball/mood
 *     payload: { user, assistant, emotions:[{id,name}], provider?, model? }
 *       -> 用已配置的模型挑一个表情，回 { ok: true, value: { id, reason } }
 *     （模型路由留空时取 agentDefaultModel；用 ctx.get 动态取服务，缺失即返回不可用）
 *
 * 设计取舍：
 *   - 使用独立通道 `/float-ball-rpc`，不与其他插件抢占共享的 `/rpc` 通道；
 *   - 零运行时依赖，只 import node 内建模块，因此从任意挂载位置都能加载；
 *   - 宿主不可用（通道未挂载 / 请求失败）时浏览器半自动回退 localStorage，
 *     所以这里的所有失败都对用户体验无损。
 */
export const name = 'dsh-client-ui-float-ball';

/** 只需要 connection：通道注册会借用它内部的 webServer。 */
export const inject = ['connection'];

/* ============================ AI 心情（大脑） ============================
 * 客户端在每轮对话结束时把「用户最后一句 + 助手最后一段」发过来，这里
 * 用 dsh 已经配置好的模型做一次极短的分类调用，返回一个表情 ID。
 *
 * 模型路由的解析顺序：
 *   1. 客户端显式指定的 provider/model（面板里可填）；
 *   2. 动态取 agentDefaultModel.currentSelection()（用户在 dsh 里配的默认模型）。
 * 两者都拿不到就返回 unavailable —— 功能静默关闭，绝不报错刷屏。
 *
 * 这里用 ctx.get('llm') / ctx.get('agentDefaultModel') 动态取服务而不是写进
 * inject：这样即使某个 profile 没有装 LLM，插件其余功能（悬浮球本体）照常加载。
 */
const MOOD_TIMEOUT_MS = 25000;
const SAY_TIMEOUT_MS = 25000;
const SAY_MAX_OUTPUT_TOKENS = 320;
const SAY_MAX_CHARS = 40;
const MOOD_MAX_INPUT_CHARS = 1200;
const MOOD_MAX_OUTPUT_TOKENS = 256;

const MOOD_SYSTEM_PROMPT = [
  '你是一个桌面宠物表情球的情绪中枢。读用户和助手刚刚的这段对话，替表情球选一个此刻最合适的表情。',
  '',
  '判断依据（按优先级）：',
  '1. 用户当下对 AI 的态度：夸奖→开心/害羞/满意；辱骂或嫌弃（例如“你怎么这么蠢”）→害怕/失落/委屈；',
  '   催促或急躁→慌张；感谢或兴奋→开心/惊讶；平静交谈→好奇/专注；',
  '2. 对话的情绪温度：顺利解决→任务完成(satisfied)；出错或卡住→出错/无奈；正在等用户决定→等待输入。',
  '3. 用户开心时表情球要跟着开心；用户不满时表情球要显得不安、低落，不要傻乐。',
  '',
  '不要展开分析，直接给结论；只输出两行，不要解释、不要代码块：',
  '第一行：ID <两位表情编号>',
  '第二行：WHY <不超过15个字的中文理由>'
].join('\n');

const SAY_SYSTEM_PROMPT = [
  '你是一只趴在用户屏幕角落的桌面宠物球，正在用一句话说出你此刻的心情。',
  '',
  '硬性要求：',
  '1. 只输出那句话本身，不要引号、不要解释、不要表情符号、不要 markdown；',
  '2. 中文口语短句，8-24 个字，最多一行；可以用「……」或「～」表示语气；',
  '3. 用第一人称，可以偶尔提到眼前的事（那个 bug、翻日志、总算跑通了）；',
  '4. 语气必须和给定的心情一致：开心就欢快，失落就小声委屈，慌张就别慌，专注就安静；',
  '5. 如果心情是负面的（被骂蠢、出错、失落），要表现出难过但不顶嘴，用悄悄话的口吻；',
  '6. 不要每次都提「用户」，也不要复述原话。'
].join('\n');

/** 像「在解释任务 / 复述设定」的句子不能当台词（推理型模型偶尔会把心声留在这里）。 */
function looksLikeMeta(line) {
  return /桌面宠物|扮演|用户要|心情是|强度|数值|进度|意思是|我应该|我需要|让我(?:想|分析)|任务是|注意|要求\d|输出一?句/.test(line);
}

/** 去掉开头的引号与「一句话：」这类前缀。 */
function stripSayWrapper(line) {
  return line
    .replace(/^\s*(?:["'“”‘’「」『』]|一句话[:：]|台词[:：])/, '')
    .replace(/["'“”‘’「」『』]\s*$/, '')
    .trim();
}

/** 取模型的回复：优先取「像台词」的一行，其次第一行；去掉引号并限长。 */
function tidySay(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return '';
  const spoken = lines.find((l) => !looksLikeMeta(l) && l.length <= SAY_MAX_CHARS * 2);
  let line = stripSayWrapper(spoken !== undefined ? spoken : lines[lines.length - 1]);
  if (!line || looksLikeMeta(line)) return '';
  if (line.length > SAY_MAX_CHARS) line = line.slice(0, SAY_MAX_CHARS);
  return line;
}

const SAY_RETRY_NOTE = '（注意：不要输出任何思考或解释，直接给出那一句话本身。）';

/** 组装一次“说句话”的请求。 */
function buildSayOptions(provider, model, payload, retry) {
  const moodName = tidy(payload.moodName, 24) || '待机';
  const moodId = typeof payload.mood === 'string' && EMOTION_ID.test(payload.mood) ? payload.mood : '';
  const lines = [];
  lines.push(`我现在的心情：${moodName}${moodId ? '（' + moodId + '）' : ''}`);
  if (payload.reason) lines.push(`原因是：${tidy(payload.reason, 40)}`);
  if (payload.user) lines.push('', '用户最后一句：', tidy(payload.user, 300));
  if (payload.assistant) lines.push('', '我刚才回应了：', tidy(payload.assistant, 300));
  if (payload.recent) lines.push('', '我最近说过：' + tidy(payload.recent, 160) + '（换个说法，别重复）');
  lines.push('', retry
    ? `现在直接说那一句话${SAY_RETRY_NOTE}`
    : '现在说一句符合心情的话。');

  return {
    provider,
    model,
    messages: [
      {
        id: `float-ball-say-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text: lines.join('\n').slice(0, 1400) }],
        source: { kind: 'plugin', plugin: 'dsh-client-ui-float-ball' }
      }
    ],
    system: SAY_SYSTEM_PROMPT + (retry ? '\n\n这次务必只输出台词本身，不要有任何解释、设定复述或思考。' : ''),
    maxTokens: SAY_MAX_OUTPUT_TOKENS,
    temperature: retry ? 0.7 : 0.9
  };
}

/** 处理 float-ball/say：一次极短的“说句话”调用。 */
async function handleSay(ctx, payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const llm = ctx.get && ctx.get('llm');
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: { code: 'internal', message: 'llm 服务不可用', details: {} } };
  }
  const route = resolveRoute(ctx, body);
  if (!route) {
    return { ok: false, error: { code: 'internal', message: '没有可用的模型', details: {} } };
  }
  async function ask(retry) {
    const options = buildSayOptions(route.provider, route.model, body, retry);
    return await assembleText(llm.stream({ ...options, signal: AbortSignal.timeout(SAY_TIMEOUT_MS) }));
  }

  let reply;
  try {
    reply = await ask(false);
    /* 正文为空（推理型模型把预算花在思考上）或拿到的是“自言自语”，就再要一次 */
    if (!tidySay(reply.text)) {
      if (!reply.text) {
        try {
          const second = await ask(true);
          if (tidySay(second.text)) reply = second;
          else if (!reply.combined) reply = second;
        } catch { /* 第二次也失败就用第一次的结果兜底 */ }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: 'internal', message: `模型调用失败：${message}`, details: {} } };
  }

  const text = tidySay(reply.text) || tidySay(reply.combined);
  if (!text) {
    return { ok: false, error: { code: 'internal', message: '模型没有说出内容', details: {} } };
  }
  return { ok: true, value: { text, provider: route.provider, model: route.model } };
}

/** 从模型输出里抓表情 ID，并要求它在白名单里。 */
function parseMood(text, allowed) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const byLine = /^\s*ID\s*[:：]?\s*(\d{2})\b/im.exec(text);
  let id = byLine ? byLine[1] : null;
  if (id === null) {
    const any = /\b(\d{2})\b/.exec(text);
    id = any ? any[1] : null;
  }
  if (id === null || !allowed.has(id)) return null;
  const why = /^\s*WHY\s*[:：]?\s*(.+)$/im.exec(text);
  const reason = why ? why[1].trim().slice(0, 40) : '';
  return { id, reason };
}

/** 精简文本：合并空白并截断，避免把整段对话塞进 prompt。 */
function tidy(text, max) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 组装一次情绪分类调用（与 dsh-client-ui-games 的做法一致，独立通道不抢 /rpc）。 */
function buildMoodOptions(provider, model, payload, emotionText) {
  const parts = [];
  if (payload.user) parts.push('用户最后一句：', tidy(payload.user, 600), '');
  if (payload.assistant) parts.push('助手最后的回复：', tidy(payload.assistant, 600), '');
  parts.push('可选表情（编号 名称）：', emotionText);
  parts.push('', '请只输出 ID 与 WHY 两行。');
  return {
    provider,
    model,
    messages: [
      {
        id: `float-ball-mood-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text: parts.join('\n').slice(0, MOOD_MAX_INPUT_CHARS + 800) }],
        source: { kind: 'plugin', plugin: 'dsh-client-ui-float-ball' }
      }
    ],
    system: MOOD_SYSTEM_PROMPT,
    maxTokens: MOOD_MAX_OUTPUT_TOKENS,
    temperature: 0.3
  };
}

/**
 * 把流式回复拼成纯文本（不依赖 dsh-llm 的类型，只看 chunk 形状）。
 * 同时收集 reasoning-delta：推理型模型（如 deepseek-v4-flash）会先把思考写进
 * reasoning 通道，若正文本轮没产出，就用推理文本兜底解析，避免“空回复”误判。
 */
async function assembleText(stream) {
  let text = '';
  let reasoning = '';
  for await (const chunk of stream) {
    if (!chunk) continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
    } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoning += chunk.text;
    } else if (chunk.type === 'finish') {
      const kind = chunk.reason && chunk.reason.kind;
      if (kind === 'error' || kind === 'aborted') {
        const failure = chunk.reason && chunk.reason.failure;
        throw new Error(failure && failure.message ? `${kind}: ${failure.message}` : `llm stream ${kind}`);
      }
    }
  }
  return { text, reasoning, combined: text || reasoning, reasonSource: text ? 'text' : 'reasoning' };
}

/** 解析这次调用该用哪个模型；拿不到就返回 null（功能关闭）。 */
function resolveRoute(ctx, payload) {
  const explicitProvider = typeof payload.provider === 'string' ? payload.provider.trim() : '';
  const explicitModel = typeof payload.model === 'string' ? payload.model.trim() : '';
  if (explicitProvider && explicitModel) return { provider: explicitProvider, model: explicitModel };
  try {
    const selector = ctx.get && ctx.get('agentDefaultModel');
    if (selector && typeof selector.currentSelection === 'function') {
      const selection = selector.currentSelection();
      if (selection && selection.provider && selection.model) {
        return { provider: selection.provider, model: selection.model };
      }
    }
  } catch { /* 未安装默认模型服务：视为未配置 */ }
  return null;
}

/** 处理 float-ball/mood：一次极短的分类调用。 */
async function handleMood(ctx, payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const llm = ctx.get && ctx.get('llm');
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: { code: 'internal', message: 'llm 服务不可用', details: {} } };
  }
  const route = resolveRoute(ctx, body);
  if (!route) {
    return { ok: false, error: { code: 'internal', message: '没有可用的模型：请先在 dsh 里配置默认模型，或在面板里填 provider/model', details: {} } };
  }

  const list = Array.isArray(body.emotions) ? body.emotions : [];
  const allowed = new Set();
  const names = [];
  for (const item of list) {
    if (!item || typeof item.id !== 'string' || !EMOTION_ID.test(item.id)) continue;
    if (allowed.has(item.id)) continue;
    allowed.add(item.id);
    names.push(`${item.id} ${typeof item.name === 'string' ? item.name.slice(0, 12) : ''}`.trim());
  }
  if (allowed.size === 0) {
    return { ok: false, error: { code: 'internal', message: '缺少表情清单', details: {} } };
  }
  if (!body.user && !body.assistant) {
    return { ok: false, error: { code: 'internal', message: '没有对话内容', details: {} } };
  }

  const options = buildMoodOptions(route.provider, route.model, body, names.join(' · '));
  const signal = AbortSignal.timeout(MOOD_TIMEOUT_MS);
  let reply;
  try {
    reply = await assembleText(llm.stream({ ...options, signal }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: 'internal', message: `模型调用失败：${message}`, details: {} } };
  }

  const parsed = parseMood(reply.text, allowed) || parseMood(reply.combined, allowed);
  const mood = parsed;
  if (!mood) {
    return {
      ok: false,
      error: {
        code: 'internal',
        message: '模型没有返回合法表情 ID',
        details: {
          raw: String(reply.combined).slice(0, 120),
          reasoningOnly: reply.text === '' && reply.reasoning !== ''
        }
      }
    };
  }
  return { ok: true, value: { id: mood.id, reason: mood.reason, provider: route.provider, model: route.model } };
}

/** 配置落盘位置：$DSH_HOME 优先，否则退回 ~/.dsh。 */
function configPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, 'float-ball.json');
}

const CONFIG_VERSION = 1;
const EMOTION_ID = /^\d{2}$/;
const SIZE_MIN = 48;
const SIZE_MAX = 160;
const SIZE_DEFAULT = 84;
const THEMES = new Set(['ink', 'cream']);

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 规范化客户端提交的配置：只接受已知键，越界/类型不符一律回退默认。
 * 客户端提交的是不可信输入，这里做一次服务端侧的兜底校验。
 */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const size = typeof src.size === 'number' && Number.isFinite(src.size)
    ? Math.round(clamp(src.size, SIZE_MIN, SIZE_MAX))
    : SIZE_DEFAULT;
  /* 字段必须与客户端 DEFAULT_CFG 一一对应：这里漏掉哪个，客户端写进来的设置
   * 就会在下次读取时被无声丢掉（曾漏过 auto/anim/brain 那一批）。 */
  return {
    emotion: typeof src.emotion === 'string' && EMOTION_ID.test(src.emotion) ? src.emotion : '02',
    size,
    theme: THEMES.has(src.theme) ? src.theme : 'ink',
    gaze: src.gaze !== false,
    idle: src.idle !== false,
    auto: src.auto !== false,
    anim: src.anim !== false,
    bubble: src.bubble !== false,
    brain: src.brain !== false,
    brainOn: src.brainOn === 'message' ? 'message' : 'task',
    brainProvider: typeof src.brainProvider === 'string' ? src.brainProvider : '',
    brainModel: typeof src.brainModel === 'string' ? src.brainModel : '',
    seenHint: src.seenHint === true
  };
}

/** 读取配置文件；不存在或损坏都返回 null（由客户端回退到默认配置）。 */
async function readConfig() {
  try {
    const text = await readFile(configPath(), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.config) {
      return normalize(parsed.config);
    }
    if (parsed && typeof parsed === 'object') return normalize(parsed);
    return null;
  } catch {
    return null;
  }
}

/** 原子写：先写临时文件再 rename，避免半截文件。 */
async function writeConfig(config) {
  const file = configPath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = {
    version: CONFIG_VERSION,
    updatedAt: new Date().toISOString(),
    config
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  return config;
}

async function removeConfig() {
  try {
    await unlink(configPath());
  } catch {
    /* 文件不存在时同样视为成功 */
  }
}

/** 一次请求的分发：endpoint 已由 Connection 校验过路径合法性。 */
async function handleRequest(ctx, endpoint, payload) {
  if (endpoint === 'float-ball/config') {
    const body = payload && typeof payload === 'object' ? payload : {};
    if (body.config === undefined || body.config === null) {
      const stored = await readConfig();
      return { ok: true, value: { config: stored, path: configPath() } };
    }
    const stored = await writeConfig(normalize(body.config));
    return { ok: true, value: { config: stored, path: configPath() } };
  }

  if (endpoint === 'float-ball/reset') {
    await removeConfig();
    return { ok: true, value: { config: null } };
  }

  if (endpoint === 'float-ball/mood') {
    return await handleMood(ctx, payload);
  }

  if (endpoint === 'float-ball/say') {
    return await handleSay(ctx, payload);
  }

  if (endpoint === 'float-ball/health') {
    return { ok: true, value: { plugin: name, ok: true, path: configPath() } };
  }

  return {
    ok: false,
    error: { code: 'internal', message: `unknown endpoint: ${String(endpoint)}`, details: {} }
  };
}

/** 插件主体：注册通道；effect 负责在插件卸载时注销路由。 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.connection.rpc.handle('/float-ball-rpc', (endpoint, payload) => handleRequest(ctx, endpoint, payload)),
    'dsh-client-ui-float-ball: /float-ball-rpc channel'
  );
}
