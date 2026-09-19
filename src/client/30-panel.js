/* ============================================================================
 * 30-panel.js — 配置面板：表情切换 / 尺寸 / 主题 / 注视 / 空闲休眠 / 复位。
 *
 * 面板是一个普通 React 组件，由 90-main.js 通过 Portal 渲染到 body 上；
 * 本文件只维护“面板开合 + 内容”这一份共享状态，以及面板相对锚点的摆放。
 * ========================================================================== */

/**
 * 面板状态槽（被悬浮球右键、侧边栏入口、Portal 三方读写）：
 * content 非空 => 面板已打开，Portal 渲染它；close() 置空即关闭。
 */
var panelState = {
  content: null,
  open: function (anchorEl, viaButton) {
    panelState.content = function () {
      return jsx(PanelContent, {
        onClose: panelState.close,
        anchorRef: { current: anchorEl },
        viaButton: viaButton
      });
    };
    uiStore.set({ open: true });
  },
  close: function () {
    panelState.content = null;
    uiStore.set({ open: false });
  }
};

/** 打开 / 收起面板：anchorEl 为球元素或侧边栏入口按钮。 */
function openPanel(anchorEl) {
  if (typeof document === "undefined") return;
  if (panelState.content) { panelState.close(); return; }
  var viaButton = !!(anchorEl && anchorEl.classList && anchorEl.classList.contains("dfb-entry"));
  panelState.open(anchorEl, viaButton);
}

function panelPatch(patch) {
  applyCfg(Object.assign({}, currentCfg(), patch));
}

/** 贴边落位：手机上拖动不精确，给一排大按钮直接放到指定角落。 */
function panelPlace(spot) {
  if (FloatBallActions.placeAt) FloatBallActions.placeAt(spot);
  else applyCfg(Object.assign({}, currentCfg(), { spot: spot }));
}

function panelSelect(id) {
  if (FloatBallActions.selectEmotion) FloatBallActions.selectEmotion(id);
  else panelPatch({ emotion: id, seenHint: true });
}

/* ============================== 面板组件 ============================== */

function PanelContent(props) {
  var ui = useUi();
  var cfg = ui.cfg;
  var liveId = ui.live || cfg.emotion;
  /* 引擎句柄只在运行时读取：模块求值顺序不保证 Util.Engine 已接线 */
  var engine = ballEngine();
  var list = emotionList(engine);
  var groups = groupEmotions(engine, list);
  var live = findEmotion(list, liveId);
  var ref = react.useRef(null);
  var [placement, setPlacement] = react.useState(null);

  /* ---- 摆放：贴在锚点（球 / 入口按钮）旁边，且不超出视口 ---- */
  var PANEL_W = 290;
  var PANEL_H = 430;

  function measure() {
    var el = ref.current;
    var anchor = props.anchorRef && props.anchorRef.current;
    var vp = viewport();
    var pad = 8;
    var gap = 12;
    /* 主题或字体可能改变面板尺寸；量不到时用保守默认值，绝不把面板藏起来 */
    var pw = (el && el.offsetWidth) || PANEL_W;
    var ph = (el && el.offsetHeight) || PANEL_H;
    var rect = anchor && anchor.getBoundingClientRect
      ? anchor.getBoundingClientRect()
      : { right: vp.w - 40, left: vp.w - 124, top: vp.h - 150, width: 84, height: 84 };

    /* 默认放在锚点右侧，放不下就翻到左侧 */
    var left = rect.right + gap;
    if (left + pw > vp.w - pad) left = rect.left - pw - gap;
    left = clampNum(left, pad, Math.max(pad, vp.w - pw - pad));

    /* 垂直方向与锚点中心对齐，同样夹在视口内 */
    var top = clampNum(rect.top + rect.height / 2 - ph / 2, pad, Math.max(pad, vp.h - ph - pad));
    setPlacement(function (prev) {
      var next = { left: Math.round(left), top: Math.round(top) };
      if (prev && prev.left === next.left && prev.top === next.top) return prev;
      return next;
    });
  }

  /* 用布局阶段测量，避免首帧出现在默认位置再跳一次 */
  var useIsoLayout = react.useLayoutEffect || react.useEffect;
  useIsoLayout(function () {
    measure();
    window.addEventListener("resize", measure);
    return function () { window.removeEventListener("resize", measure); };
  }, []);

  /* ---- 点击外部 / Esc 关闭 ---- */
  react.useEffect(function () {
    function onDown(e) {
      var el = ref.current;
      if (!el || el.contains(e.target)) return;
      var anchor = props.anchorRef && props.anchorRef.current;
      if (anchor && anchor.contains && anchor.contains(e.target)) return;
      props.onClose();
    }
    function onKey(e) {
      if (e.key === "Escape") props.onClose();
    }
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return function () {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  /* ---- 表情分组 ----
   * body 是静态子元素数组，React 要求每个元素带 key，所以这里返回
   * “不带 key 的元素”，由调用处用 jsx(node, undefined, key) 挂上 key。 */

  /** 一组表情 chip（数组元素自带 key）。 */
  function emotionChips(items) {
    return items.map(function (item) {
      return jsx(
        "button",
        {
          type: "button",
          className: "dfb-chip",
          "data-on": item.id === liveId ? "1" : undefined,
          title: item.id + " " + item.name,
          onClick: function () { panelSelect(item.id); },
          children: item.name
        },
        "fb-emo-" + item.id
      );
    });
  }

  /**
   * 一个分组容器：标题 + 内容。
   * 刻意不以数组方式渲染（静态子元素不需要 key）：把 key 放 props 会触发
   * React 的 “key being spread” 警告，而 props 传 null 又会让 key 校验抛异常。
   */
  function groupBlock(title, children) {
    return jsxs("div", {
      className: "dfb-group",
      children: [
        jsx("div", { className: "dfb-group-t", children: title }),
        jsx("div", { className: "dfb-grid", children: children })
      ]
    });
  }

  /** 表情 ID -> 中文名（面板里展示 AI 读出的心情）。 */
  function moodLabel(id) {
    var found = findEmotion(list, id);
    return found ? found.name + " · " + id : String(id);
  }

  function toggleRow(label, options, title) {
    return jsxs("div", {
      className: "dfb-row",
      title: title,
      children: [
        jsx("label", { children: label }),
        jsx("div", {
          className: "dfb-grid",
          children: options.map(function (opt) {
            return jsx(
              "button",
              {
                type: "button",
                className: "dfb-chip",
                "data-on": opt.on ? "1" : undefined,
                title: opt.title,
                onClick: opt.act,
                children: opt.label
              },
              opt.label
            );
          })
        })
      ]
    });
  }

  /* 表情分组：按分组逐条列出，作为 .dfb-body 的静态子元素
   * （数组子元素要求 key，而 React 运行时 jsx() 处理 key 的两种写法都会
   *  报警或抛错，所以这里直接不用数组）。 */
  function groupAt(index) {
    var g = groups[index];
    if (!g) return null;
    return groupBlock(g.name + "（" + g.items.length + "）", emotionChips(g.items));
  }

  /* 首次渲染即完整渲染（静态子元素，不需要 key），避免 [:N] 截断造成遗漏 */
  var bodyNode = jsxs("div", {
    className: "dfb-body",
    children: [
    groupAt(0),
    groupAt(1),
    groupAt(2),
    groupAt(3),
    jsxs("div", {
      className: "dfb-group",
      children: [
        jsx("div", { className: "dfb-group-t", children: "外观" }),
        jsxs("div", {
          className: "dfb-row",
          children: [
            jsx("label", { htmlFor: "dfb-size", children: "尺寸" }),
            jsx("input", {
              id: "dfb-size",
              className: "dfb-range",
              type: "range",
              min: SIZE_MIN,
              max: SIZE_MAX,
              step: 2,
              value: cfg.size,
              onChange: function (e) {
                var v = parseInt(e.target.value, 10);
                if (isFinite(v)) panelPatch({ size: normSize(v) });
              }
            }),
            jsx("span", { className: "dfb-num", children: cfg.size + "px" })
          ]
        }),
        toggleRow("主题", [
          { label: "黑球白瞳", on: cfg.theme === "ink", act: function () { panelPatch({ theme: "ink" }); } },
          { label: "白球黑瞳", on: cfg.theme === "cream", act: function () { panelPatch({ theme: "cream" }); } }
        ])
      ]
    }),
    jsxs("div", {
      className: "dfb-group",
      children: [
        jsx("div", { className: "dfb-group-t", children: "行为" }),
        toggleRow("注视", [
          { label: "跟随鼠标", on: cfg.gaze, act: function () { panelPatch({ gaze: true }); } },
          { label: "固定视线", on: !cfg.gaze, act: function () { panelPatch({ gaze: false }); } }
        ]),
        toggleRow(
          "任务",
          [
            {
              label: "跑任务时思考",
              on: cfg.auto !== false,
              title: "会话在跑任务时自动切到「思考中」，任务结束回到你选的表情",
              act: function () { panelPatch({ auto: true }); }
            },
            {
              label: "只用手选的",
              on: cfg.auto === false,
              title: "不跟随任务状态，永远保持你选的表情",
              act: function () { panelPatch({ auto: false }); }
            }
          ],
          "跟随 dsh 会话的运行状态切换表情"
        ),
        toggleRow(
          "小动作",
          [
            {
              label: "边跑边动",
              on: cfg.anim !== false,
              title: "跑任务时不只是「思考中」：会换工作表情（处理中/检索资料/接收任务/复述回忆）、偶尔惊讶一下，还会自旋、弹跳、撒花",
              act: function () { panelPatch({ anim: true }); }
            },
            {
              label: "安静工作",
              on: cfg.anim === false,
              title: "跑任务时只保持「思考中」",
              act: function () { panelPatch({ anim: false }); }
            }
          ],
          "跑任务期间要不要有些小动作"
        ),
        toggleRow(
          "说话",
          [
            {
              label: "开气泡",
              on: cfg.bubble !== false,
              title: "让它把情绪说出来：开心就欢快，被说笨就小声委屈（每次一句话，20 秒节流）",
              act: function () { panelPatch({ bubble: true }); }
            },
            {
              label: "不说话",
              on: cfg.bubble === false,
              title: "只做表情，不弹气泡",
              act: function () { panelPatch({ bubble: false }); }
            }
          ],
          "要不要给表情球配一个聊天气泡"
        ),
        cfg.bubble !== false
          ? toggleRow(
              "台词",
              [
                {
                  label: "让 AI 写",
                  on: cfg.sayLocal !== true,
                  title: "每次让模型按当前心情写一句话（和判断心情同一次风格，token 很少）",
                  act: function () { panelPatch({ sayLocal: false }); }
                },
                {
                  label: "只用本地",
                  on: cfg.sayLocal === true,
                  title: "完全本地台词库，零 token",
                  act: function () { panelPatch({ sayLocal: true }); }
                }
              ],
              "气泡里的话从哪来"
            )
          : null,
        toggleRow(
          "心情",
          [
            {
              label: "让 AI 当大脑",
              on: cfg.brain === true,
              title: "每轮对话结束后，把用户最后一句和助手最后一段发给模型判断情绪，据此换表情（每轮一次极短调用，会消耗少量 token）",
              act: function () { panelPatch({ brain: true }); }
            },
            {
              label: "不用大脑",
              on: cfg.brain !== true,
              title: "不调用模型，表情只跟任务状态和你手选的表情有关",
              act: function () { panelPatch({ brain: false }); }
            }
          ],
          "是否用模型判断“用户现在什么心情”，让表情球跟着有情绪"
        ),
        cfg.brain === true
          ? toggleRow(
          "时机",
          [
            {
              label: "每轮任务",
              on: cfg.brainOn !== "message",
              title: "整个任务跑完只判断一次（最省，30 分钟的任务通常就一次）",
              act: function () { panelPatch({ brainOn: "task" }); }
            },
            {
              label: "每条回复",
              on: cfg.brainOn === "message",
              title: "每收到一条助手回复就判断一次（更灵敏，最快 20 秒一次）",
              act: function () { panelPatch({ brainOn: "message" }); }
            }
            ],
            "多久问一次“用户现在什么心情”（两种模式都最快 20 秒一次）"
          )
          : null,
        cfg.brain === true
          ? jsxs("div", {
              className: "dfb-row",
              title: "大脑始终使用当前会话正在用的模型（跟着聊天框上方那个模型走）",
              children: [
                jsx("label", { children: "模型" }),
                jsx("div", {
                  className: "dfb-model",
                  children: ui.model
                    ? ui.model.model + "（跟随当前会话）"
                    : "读取中…（未取到时用 dsh 默认模型）"
                })
              ]
            })
          : null,
        cfg.brain === true
          ? jsx("div", {
              className: "dfb-brain",
              children: ui.brain && ui.brain.busy
                ? "大脑思考中…"
                : ui.brain && ui.brain.error
                  ? "大脑：" + ui.brain.error
                  : ui.brain && ui.brain.id
                    ? "上次心情：" + moodLabel(ui.brain.id) + (ui.brain.reason ? "（" + ui.brain.reason + "）" : "")
                    : "还没读到对话：跑一轮任务后这里会显示它读出的心情"
            })
          : null,
        toggleRow(
          "空闲",
          [
            {
              label: "会自动犯困",
              on: cfg.idle,
              title: "1 分钟无操作转待机，3 分钟后进入睡眠",
              act: function () { panelPatch({ idle: true }); }
            },
            {
              label: "保持清醒",
              on: !cfg.idle,
              title: "永远停留在当前表情",
              act: function () { panelPatch({ idle: false }); }
            }
          ]
        ),
        jsxs("div", {
          className: "dfb-row",
          title: "手机上拖动不精确，直接点选一个角落落位",
          children: [
            jsx("label", { children: "位置" }),
            jsxs("div", {
              className: "dfb-grid",
              children: [
                jsx("button", {
                  type: "button",
                  className: "dfb-chip dfb-pos",
                  title: "左上角",
                  onClick: function () { panelPlace("tl"); },
                  children: "↖"
                }),
                jsx("button", {
                  type: "button",
                  className: "dfb-chip dfb-pos",
                  title: "右上角",
                  onClick: function () { panelPlace("tr"); },
                  children: "↗"
                }),
                jsx("button", {
                  type: "button",
                  className: "dfb-chip dfb-pos",
                  title: "屏幕正中间",
                  onClick: function () { panelPlace("center"); },
                  children: "◎"
                }),
                jsx("button", {
                  type: "button",
                  className: "dfb-chip dfb-pos",
                  title: "左下角",
                  onClick: function () { panelPlace("bl"); },
                  children: "↙"
                }),
                jsx("button", {
                  type: "button",
                  className: "dfb-chip dfb-pos",
                  title: "右下角（默认）",
                  onClick: function () { panelPlace("br"); },
                  children: "↘"
                })
              ]
            })
          ]
        }),
        jsxs("div", {
          className: "dfb-actions",
          children: [
            jsx("button", {
              type: "button",
              className: "dfb-btn",
              onClick: function () {
                if (FloatBallActions.resetPos) FloatBallActions.resetPos();
                props.onClose();
              },
              children: "↺ 回到右下角"
            }),
            jsx("button", {
              type: "button",
              className: "dfb-btn",
              "data-kind": "primary",
              onClick: function () { panelSelect("02"); },
              children: "待机放空"
            })
          ]
        })
      ]
    }),
    jsx("div", {
      className: "dfb-foot",
      children:
        "触屏：点一下＝自旋，长按＝打开本面板，拖动＝移动位置。" +
        "位置与设置会自动记住；数字键 1-9 快速切换前 9 个表情。" +
        "表情引擎：Grok Ball（MIT）。"
    })
    ]
  });

  return jsx("div", {
    ref: ref,
    className: "dfb-panel",
    style: {
      left: placement ? placement.left : undefined,
      top: placement ? placement.top : undefined
    },
    role: "dialog",
    "aria-label": "表情球设置",
    tabIndex: -1,
    children: jsxs(Fragment, {
      children: [
        jsxs("div", {
          className: "dfb-head",
          children: [
            jsx("span", {
              style: { display: "inline-flex", opacity: 0.75 },
              dangerouslySetInnerHTML: { __html: ICON_BALL }
            }),
            jsx("span", { className: "dfb-title", children: "表情球" }),
            jsx("span", {
              className: "dfb-badge",
              title: ui.running ? "dsh 会话正在跑任务" : "dsh 会话空闲",
              children: (live ? live.name : "未知") + " · " + liveId + (ui.running ? " · 任务中" : "")
            }),
            jsx("button", {
              type: "button",
              className: "dfb-x",
              title: "关闭",
              "aria-label": "关闭",
              onClick: props.onClose,
              children: "✕"
            })
          ]
        }),
        bodyNode
      ]
    })
  });
}

/* ============================== 侧边栏入口 ============================== */

function FloatBallEntry(props) {
  var wide = props && props.wide;
  return jsx("button", {
    type: "button",
    className: "dfb-entry",
    "data-wide": wide ? "1" : undefined,
    title: "表情球设置",
    onClick: function (e) { openPanel(e.currentTarget); },
    children: [
      jsx("span", {
        style: { display: "inline-flex", opacity: 0.8 },
        dangerouslySetInnerHTML: { __html: ICON_BALL }
      }),
      wide ? jsx("span", { children: "表情球" }) : null
    ]
  });
}
