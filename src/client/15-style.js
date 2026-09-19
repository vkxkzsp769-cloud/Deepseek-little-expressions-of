/* ============================================================================
 * 15-style.js — 样式：全部挂在 .dfb-* 命名空间下，由入口注入单个 <style>，
 * 不引入任何外部字体 / 图片 / 网络资源。
 * ========================================================================== */

var CSS = [
  /* ---------- 悬浮球本体 ---------- */
  ".dfb-ball{position:fixed;z-index:240;pointer-events:auto;cursor:grab;touch-action:none;",
  "user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;",
  "transition:filter .18s ease;border-radius:50%;}",
  ".dfb-ball:focus-visible{outline:2px solid #7dd3fc;outline-offset:3px;}",
  ".dfb-ball:hover{filter:drop-shadow(0 6px 18px rgb(0 0 0 / .3));}",
  ".dfb-ball[data-drag=\"1\"]{cursor:grabbing;filter:drop-shadow(0 10px 24px rgb(0 0 0 / .34));}",
  ".dfb-ball[data-drag=\"1\"] .dfb-ball-svg{transform:scale(1.06);}",
  ".dfb-ball-svg{width:100%;height:100%;transition:transform .18s cubic-bezier(.2,.8,.3,1);pointer-events:none;}",
  /* 位置用 left/top 直接写（拖动时逐帧写），提示渲染层提前建好图层 */
  ".dfb-ball{will-change:left,top;}",
  ".dfb-ball[data-drag=\"1\"]{will-change:transform,left,top;}",
  ".dfb-ball-svg>svg{display:block;width:100%;height:100%;overflow:visible;}",

  /* ---------- 聊天气泡 ---------- */
  ".dfb-bubble{position:fixed;z-index:241;max-width:230px;padding:8px 11px;border-radius:12px;",
  "font-family:inherit;font-size:12.5px;line-height:1.5;cursor:pointer;",
  "background:var(--dsh-bg-elevated,rgb(28 30 36 / .97));color:var(--dsh-fg,rgb(236 239 245));",
  "border:1px solid rgb(148 163 184 / .3);box-shadow:0 10px 28px rgb(0 0 0 / .34);",
  "animation:dfb-say-in .22s cubic-bezier(.2,.9,.3,1);word-break:break-word;",
  "user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;}",
  /* 小尖尖：横向位置由 --dfb-tip-x 驱动，始终对着球心；气泡在上方时尖尖在底部，反之在顶部 */
  ".dfb-bubble::after{content:\"\";position:absolute;left:var(--dfb-tip-x,22px);width:10px;height:10px;",
  "margin-left:-5px;background:inherit;",
  "border-right:1px solid rgb(148 163 184 / .3);border-bottom:1px solid rgb(148 163 184 / .3);}",
  ".dfb-bubble[data-side=\"top\"]::after{bottom:-6px;transform:rotate(45deg);}",
  ".dfb-bubble[data-side=\"bottom\"]::after{top:-6px;transform:rotate(225deg);}",
  ".dfb-bubble[data-side=\"none\"]::after{display:none;}",
  ".dfb-bubble[data-kind=\"model\"]{border-color:rgb(56 189 248 / .45);}",
  ".dfb-bubble[data-kind=\"local-fallback\"]{opacity:.92;}",
  "@keyframes dfb-say-in{from{opacity:0;transform:translateY(6px) scale(.94);}to{opacity:1;transform:none;}}",

  /* ---------- 首次提示气泡 ---------- */
  ".dfb-hint{position:fixed;z-index:239;padding:7px 11px;border-radius:10px;",
  "font-size:12px;line-height:1.5;font-family:inherit;",
  "background:var(--dsh-bg-elevated,rgb(28 30 36 / .96));color:var(--dsh-fg,rgb(235 238 245));",
  "border:1px solid rgb(148 163 184 / .28);box-shadow:0 10px 28px rgb(0 0 0 / .34);",
  "animation:dfb-hint-in .3s cubic-bezier(.2,.9,.3,1);pointer-events:none;}",
  "@keyframes dfb-hint-in{from{opacity:0;transform:translateY(6px) scale(.96);}to{opacity:1;transform:none;}}",

  /* ---------- 配置面板（Portal 到 body，fixed 定位） ---------- */
  ".dfb-panel{position:fixed;z-index:260;width:290px;max-height:min(76vh,620px);display:flex;",
  "user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;",
  "flex-direction:column;overflow:hidden;border-radius:14px;font-family:inherit;font-size:12.5px;",
  "background:var(--dsh-bg-elevated,rgb(24 26 32 / .98));color:var(--dsh-fg,rgb(232 235 242));",
  "border:1px solid rgb(148 163 184 / .26);box-shadow:0 18px 50px rgb(0 0 0 / .46);",
  "animation:dfb-panel-in .16s cubic-bezier(.2,.9,.3,1);}",
  "@keyframes dfb-panel-in{from{opacity:0;transform:translateY(8px) scale(.98);}to{opacity:1;transform:none;}}",
  ".dfb-head{display:flex;align-items:center;gap:8px;padding:10px 12px;",
  "border-bottom:1px solid rgb(148 163 184 / .18);}",
  ".dfb-title{font-weight:650;font-size:13px;}",
  ".dfb-badge{margin-left:auto;font-size:11px;padding:2px 7px;border-radius:999px;color:rgb(203 213 225);",
  "background:rgb(148 163 184 / .16);white-space:nowrap;}",
  ".dfb-x{border:0;background:transparent;color:inherit;cursor:pointer;font-size:15px;line-height:1;",
  "padding:4px 6px;border-radius:7px;opacity:.7;}",
  ".dfb-x:hover{opacity:1;background:rgb(148 163 184 / .18);}",
  ".dfb-body{padding:10px 12px 12px;overflow:auto;overscroll-behavior:contain;}",
  ".dfb-group{margin-bottom:10px;}",
  ".dfb-group-t{font-size:11px;letter-spacing:.04em;opacity:.62;margin:0 0 6px 2px;}",
  ".dfb-grid{display:flex;flex-wrap:wrap;gap:5px;}",
  ".dfb-chip{font-family:inherit;font-size:11.5px;line-height:1;padding:6px 8px;border-radius:8px;cursor:pointer;",
  "border:1px solid rgb(148 163 184 / .26);background:rgb(148 163 184 / .08);color:inherit;",
  "transition:background .14s ease,border-color .14s ease,transform .14s ease;}",
  ".dfb-chip:hover{background:rgb(148 163 184 / .2);transform:translateY(-1px);}",
  ".dfb-chip[data-on=\"1\"]{background:rgb(56 189 248 / .24);border-color:rgb(56 189 248 / .7);}",
  ".dfb-pos{min-width:38px;font-size:15px;line-height:1;padding:8px 0;text-align:center;}",
  ".dfb-model{flex:1 1 auto;font-size:11.5px;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".dfb-input{flex:1 1 0;min-width:0;font-family:inherit;font-size:11.5px;padding:6px 8px;border-radius:8px;",
  "border:1px solid rgb(148 163 184 / .28);background:rgb(148 163 184 / .08);color:inherit;}",
  ".dfb-input::placeholder{color:inherit;opacity:.4;}",
  ".dfb-brain{font-size:11px;line-height:1.5;opacity:.72;margin:-2px 0 9px 2px;word-break:break-word;}",
  ".dfb-row{display:flex;align-items:center;gap:8px;margin-bottom:9px;}",
  ".dfb-row>label{flex:0 0 46px;opacity:.66;font-size:11.5px;}",
  ".dfb-range{flex:1 1 auto;accent-color:#38bdf8;height:18px;}",
  ".dfb-num{flex:0 0 42px;text-align:right;font-variant-numeric:tabular-nums;opacity:.72;font-size:11.5px;}",
  ".dfb-actions{display:flex;gap:6px;flex-wrap:wrap;}",
  ".dfb-btn{flex:1 1 auto;font-family:inherit;font-size:11.5px;padding:7px 10px;border-radius:9px;cursor:pointer;",
  "border:1px solid rgb(148 163 184 / .28);background:rgb(148 163 184 / .1);color:inherit;}",
  ".dfb-btn:hover{background:rgb(148 163 184 / .2);}",
  ".dfb-btn[data-kind=\"primary\"]{background:rgb(56 189 248 / .22);border-color:rgb(56 189 248 / .55);}",
  ".dfb-foot{font-size:10.5px;line-height:1.6;opacity:.5;margin-top:9px;}",

  /* ---------- 侧边栏入口按钮 ---------- */
  ".dfb-entry{display:inline-flex;align-items:center;justify-content:center;gap:6px;width:100%;",
  "padding:7px 10px;border-radius:9px;cursor:pointer;font-family:inherit;font-size:12px;color:inherit;",
  "border:1px solid rgb(148 163 184 / .24);background:rgb(148 163 184 / .08);}",
  ".dfb-entry:hover{background:rgb(148 163 184 / .2);}",
  ".dfb-entry[data-wide=\"1\"]{justify-content:flex-start;}"
].join("");
