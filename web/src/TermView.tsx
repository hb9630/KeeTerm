/* 终端视图(自 ieoss @shared/components/Terminal 剥离):ws 直连后端泵,
   二进制=输入/输出,text={"cols","rows"}=resize,ping=空闲保活,__ERR__=停止态。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Loader2 } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

/* 平台终端视图(xterm 直接渲染,非 iframe):ws 直连后端网关,URL 即路由(调用方拼完整路径)。
   卸载即断连(tmux 现场无损,重挂重连重绘)。协议:二进制=输入/输出,文本=输出,__ERR__=网关拒绝。 */

/// 终端主题预设(完整 16 色 ANSI;Campbell/Campbell PowerShell/One Half 取自 Windows Terminal 官方值)
const TERM_THEMES: Record<string, { name: string } & Record<string, string>> = {
  dark: { name: "深色", background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
    black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af", blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
    brightBlack: "#585b70", brightRed: "#ebacb8", brightGreen: "#b5ebab", brightYellow: "#f9e2af", brightBlue: "#8cb9fa", brightMagenta: "#f2cdea", brightCyan: "#99e9e0", brightWhite: "#a6adc8" },
  light: { name: "浅色", background: "#fafafa", foreground: "#383a42", cursor: "#526fff",
    black: "#383a42", red: "#e45649", green: "#50a14f", yellow: "#b76b01", blue: "#4078f2", magenta: "#a626a4", cyan: "#0184bc", white: "#90a4b0",
    brightBlack: "#4f525e", brightRed: "#e06c75", brightGreen: "#6fbf6f", brightYellow: "#a3861d", brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#1b1d23" },
  campbell: { name: "Campbell", background: "#0C0C0C", foreground: "#CCCCCC", cursor: "#FFFFFF",
    black: "#0C0C0C", red: "#C50F1F", green: "#13A10E", yellow: "#C19C00", blue: "#0037DA", magenta: "#881798", cyan: "#3A96DD", white: "#CCCCCC",
    brightBlack: "#767676", brightRed: "#E74856", brightGreen: "#16C60C", brightYellow: "#F9F1A5", brightBlue: "#3B78FF", brightMagenta: "#B4009E", brightCyan: "#61D6D6", brightWhite: "#F2F2F2" },
  "campbell-powershell": { name: "PowerShell 蓝", background: "#012456", foreground: "#CCCCCC", cursor: "#FFFFFF",
    black: "#0C0C0C", red: "#C50F1F", green: "#13A10E", yellow: "#C19C00", blue: "#0037DA", magenta: "#881798", cyan: "#3A96DD", white: "#CCCCCC",
    brightBlack: "#767676", brightRed: "#E74856", brightGreen: "#16C60C", brightYellow: "#F9F1A5", brightBlue: "#3B78FF", brightMagenta: "#B4009E", brightCyan: "#61D6D6", brightWhite: "#F2F2F2" },
  "one-half-dark": { name: "One Half 深", background: "#282C34", foreground: "#DCDFE4", cursor: "#FFFFFF",
    black: "#282C34", red: "#E06C75", green: "#98C379", yellow: "#E5C07B", blue: "#61AFEF", magenta: "#C678DD", cyan: "#56B6C2", white: "#DCDFE4",
    brightBlack: "#5A6374", brightRed: "#E06C75", brightGreen: "#98C379", brightYellow: "#E5C07B", brightBlue: "#61AFEF", brightMagenta: "#C678DD", cyan: "#56B6C2", brightWhite: "#FFFFFF" },
  "one-half-light": { name: "One Half 浅", background: "#FAFAFA", foreground: "#383A42", cursor: "#4F525E",
    black: "#383A42", red: "#E45649", green: "#50A14F", yellow: "#C18401", blue: "#0184BC", magenta: "#A626A4", cyan: "#0997B3", white: "#FAFAFA",
    brightBlack: "#5A6374", brightRed: "#E06C75", brightGreen: "#98C379", brightYellow: "#E5C07B", brightBlue: "#61AFEF", brightMagenta: "#C678DD", cyan: "#56B6C2", brightWhite: "#FFFFFF" },
  "solarized-dark": { name: "Solarized 深", background: "#002B36", foreground: "#839496", cursor: "#93A1A1",
    black: "#073642", red: "#DC322F", green: "#859900", yellow: "#B58900", blue: "#268BD2", magenta: "#D33682", cyan: "#2AA198", white: "#EEE8D5",
    brightBlack: "#002B36", brightRed: "#CB4B16", brightGreen: "#586E75", brightYellow: "#657B83", brightBlue: "#839496", brightMagenta: "#6C71C4", brightCyan: "#93A1A1", brightWhite: "#FDF6E3" },
  "solarized-light": { name: "Solarized 浅", background: "#FDF6E3", foreground: "#657B83", cursor: "#586E75",
    black: "#073642", red: "#DC322F", green: "#859900", yellow: "#B58900", blue: "#268BD2", magenta: "#D33682", cyan: "#2AA198", white: "#EEE8D5",
    brightBlack: "#002B36", brightRed: "#CB4B16", brightGreen: "#586E75", brightYellow: "#657B83", brightBlue: "#839496", brightMagenta: "#6C71C4", brightCyan: "#93A1A1", brightWhite: "#FDF6E3" },
};

/// 终端偏好(字号/主题):全局一份,localStorage 记住
type TermThemeKey = string;
const THEME_KEYS = Object.keys(TERM_THEMES);
const ANSI_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
function loadTermPrefs(): { fontSize: number; theme: TermThemeKey } {
  try {
    const p = JSON.parse(localStorage.getItem("ieoss_term_prefs") || "{}");
    return {
      fontSize: typeof p.fontSize === "number" && p.fontSize >= 8 && p.fontSize <= 32 ? p.fontSize : 16,
      theme: THEME_KEYS.includes(p.theme) ? p.theme : "dark",
    };
  } catch { return { fontSize: 16, theme: "dark" }; }
}

export function TermView({ wsPath, uiOffset = 0, active = true, onClose, onBusy, onIdle, onWake }: { wsPath: string; uiOffset?: number; active?: boolean; onClose?: () => void; onBusy?: () => void; onIdle?: () => void; onWake?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);   // 激活态镜像:onmessage 闭包里读
  const busyRef = useRef(onBusy);
  const idleRef = useRef(onIdle);
  const wakeRef = useRef(onWake);
  useEffect(() => { busyRef.current = onBusy; idleRef.current = onIdle; wakeRef.current = onWake; });
  // 移动端支持:触屏检测/粘滞 Ctrl/键条发送口
  const isTouch = useMemo(() => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches, []);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  const keySendRef = useRef<((s: string) => void) | null>(null);
  const [prefs, setPrefs] = useState(loadTermPrefs);
  const [panel, setPanel] = useState(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });   // 每渲染刷新:tab 切换后关的仍是当前 tab
  const sendSizeRef = useRef<(() => void) | null>(null);   // active 恢复时强制同步尺寸用
  const [booting, setBooting] = useState(true);   // 首连遮罩:ws 首次 open/close 前转圈(建连+首屏重绘慢,黑屏无反馈)
  useEffect(() => { localStorage.setItem("ieoss_term_prefs", JSON.stringify(prefs)); }, [prefs]);
  const setFont = (f: number) => setPrefs(p => ({ ...p, fontSize: Math.min(32, Math.max(8, f)) }));

  // 设置面板点外收起(按钮+面板同域不收,点外收)
  useEffect(() => {
    if (!panel) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("[data-term-panel]")) setPanel(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [panel]);

  useEffect(() => {
    const term = new XTerm({
      fontSize: prefs.fontSize, fontFamily: "'Cascadia Mono','JetBrains Mono',Consolas,monospace",
      cursorBlink: true, scrollback: 5000,
      theme: { ...TERM_THEMES[prefs.theme] } as XTerm["options"]["theme"],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    termRef.current = term; fitRef.current = fit;
    // 满视口:容器尺寸变化即重算(挂载布局完成/视图切换/侧栏收展)。
    // 零尺寸(display:none 的后台 tab)跳过——fit 出 NaN 行列会进坏状态,恢复显示也救不回
    const el = ref.current!;
    const refit = () => { if (el.clientWidth && el.clientHeight) fit.fit(); };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    window.addEventListener("resize", refit);   // 窗口调整双保险(iframe 内同样触发)
    requestAnimationFrame(refit);
    let ws: WebSocket | null = null, alive = false, dead = false, retry: ReturnType<typeof setTimeout> | undefined;
    let idleT: ReturnType<typeof setTimeout> | undefined;   // 静默检测:输出停止 4s 后报 idle(呼吸)
    let wakeT: ReturnType<typeof setTimeout> | undefined;   // 呼吸延迟隐:新输出后 2s 隐呼吸(防抖动闪烁)
    let pingedAt = 0;   // 最后一次发流量时刻:活动即时补 ping 用
    const sendSize = () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ cols: term.cols, rows: term.rows })); };
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${wsPath}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { alive = true; setBooting(false); sendSize(); term.focus();
        setTimeout(() => sendSizeRef.current?.(), 250); };   // 布局/字体就绪后补发:tmux 建会话尺寸才对
      ws.onmessage = ev => {
        if (typeof ev.data === "string") {
          if (ev.data.startsWith("__ERR__")) {
            // 网关明确拒绝(连接结束/会话不存在等):停止重连——无限重连只会刷屏,现场已不可达
            dead = true; if (retry) clearTimeout(retry);
            const msg = ev.data.slice(7);
            if (msg) term.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);   // 有详情才红字(裸信号=常规结束,不刷屏)
            term.write(`\r\n\x1b[2m[连接已停止]\x1b[0m\r\n\x1b[2m[回车或点击重新连接${onClose ? " · Ctrl+D 关闭标签" : ""}]\x1b[0m\r\n`);
            return;
          }
          term.write(ev.data);
        } else {
          const buf = new Uint8Array(ev.data);
          term.write(buf);
          // tab 状态标:转圈=输出过即保持;静默 4s=呼吸(等确认);新输出 2s 后隐呼吸(转圈不停)。
          // 微输出(<128B,tmux 状态栏时钟每分钟重绘之类)不算未读——看过无新消息的 tab 不亮
          if (buf.length >= 128 && !activeRef.current) {
            busyRef.current?.();
            if (idleT) clearTimeout(idleT);
            idleT = setTimeout(() => {
              if (wakeT) clearTimeout(wakeT);
              if (!activeRef.current) idleRef.current?.();
            }, 4000);
            if (wakeT) clearTimeout(wakeT);
            wakeT = setTimeout(() => { if (!activeRef.current) wakeRef.current?.(); }, 2000);
          }
        }
      };
      ws.onclose = () => {
        if (dead) return;   // 网关已明确拒绝,不再重连
        setBooting(false);   // 撤首连遮罩(交给终端内的重连提示)
        if (alive) { term.write("\r\n\x1b[2m[连接断开,重连中…]\x1b[0m\r\n"); alive = false; }
        retry = setTimeout(connect, 2000);
      };
    };
    term.onData(d => {
      // 停止态(dead,网关明确拒绝)或断开态(自动重连间隙):回车=重连(仅停止态),Ctrl+D=关标签
      if (dead || !ws || ws.readyState > 1) {
        if (d === "\r" && dead) {
          dead = false;
          term.write("\r\n\x1b[2m[重新连接…]\x1b[0m\r\n");
          connect();
        } else if (d === "\x04") {
          onCloseRef.current?.();
        }
        return;
      }
      if (ctrlRef.current && /^[a-zA-Z]$/.test(d)) {
        // 粘滞 Ctrl + 字母 = 控制字符(Ctrl+C 中断等),发完即复位
        ctrlRef.current = false; setCtrl(false);
        if (ws && ws.readyState === 1) ws.send(new TextEncoder().encode(String.fromCharCode(d.toLowerCase().charCodeAt(0) - 96)));
        return;
      }
      if (ws && ws.readyState === 1) { ws.send(new TextEncoder().encode(d)); pingedAt = Date.now(); }
    });
    keySendRef.current = (s: string) => { if (ws && ws.readyState === 1) ws.send(new TextEncoder().encode(s)); };
    term.onResize(sendSize);
    sendSizeRef.current = sendSize;
    // 保活:周期 30s ping 维持 ws/frp/NAT 各层流量;后端收到非 cols/rows 的 JSON 自动忽略
    const ping = (force = false) => {
      if (!ws || ws.readyState !== 1) return;
      const now = Date.now();
      if (!force && now - pingedAt < 5_000) return;   // 活动补 ping 节流 5s
      pingedAt = now;
      ws.send('{"ping":1}');
    };
    const pingT = setInterval(() => ping(true), 30_000);
    // 网页版剪贴板体验(ssh 客户端级):选中即复制;右键粘贴
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
    });
    const host = ref.current!;
    // 鼠标活动→即时补 ping(键盘输入本身就是流量):空闲超时从最后一次活动重算,人在终端前连接就不断;
    // 已停止态点击终端=立即重连(tmux 现场无损恢复)
    const onMouse = () => {
      if (dead) { dead = false; term.write("\r\n\x1b[2m[重新连接…]\x1b[0m\r\n"); connect(); return; }
      ping();
    };
    host.addEventListener("mousedown", onMouse);
    host.addEventListener("mousemove", onMouse);
    host.oncontextmenu = e => {
      e.preventDefault();
      navigator.clipboard?.readText().then(t => { if (t) term.paste(t); }).catch(() => {});
    };
    connect();
    return () => { termRef.current = null; if (retry) clearTimeout(retry); if (idleT) clearTimeout(idleT); if (wakeT) clearTimeout(wakeT); clearInterval(pingT); host.removeEventListener("mousedown", onMouse); host.removeEventListener("mousemove", onMouse); ws?.close(); ro.disconnect(); window.removeEventListener("resize", refit); host.oncontextmenu = null; term.dispose(); };
  }, [wsPath]);

  // 触屏滚动:xterm 视口不吃 touch 手势,手动转发 scrollLines(拖动=回滚看历史,松手留在原地)
  useEffect(() => {
    const el = ref.current;
    if (!el || !isTouch) return;
    let y0 = 0, acc = 0;
    const ts = (e: TouchEvent) => { y0 = e.touches[0].clientY; acc = 0; };
    const tm = (e: TouchEvent) => {
      e.preventDefault();
      const y = e.touches[0].clientY;
      acc += y0 - y; y0 = y;
      const lines = Math.trunc(acc / 22);
      if (lines) { termRef.current?.scrollLines(lines); acc -= lines * 22; }
    };
    el.addEventListener("touchstart", ts, { passive: true });
    el.addEventListener("touchmove", tm, { passive: false });
    return () => { el.removeEventListener("touchstart", ts); el.removeEventListener("touchmove", tm); };
  }, [isTouch]);

  // tab 激活(从 display:none 恢复显示):双拍重算并强制同步——RO 对 hidden→shown 不可靠,
  // 且 onResize 只在尺寸真变时发 sendSize(tmux 可能仍持旧尺寸),故每次都手动补一拍
  useEffect(() => {
    if (!active) return;
    const kicks = [30, 250].map(ms => setTimeout(() => {
      const el = ref.current, f = fitRef.current;
      if (el && f && el.clientWidth && el.clientHeight) { f.fit(); sendSizeRef.current?.(); }
    }, ms));
    return () => kicks.forEach(clearTimeout);
  }, [active]);

  // 偏好热应用(字号/主题即时生效,不必重连)
  useEffect(() => {
    const t = termRef.current; if (!t) return;
    t.options.fontSize = prefs.fontSize;
    t.options.theme = { ...TERM_THEMES[prefs.theme] } as XTerm["options"]["theme"];
    fitRef.current?.fit();
  }, [prefs]);

  return (
    // overflow-hidden:xterm 按整行高渲染,比 flex 容器高几像素时可见溢出会传到 body 出滚动条;
    // 顶部贴齐 + 行数取整残余落底部(与主题背景同色不可见) → 终端视觉满高、顶部零空白;
    // xterm-viewport 滚动条隐藏(scrollback 回看靠滚轮/触屏拖动,满屏终端不出条);
    // 触屏设备在终端下方加辅助键条(Esc/箭头/粘滞 Ctrl 等,软键盘给不了的键)
    <div style={{ background: TERM_THEMES[prefs.theme].background }}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      onKeyDownCapture={e => {
        if (!e.ctrlKey || !e.shiftKey) return;
        if (e.key === "+" || e.key === "=") { setFont(prefs.fontSize + 1); e.preventDefault(); }
        else if (e.key === "-") { setFont(prefs.fontSize - 1); e.preventDefault(); }
        else if (e.key === "0") { setFont(16); e.preventDefault(); }
      }}>
      <div ref={ref}
        className="relative min-h-0 flex-1 overflow-hidden px-1 [&_.xterm-viewport]:[scrollbar-width:none] [&_.xterm-viewport::-webkit-scrollbar]:hidden" />
      {booting && (
        <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 text-sm text-zinc-400" style={{ background: TERM_THEMES[prefs.theme].background }}>
          <Loader2 className="h-4 w-4 animate-spin" />正在连接终端…
        </div>
      )}
      {/* 外观按钮:点击展开/收起(点外自动收);面板开着按钮常亮 */}
      <div data-term-panel style={{ right: 8 + uiOffset }} className="absolute top-2 z-30">
      <button title="终端外观:字号 / 主题" onClick={() => setPanel(v => !v)}
        className={`block rounded-md border border-white/10 bg-zinc-900/80 px-1.5 py-0.5 text-[13px] transition-opacity ${panel ? "text-zinc-100 opacity-100" : "text-zinc-400 opacity-60 hover:text-zinc-100 hover:opacity-100"}`}>Aa</button>
      {panel && (
        <div data-term-panel
          className="absolute right-0 top-full w-[19rem] rounded-md border border-white/10 bg-zinc-900 p-2 text-[13px] shadow-lg">
          <div className="flex items-center gap-2 text-zinc-300">
            <span>字号</span>
            <button onClick={() => setFont(prefs.fontSize - 1)} className="h-6 w-6 rounded hover:bg-white/10">−</button>
            <span className="w-6 text-center tabular-nums">{prefs.fontSize}</span>
            <button onClick={() => setFont(prefs.fontSize + 1)} className="h-6 w-6 rounded hover:bg-white/10">＋</button>
            {prefs.fontSize !== 16 && <button onClick={() => setFont(16)} className="rounded px-1 text-[12px] text-zinc-500 hover:text-zinc-200">重置</button>}
          </div>
          <div className="mt-2 px-0.5 text-[12px] text-zinc-400">主题(Windows Terminal 配色)</div>
          <div className="mt-1 space-y-0.5">
            {THEME_KEYS.map(k => {
              const th = TERM_THEMES[k];
              return (
                <button key={k} onClick={() => setPrefs(p => ({ ...p, theme: k }))}
                  className={`flex w-full items-center gap-3 rounded px-2 py-1.5 text-left ${prefs.theme === k ? "bg-white/10 ring-1 ring-sky-400" : "hover:bg-white/5"}`}>
                  <span className="flex w-32 shrink-0 items-center gap-1.5 text-zinc-200">
                    <span className={`w-3 text-center text-sky-400 ${prefs.theme === k ? "" : "opacity-0"}`}>✓</span>
                    {th.name}
                  </span>
                  {/* 16 色 ANSI 色板预览(亮/暗 8+8) */}
                  <span className="flex gap-px">
                    {ANSI_KEYS.map(c => <i key={c} className="block h-3.5 w-2 rounded-[2px]" style={{ background: th[c] }} />)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      </div>
      {/* 移动端辅助键条:点按直发序列(pointerdown 免抢软键盘焦点);Ctrl 粘滞,下一个字母组成控制字符 */}
      {isTouch && (
        <div className="flex shrink-0 select-none gap-1 px-1 pb-1 pt-1" style={{ background: "#11111be6" }}
          onTouchStart={e => e.preventDefault()}>   {/* 拦 tap 合成链:按键不唤起软键盘 */}
          {([
            ["Esc", "\x1b"], ["PgUp", "\x1b[5~"], ["PgDn", "\x1b[6~"],
            ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"],
            ["Tab", "\t"], ["/", "/"],
          ] as [string, string][]).map(([lab, seq]) => (
            <button key={lab} type="button" tabIndex={-1} onPointerDown={e => { e.preventDefault(); keySendRef.current?.(seq); }}
              className="flex-1 rounded-md border border-white/10 bg-white/5 py-2 text-center font-mono text-[13px] text-zinc-200 active:bg-white/25">
              {lab}
            </button>
          ))}
          <button type="button" tabIndex={-1} onPointerDown={e => { e.preventDefault(); ctrlRef.current = !ctrlRef.current; setCtrl(ctrlRef.current); }}
            className={`flex-1 rounded-md border py-2 text-center font-mono text-[13px] active:bg-white/25 ${ctrl ? "border-sky-400 bg-sky-500/30 text-sky-200" : "border-white/10 bg-white/5 text-zinc-200"}`}>
            Ctrl
          </button>
          {/* 软键盘开关:看历史时收起腾屏,要输入再唤起 */}
          <button type="button" tabIndex={-1}
            onPointerDown={e => {
              e.preventDefault();
              const ta = termRef.current?.textarea as HTMLElement | null | undefined;
              if (!ta) return;
              if (document.activeElement === ta) ta.blur(); else { ta.focus(); termRef.current?.focus(); }
            }}
            className="flex-1 rounded-md border border-white/10 bg-white/5 py-2 text-center font-mono text-[13px] text-zinc-200 active:bg-white/25">
            ⌨
          </button>
        </div>
      )}
    </div>
  );
}
