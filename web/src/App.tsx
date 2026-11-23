/* term-gateway 工作台:左栏(目标树=local+ssh config+toml 条目,容器挂主机下,CRUD,可缩起)
   → 右键连接(SSH / tmux 会话 / 容器登入)→ tab 条 + 三栏(终端|预览|文件树最右)。
   纯小工具:目标即 ~/.ssh/config(VSCode Remote 哲学),targets.toml 只存增强项。 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { api, cn, toast } from "./lib";
import { curLang, switchLang, t } from "./i18n";
import { TermView } from "./TermView";
import Explorer from "./Explorer";
import Markdown from "./Markdown";
import MonitorAside from "./MonitorPanel";
// 编辑器内核(CodeMirror core,无语言包)体量不小:懒加载,点"编辑"才拉 chunk,主包不背
const CodeArea = lazy(() => import("./CodeArea"));
import {
  Box, ChevronDown, ChevronRight, Container, Download, FolderTree, HardDrive, Info, Languages, Layers, Loader2, Monitor,
  Pencil, Plus, Server, SquareTerminal, Terminal, Trash2, X,
} from "lucide-react";

interface Target {
  name: string; kind: string; source: string; note: string;
  user: string; addr: string; port: string; has_pass: boolean;
}
interface Ctn { name: string; image: string; running: boolean; compose?: string }
type PvTab = { path: string; name: string; kind: string; url?: string; text?: string; err?: boolean; edit?: string };
interface Tab { target: string; ctn?: string; engine?: string; session?: string; inst?: number; root?: PNode }
interface Ctx { x: number; y: number; t: Target; ctn?: string; sessions?: "loading" | string[] }
interface Edit { name: string; addr: string; port: string; note: string; isNew: boolean; mode: "addr" | "cmd"; cmd: string }

/** 解析一条 ssh 命令:user@host / -p 端口 / -l 用户(其余选项忽略) */
function parseSshCmd(cmd: string): { addr?: string; port?: string; user?: string } {
  const toks = cmd.trim().split(/\s+/).filter(Boolean);
  if (toks[0] === "ssh") toks.shift();
  let user = "", addr = "", port = "";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "-p") port = toks[++i] || "";
    else if (/^-p\d+$/.test(t)) port = t.slice(2);
    else if (t === "-l") user = toks[++i] || "";
    else if (!t.startsWith("-") && !addr) {
      const at = t.indexOf("@");
      if (at > 0) { user = user || t.slice(0, at); addr = t.slice(at + 1); }
      else addr = t;
    }
  }
  return addr ? { addr, port, user } : {};
}

/* 分屏(iTerm 式可嵌套):tab.root 存面板树;无 root = 单面板(旧 TermTab 全功能:文件树/预览)。
   leaf=终端面板(独立连接),split=左右(h)/上下(v)容器,两子 + 可拖比例。 */
type Conn = { target: string; ctn?: string; engine?: string; session?: string };
type PNode = ({ leaf: true; conn: Conn } | { leaf: false; dir: "h" | "v"; ratio: number; kids: [PNode, PNode] }) & { id: string };

const leafCount = (n: PNode): number => n.leaf ? 1 : leafCount(n.kids[0]) + leafCount(n.kids[1]);
const firstLeaf = (n: PNode): PNode => n.leaf ? n : firstLeaf(n.kids[0]);
/** 在 paneId 的 leaf 位置插入拆分(原面板为 kids[0],新面板 kids[1]) */
const insertSplit = (n: PNode, paneId: string, dir: "h" | "v", fresh: PNode): PNode =>
  n.leaf
    ? (n.id === paneId ? { id: `s${n.id}-${fresh.id}`, leaf: false, dir, ratio: 0.5, kids: [n, fresh] } : n)
    : { ...n, kids: [insertSplit(n.kids[0], paneId, dir, fresh), insertSplit(n.kids[1], paneId, dir, fresh)] };
/** 摘除 paneId;拆分节点只剩一子时回缩 */
const removePane = (n: PNode, paneId: string): PNode | null => {
  if (n.leaf) return n.id === paneId ? null : n;
  const a = removePane(n.kids[0], paneId), b = removePane(n.kids[1], paneId);
  if (!a && !b) return null;
  if (!a) return b!;
  if (!b) return a;
  return { ...n, kids: [a, b] };
};
const setRatioAt = (n: PNode, splitId: string, ratio: number): PNode =>
  n.leaf ? n : (n.id === splitId ? { ...n, ratio } : { ...n, kids: [setRatioAt(n.kids[0], splitId, ratio), setRatioAt(n.kids[1], splitId, ratio)] });
interface Edit { name: string; addr: string; note: string; isNew: boolean }

const tkey = (t: Tab) => t.inst
  ? `${t.target}#${t.inst}`   // 实例后缀:同目标多开(+=连点本机)
  : t.ctn
    ? `${t.target}:${t.ctn}@${t.engine || "auto"}${t.session ? `:T:${t.session}` : ""}`
    : t.session ? `${t.target}:T:${t.session}` : t.target;

function nextSession(sessions: string[] | undefined): string {
  const used = new Set(sessions || []);
  if (!used.has("main")) return "main";
  for (let i = 2; ; i++) { const n = `main-${i}`; if (!used.has(n)) return n; }
}

export default function App() {
  const [targets, setTargets] = useState<Target[] | null>(null);
  // 左树展开状态:记住展开过的主机名单(刷新恢复=重新拉容器),收起即移出名单
  const [open, setOpen] = useState<Record<string, "loading" | { engine: string; list: Ctn[] }>>(() => {
    try {
      const s: Record<string, string> = JSON.parse(localStorage.getItem("tg_tree_open") || "{}");
      return Object.fromEntries(Object.keys(s).map(k => [k, "loading" as const]));
    } catch { return {}; }
  });
  const treeLoading = useRef<Set<string>>(new Set());
  const persistOpen = (fn: (s: Record<string, string>) => void) => {
    try { const s: Record<string, string> = JSON.parse(localStorage.getItem("tg_tree_open") || "{}"); fn(s); localStorage.setItem("tg_tree_open", JSON.stringify(s)); } catch { /* */ }
  };
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [about, setAbout] = useState(false);
  // ~/.ssh/config 编辑器(下拉「编辑 ssh config」):拉本机文件,CodeArea 编辑,保存走 local fs/save
  const [sshCfg, setSshCfg] = useState<{ home: string; text: string; loading: boolean } | null>(null);
  const openSshCfg = () => {
    setPicker(false);
    setSshCfg({ home: "", text: "", loading: true });
    (async () => {
      try {
        const h = await api<{ home: string }>("/api/t/target/local/fs/home");
        const r = await fetch(`/api/t/target/local/fs/download?path=${encodeURIComponent(h.home + "/.ssh/config")}`);
        setSshCfg({ home: h.home || "", text: r.ok ? await r.text() : "", loading: false });
      } catch (e) { toast(e instanceof Error ? e.message : String(e), true); setSshCfg(null); }
    })();
  };
  const saveSshCfg = () => {
    if (!sshCfg) return;
    const content = sshCfg.text;
    api("/api/t/target/local/fs/save", { method: "POST", body: JSON.stringify({ path: sshCfg.home + "/.ssh/config", content }) })
      .then(() => { toast("已保存,主机列表已刷新"); loadTargets(); })
      .catch(e => toast(e instanceof Error ? e.message : String(e), true));
  };
  const [grp, setGrp] = useState<Record<string, boolean>>(() => {   // compose 分组折叠(host::project),记住
    try { return JSON.parse(localStorage.getItem("tg_tree_grp") || "{}"); } catch { return {}; }
  });
  useEffect(() => { localStorage.setItem("tg_tree_grp", JSON.stringify(grp)); }, [grp]);
  const [picker, setPicker] = useState(false);   // tab 头下拉:主机选择器
  // 菜单 fixed 视口定位(滚动容器 overflow 会裁剪 absolute 弹层):
  // 打开时按按钮位置算落点,左右 clamp 不出边(手机窄屏同样安全)
  const [pickPos, setPickPos] = useState<{ left: number; top: number } | null>(null);
  const pickRef = useRef<HTMLDivElement | null>(null);
  const togglePicker = () => {
    const r = pickRef.current?.getBoundingClientRect();
    const W = Math.min(288, window.innerWidth - 16);
    let left = r ? r.right - W : 8;
    left = Math.max(8, Math.min(left, window.innerWidth - W - 8));
    setPickPos(r ? { left, top: r.bottom + 2 } : null);
    setPicker(v => !v);
  };
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; k: string } | null>(null);   // tab 头右键:关闭菜单
  useEffect(() => {
    if (!tabCtx) return;
    const close = () => setTabCtx(null);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setTabCtx(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [tabCtx]);
  // 下拉树的独立展开状态(与左栏互不影响)
  const [pOpen, setPOpen] = useState<Record<string, "loading" | { engine: string; list: Ctn[] }>>({});
  const [pGrp, setPGrp] = useState<Record<string, boolean>>({});
  const pEngOf = (name: string) => { const n = pOpen[name]; return n && n !== "loading" ? n.engine : ""; };
  const pToggle = async (name: string) => {
    if (pOpen[name]) { setPOpen(o => { const n = { ...o }; delete n[name]; return n; }); return; }
    setPOpen(o => ({ ...o, [name]: "loading" }));
    try {
      const r = await api<{ engine?: string; containers: Ctn[] }>(`/api/t/target/${encodeURIComponent(name)}/containers`);
      setPOpen(o => ({ ...o, [name]: { engine: r.engine || "", list: r.containers } }));
    } catch (e) {
      setPOpen(o => { const n = { ...o }; delete n[name]; return n; });
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };
  useEffect(() => {
    if (!picker) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("[data-picker]")) setPicker(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [picker]);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(false);   // 左栏已撤(保留 state 引用防漏改处报错,后续清理)
  const setSideW = (_n: number) => { /* 左栏已撤 */ };

  const loadTargets = async () => {
    try { setTargets((await api<{ targets: Target[] }>("/api/t/targets")).targets); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), true); setTargets([]); }
  };
  useEffect(() => { loadTargets(); }, []);

  // 主机在线状态:加载后探测一次,之后每 60s 轮询(local 恒在线)
  const [alive, setAlive] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!targets) return;
    const probe = () => targets.forEach(t => {
      api<{ ok: boolean }>(`/api/t/target/${encodeURIComponent(t.name)}/ping`)
        .then(r => setAlive(a => ({ ...a, [t.name]: !!r.ok })))
        .catch(() => setAlive(a => ({ ...a, [t.name]: false })));
    });
    probe();
    const tm = setInterval(probe, 60_000);
    return () => clearInterval(tm);
  }, [targets]);

  // 恢复 tab 集
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("tg_tabs") || "null");
      if (saved?.tabs?.length) {
        // 面板树整体重赋 id:净化历史脏数据(旧计数器 bug 留下的重复 id=焦点/遮罩同时命中两块)
        const tabs = (saved.tabs as Tab[]).map(t => t.root ? { ...t, root: reidTree(t.root) } : t);
        setTabs(tabs);
        setActive(saved.active ?? tkey(tabs[0]));
      }
    } catch { /* */ }
  }, []);
  useEffect(() => {
    if (tabs.length) localStorage.setItem("tg_tabs", JSON.stringify({ tabs, active }));
    else localStorage.removeItem("tg_tabs");
  }, [tabs, active]);
  useEffect(() => {
    const t = tabs.find(x => tkey(x) === active);
    document.title = t ? `KeeTerm·${t.ctn || t.session ? `${t.target}·${t.ctn || t.session}` : t.target}` : "KeeTerm";
  }, [active, tabs]);

  const openTab = (opt: Tab) => {
    setPicker(false);   // 从下拉登录后收起下拉
    if (!opt.session) {
      // SSH/容器登入每次都是新会话:同目标也新开 tab(local 点 + 连点本机);tmux 会话仍去重(attach 同会话无意义)
      const used = new Set(tabs.map(tkey));
      let i = 1;
      while (used.has(`${opt.target}#${i}`)) i++;
      opt = { ...opt, inst: i };
    }
    const k = tkey(opt);
    setTabs(ts => ts.some(t => tkey(t) === k) ? ts : [...ts, opt]);
    setActive(k);
  };

  // ---- 分屏 ----
  // 连接动作统一口:点击=新 tab;Shift+点击=左右拆分;Alt+点击=上下拆分
  const openConn = (c: Conn, e?: { shiftKey: boolean; altKey: boolean }) => {
    if (e?.shiftKey) openSplit(c, "h");
    else if (e?.altKey) openSplit(c, "v");
    else openTab({ ...c });
  };
  const mkPane = (c: Conn): PNode => ({ id: paneId(), leaf: true, conn: c });   // paneId=模块级 uuid
  const [paneFocus, setPaneFocus] = useState<Record<string, string>>({});   // tabKey → 焦点面板 id
  // 拆分登入:当前激活 tab 的焦点面板处插入新面板;无激活 tab 则普通新 tab
  const openSplit = (c: Conn, dir: "h" | "v") => {
    setPicker(false); setCtx(null);
    const k = active;
    const cur = tabs.find(t => tkey(t) === k);
    if (!cur) { openTab({ ...c }); return; }
    const fresh = mkPane(c);
    setTabs(ts => ts.map(t => {
      if (tkey(t) !== k) return t;
      if (!t.root) {
        const old = mkPane({ target: t.target, ctn: t.ctn, engine: t.engine, session: t.session });
        return { ...t, root: { id: `s${old.id}-${fresh.id}`, leaf: false, dir, ratio: 0.5, kids: [old, fresh] } };
      }
      const at = paneFocus[k] || firstLeaf(t.root).id;
      return { ...t, root: insertSplit(t.root, at, dir, fresh) };
    }));
    setPaneFocus(f => ({ ...f, [k]: fresh.id }));
  };
  // 关面板:摘到只剩一个 leaf 时树退化为单面板(回到 TermTab 全功能);全空=关 tab
  const closePane = (k: string, paneId: string) => {
    const cur = tabs.find(t => tkey(t) === k);
    if (!cur?.root) { closeTab(k); return; }
    const rest = removePane(cur.root, paneId);
    if (!rest) { closeTab(k); return; }
    if (rest.leaf) {
      // 退化为单面板:连接参数回到 tab 本体
      setTabs(ts => ts.map(t => tkey(t) === k
        ? { ...t, target: rest.conn.target, ctn: rest.conn.ctn, engine: rest.conn.engine, session: rest.conn.session, root: undefined }
        : t));
    } else {
      setTabs(ts => ts.map(t => tkey(t) === k ? { ...t, root: rest } : t));
      setPaneFocus(f => ({ ...f, [k]: firstLeaf(rest).id }));
    }
  };
  // 激活 tab 自动滚进可见区(tab 条可横滑,新开/切换时不再被滚出屏幕)
  useEffect(() => {
    if (!active) return;
    document.querySelector(`[data-tk="${CSS.escape(active)}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [active, tabs.length]);

  // tab 状态标:输出过=转圈(保持不停);静默 4s=呼吸(等确认);新输出 2s 后隐呼吸;切过去即全清
  const [live, setLive] = useState<Record<string, { busy?: boolean; idle?: boolean }>>({});
  const markBusy = (k: string) => setLive(s => s[k]?.busy ? s : { ...s, [k]: { ...s[k], busy: true } });   // 判重:高频输出不重渲染
  const markIdle = (k: string) => setLive(s => s[k]?.idle ? s : { ...s, [k]: { ...s[k], idle: true } });
  const markWake = (k: string) => setLive(s => s[k]?.idle ? { ...s, [k]: { ...s[k], idle: false } } : s);
  useEffect(() => {
    if (!active) return;
    setLive(s => active in s ? Object.fromEntries(Object.entries(s).filter(([x]) => x !== active)) : s);
  }, [active]);

  // tab 拖动排序(dnd 式:pointer 手势,tab 跟随指针,其余实时平移让位)
  // 桌面=移 6px 激活;触屏=长按 380ms 激活(避开 tab 条横滑);松手落位。
  type DragState = { k: string; from: number; x: number; target: number };
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const rectsRef = useRef<{ center: number; w: number }[]>([]);
  const pressRef = useRef<{ id: number; k: string; from: number; startX: number; armed: boolean; timer: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDragState] = useState<DragState | null>(null);
  const setDrag = (d: DragState | null) => { dragRef.current = d; setDragState(d); };
  const reorderIdx = (from: number, to: number) => setTabs(ts => {
    if (from < 0 || to < 0 || from === to || from >= ts.length || to >= ts.length) return ts;
    const nx = [...ts];
    const [moved] = nx.splice(from, 1);
    nx.splice(to, 0, moved);
    return nx;
  });
  const measureRects = () => {
    const rs: { center: number; w: number; left: number }[] = [];
    tabRefs.current.forEach(el => { const r = el.getBoundingClientRect(); rs.push({ center: r.left + r.width / 2, w: r.width, left: r.left }); });
    rs.sort((a, b) => a.left - b.left);
    return rs;
  };
  const armDrag = () => {
    const p = pressRef.current;
    if (!p || p.armed) return;
    p.armed = true;
    if (p.timer) clearTimeout(p.timer);
    rectsRef.current = measureRects();
    setDrag({ k: p.k, from: p.from, x: 0, target: p.from });
    suppressClick.current = true;
  };
  const onTabPointerDown = (e: React.PointerEvent, k: string, from: number) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pressRef.current = { id: e.pointerId, k, from, startX: e.clientX, armed: false, timer: 0 };
    if (e.pointerType === "touch") {
      pressRef.current.timer = window.setTimeout(() => { armDrag(); navigator.vibrate?.(30); }, 380);
    }
  };
  const onTabPointerMove = (e: React.PointerEvent) => {
    const p = pressRef.current;
    if (!p || p.armed || e.pointerId !== p.id) return;
    const dx = Math.abs(e.clientX - p.startX);
    if (e.pointerType === "mouse" && dx > 6) armDrag();
    else if (e.pointerType === "touch" && dx > 12) { if (p.timer) clearTimeout(p.timer); pressRef.current = null; }   // 手指先滑了:让给容器横滚
  };
  // 拖拽激活后 move/up 全挂 window(不依赖元素命中/捕获,松手必达)
  useEffect(() => {
    if (!drag) return;
    const mv = (e: PointerEvent) => {
      const p = pressRef.current, d = dragRef.current;
      if (!p || !d) return;
      const x = e.clientX - p.startX;
      const rects = rectsRef.current;
      const centers = rects.map(r => r.center);
      const dc = centers[d.from] + x;
      let target = d.from;
      if (x > 0) { for (let i = rects.length - 1; i > d.from; i--) if (dc > centers[i]) { target = i; break; } }
      else if (x < 0) { for (let i = 0; i < d.from; i++) if (dc < centers[i]) { target = i; break; } }
      setDrag({ ...d, x, target });
    };
    const up = () => {
      const p = pressRef.current, d = dragRef.current;
      if (p?.timer) clearTimeout(p.timer);
      if (p && d) reorderIdx(d.from, d.target);
      pressRef.current = null;
      setDrag(null);
      setTimeout(() => { suppressClick.current = false; }, 50);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);
  // 拖拽中的触摸滚动拦截(否则浏览器把横向手势抢去滚 tab 条)
  useEffect(() => {
    const tm = (e: TouchEvent) => { if (dragRef.current) e.preventDefault(); };
    document.addEventListener("touchmove", tm, { passive: false, capture: true });
    return () => document.removeEventListener("touchmove", tm);
  }, []);

  const closeTab = (k: string) => setTabs(ts => {
    const idx = ts.findIndex(t => tkey(t) === k);
    const nx = ts.filter(t => tkey(t) !== k);
    if (active === k) setActive(nx.length ? tkey(nx[Math.min(idx, nx.length - 1)]) : null);
    return nx;
  });

  // 右键菜单:点外/Esc 关
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setCtx(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [ctx]);
  useEffect(() => {
    if (!ctx || !menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    if (r.bottom > innerHeight) menuRef.current.style.top = `${Math.max(8, innerHeight - r.height - 8)}px`;
    if (r.right > innerWidth) menuRef.current.style.left = `${Math.max(8, innerWidth - r.width - 8)}px`;
  }, [ctx]);

  const engOf = (name: string) => {
    const n = open[name];
    return n && n !== "loading" ? n.engine : "";
  };

  const hostMenu = async (e: React.MouseEvent, t: Target, ctn?: string) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, t, ctn, sessions: "loading" });
    const base = ctn
      ? `/api/t/target/${encodeURIComponent(t.name)}/tmux?ctn=${encodeURIComponent(ctn)}${engOf(t.name) ? `&engine=${engOf(t.name)}` : ""}`
      : `/api/t/target/${encodeURIComponent(t.name)}/tmux`;
    try {
      const r = await api<{ sessions: string[] }>(base);
      setCtx(c => c && c.t.name === t.name && c.ctn === ctn ? { ...c, sessions: r.sessions || [] } : c);
    } catch { setCtx(c => c && c.t.name === t.name && c.ctn === ctn ? { ...c, sessions: [] } : c); }
  };

  const loadHost = async (name: string) => {
    if (treeLoading.current.has(name)) return;   // StrictMode 双跑防重
    treeLoading.current.add(name);
    setOpen(o => ({ ...o, [name]: "loading" }));
    try {
      const r = await api<{ engine?: string; containers: Ctn[] }>(`/api/t/target/${encodeURIComponent(name)}/containers`);
      setOpen(o => ({ ...o, [name]: { engine: r.engine || "", list: r.containers } }));
      persistOpen(s => { s[name] = r.engine || ""; });
    } catch (e) {
      setOpen(o => { const n = { ...o }; delete n[name]; return n; });
      persistOpen(s => { delete s[name]; });
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      treeLoading.current.delete(name);
    }
  };
  const toggle = (name: string) => {
    if (open[name]) {
      setOpen(o => { const n = { ...o }; delete n[name]; return n; });
      persistOpen(s => { delete s[name]; });
      return;
    }
    loadHost(name);
  };
  // 恢复:刷新前展开着的主机重新拉容器
  useEffect(() => { Object.keys(open).forEach(n => { if (open[n] === "loading") loadHost(n); }); }, []);

  const killSess = async (t: Target, ctn: string | undefined, sess: string) => {
    const eng = ctn ? engOf(t.name) : "";
    const url = ctn
      ? `/api/t/target/${encodeURIComponent(t.name)}/tmux/kill?session=${encodeURIComponent(sess)}&ctn=${encodeURIComponent(ctn)}${eng ? `&engine=${eng}` : ""}`
      : `/api/t/target/${encodeURIComponent(t.name)}/tmux/kill?session=${encodeURIComponent(sess)}`;
    try {
      await api(url, { method: "POST" });
      setCtx(c => c && c.t.name === t.name && c.ctn === ctn && Array.isArray(c.sessions)
        ? { ...c, sessions: c.sessions.filter(x => x !== sess) } : c);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
  };

  // 目标 CRUD
  const saveEdit = async () => {
    if (!edit) return;
    // ssh 命令模式:解析出 addr/port/user 再存
    let { addr, port, user } = edit;
    if (edit.mode === "cmd") {
      const r = parseSshCmd(edit.cmd);
      if (!r.addr) { toast("ssh 命令里没解析到主机", true); return; }
      addr = r.addr; port = r.port || ""; user = r.user || "";
    }
    try {
      await api("/api/t/targets", { method: "POST", body: JSON.stringify({ name: edit.name, addr, port, user, note: edit.note }) });
      toast(t("已保存")); setEdit(null); loadTargets();
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
  };
  const delTarget = async (t: Target) => {
    if (!confirm(`删除目标「${t.name}」?(仅删除本工具的配置条目,不动 ~/.ssh/config)`)) return;
    try { await api(`/api/t/targets/${encodeURIComponent(t.name)}`, { method: "DELETE" }); toast("已删除"); loadTargets(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
  };

  const shown = useMemo(() => targets || [], [targets]);

  useEffect(() => {
    const de = document.documentElement, bd = document.body;
    de.style.overflow = "hidden"; bd.style.overflow = "hidden";
    return () => { de.style.overflow = ""; bd.style.overflow = ""; };
  }, []);

  // 目标树渲染:左栏与 tab 头下拉选择器共用一份;展开状态各自独立(下拉里展开不影响左栏)
  const renderTree = (tree: typeof open, g: typeof grp, tog: (n: string) => void, eng: (n: string) => string, setG: typeof setGrp) => shown.map(hst => {
    const node = tree[hst.name];
    const cts = node === "loading" ? node : node?.list;
    const st = alive[hst.name] == null ? "text-muted-foreground" : alive[hst.name] ? "text-emerald-500" : "text-muted-foreground/35";
    return (
      <div key={hst.name}>
        <div className="group flex items-center">
          <button onClick={() => tog(hst.name)} title="展开/收起容器"
            className="flex h-7 w-6 shrink-0 items-center justify-center text-muted-foreground/70 hover:text-foreground">
            {cts === "loading"
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <ChevronRight className={cn("h-4 w-4 transition-transform", Array.isArray(cts) && "rotate-90")} />}
          </button>
          <button onClick={() => tog(hst.name)}
            onContextMenu={e => hostMenu(e, hst)}
            title={`${hst.name}${hst.addr ? ` · ${hst.addr}` : ""}${hst.note ? ` · ${hst.note}` : ""}(左键展开容器,右键选择连接方式)`}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-1 pr-1 text-left transition-colors hover:bg-muted">
            {hst.kind === "local"
              ? <HardDrive className={cn("h-4 w-4 shrink-0", st)} />
              : <Server className={cn("h-4 w-4 shrink-0", st)} />}
            <span className="min-w-0 flex-1 truncate">{hst.name}</span>
            {hst.source === "toml" && (
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                <button title="编辑" onClick={e => { e.stopPropagation(); setEdit({ name: hst.name, addr: hst.addr === "local" ? "" : hst.addr, port: t.port || "", note: hst.note, isNew: false, mode: "addr", cmd: "" }); }}
                  className="rounded p-0.5 text-muted-foreground/60 hover:text-foreground"><Pencil className="h-3 w-3" /></button>
                <button title="删除" onClick={e => { e.stopPropagation(); delTarget(t); }}
                  className="rounded p-0.5 text-muted-foreground/60 hover:text-red-500"><Trash2 className="h-3 w-3" /></button>
              </span>
            )}
          </button>
        </div>
        {Array.isArray(cts) && (() => {
          const ctnBtn = (c: Ctn, pl: string) => (
            <button key={c.name}
              onContextMenu={e => hostMenu(e, hst, c.name)}
              title={`${eng(hst.name) === "podman" ? "podman" : "docker"} · ${c.image}${c.running ? "" : "(未运行)"} · 右键登入`}
              className={cn("flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left transition-colors hover:bg-muted", pl)}>
              {eng(hst.name) === "podman"
                ? <Box className="h-4 w-4 shrink-0 text-muted-foreground" />
                : <Container className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", c.running ? "bg-emerald-500" : "bg-zinc-400")} />
            </button>
          );
          const groups = [...new Set(cts.filter(c => c.compose).map(c => c.compose!))]
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
          return (<>
            {groups.map(p => {
              const members = cts.filter(c => c.compose === p);
              const gk = `${hst.name}::${p}`, gOpen = g[gk] !== false;
              return (
                <div key={p}>
                  <button onClick={() => setG(v => ({ ...v, [gk]: !gOpen }))}
                    title={`compose 项目 ${p}(点击折叠/展开)`}
                    className="flex w-full items-center gap-1 rounded-lg py-1.5 pl-1 pr-2 text-left transition-colors hover:bg-muted">
                    <span className="flex h-7 w-6 shrink-0 items-center justify-center text-muted-foreground/70">
                      <ChevronRight className={cn("h-4 w-4 transition-transform", gOpen && "rotate-90")} />
                    </span>
                    <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{p}</span>
                    <span className="mr-1 shrink-0 rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">{members.length}</span>
                  </button>
                  {gOpen && members.map(c => ctnBtn(c, "pl-12"))}
                </div>
              );
            })}
            {cts.filter(c => !c.compose).map(c => ctnBtn(c, "pl-7"))}
          </>);
        })()}
        {Array.isArray(cts) && !cts.length && (
          <div className="py-1 pl-8 text-[12px] text-muted-foreground/70">{t("无容器(docker/podman)")}</div>
        )}
      </div>
    );
  });

  const item = (label: string, icon: React.ReactNode, fn: (e: React.MouseEvent) => void) => (
    <button onClick={e => { setCtx(null); fn(e); }}
      className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent">
      {icon}<span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
  const sessItem = (tg: Target, ctn: string | undefined, sess: string) => (
    <div className="flex items-center">
      <button onClick={e => { setCtx(null); openConn({ target: tg.name, ctn, engine: ctn ? engOf(tg.name) || undefined : undefined, session: sess }, e); }}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent">
        <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{sess}</span>
      </button>
      <button title={t("关闭会话")} onClick={() => killSess(tg, ctn, sess)}
        className="mr-1 shrink-0 cursor-pointer rounded p-1 text-muted-foreground/60 hover:bg-accent hover:text-red-500">
        <X className="h-3 w-3" />
      </button>
    </div>
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {/* tab 条 + 各 tab 三栏(左栏已撤:主机树入口=tab 头下拉 ∨) */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-stretch border-b border-border/70 bg-card">
          {/* tab 区:横向滑动(手机一屏放不下几个),+ / ∨ 固定右侧不随滚 */}
          <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tb, idx) => {
            const k = tkey(tb);
            const name = targets?.find(x => x.name === tb.target)?.name || tb.target;
            const isDragged = drag?.k === k;
            const shift = (() => {
              if (!drag || isDragged) return 0;
              const w = rectsRef.current[drag.from]?.w ?? 0;
              if (drag.from < drag.target && idx > drag.from && idx <= drag.target) return -w;
              if (drag.from > drag.target && idx >= drag.target && idx < drag.from) return w;
              return 0;
            })();
            return (
              <div key={k} data-tk={k}
                ref={el => { if (el) tabRefs.current.set(k, el); else tabRefs.current.delete(k); }}
                onClick={() => { if (suppressClick.current) return; setActive(k); }}
                onPointerDown={e => onTabPointerDown(e, k, idx)}
                onPointerMove={onTabPointerMove}
                onPointerUp={() => {
                  const p = pressRef.current;
                  if (p && !p.armed) { if (p.timer) clearTimeout(p.timer); pressRef.current = null; }   // 未激活的普通点按:清按压状态
                }}
                onContextMenu={e => { e.preventDefault(); setTabCtx({ x: e.clientX, y: e.clientY, k }); }}
                style={isDragged
                  ? { transform: `translateX(${drag!.x}px)`, zIndex: 10, position: "relative" as const }
                  : shift ? { transform: `translateX(${shift}px)`, transition: "transform 150ms" } : undefined}
                className={cn("group/tab flex shrink-0 cursor-pointer touch-pan-x select-none items-center gap-1.5 border-r border-border/60 px-3 text-[13px]",
                  active === k ? "bg-background font-medium" : "text-muted-foreground hover:bg-accent/50")}
                title={`${name}${tb.ctn ? ` · ${tb.ctn}` : ""}${tb.session ? ` · tmux:${tb.session}` : ""}`}>
                <span className="flex max-w-52 items-center gap-1 truncate">
                  {active !== k && (live[k]?.idle
                    ? <span title={t("已静默(干完/等确认)")} className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-red-500" />
                    : live[k]?.busy
                      ? <span title={t("运行中")} className="h-1.5 w-1.5 shrink-0 animate-spin rounded-full border-2 border-red-500/70 border-t-transparent" />
                      : null)}
                  {tb.ctn ?? name}
                  {tb.session && <><span className="text-muted-foreground/60">·</span><span className="truncate text-muted-foreground">{tb.session}</span></>}
                </span>
                {tb.engine && tb.engine !== "auto" && <span className="rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground" title={`引擎:${tb.engine}`}>{tb.engine === "docker" ? "dk" : "pm"}</span>}
                {tb.session && <span className="rounded bg-muted px-1 text-[10px] font-semibold leading-4 text-muted-foreground" title="tmux 会话">T</span>}
                {tb.root && <span className="rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground" title={`分屏(${leafCount(tb.root)} 面板)`}>⊞{leafCount(tb.root)}</span>}
                <button className="rounded p-0.5 opacity-30 hover:bg-accent hover:opacity-100"
                  onClick={e => { e.stopPropagation(); closeTab(k); }}
                  title={t("关闭(tmux 会话仍在目标机运行)")}>
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          {/* Windows Terminal 式:+=新标签登录本机;下拉=主机选择器(左栏的对话框版)。
              放滚动容器内紧跟最后一个 tab(容器不占满整行,按钮不被顶到最右) */}
          <div data-picker ref={pickRef} className="relative flex shrink-0 items-center gap-0.5 px-1.5">
            <button title={t("新标签:登录本机")} onClick={() => openTab({ target: "local" })}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <Plus className="h-4 w-4" />
            </button>
            <button title={t("选择主机登录(左键展开,右键连接)")} onClick={togglePicker}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <ChevronDown className="h-4 w-4" />
            </button>
            {picker && pickPos && (
              <div data-picker
                className="thin-scroll fixed z-50 max-h-[70vh] w-72 max-w-[calc(100vw-16px)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
                style={{ left: pickPos.left, top: pickPos.top }}>
                <div className="px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground">{t("主机 / 容器(右键选择连接方式)")}</div>
                {targets == null && <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("加载目标…")}</div>}
                {renderTree(pOpen, pGrp, pToggle, pEngOf, setPGrp)}
                <div className="mx-2 my-1 h-px bg-border/70" />
                <button onClick={openSshCfg}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent">
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground" /><span className="flex-1">{t("编辑 ssh config(登记主机)")}</span>
                </button>
                <button onClick={() => { setPicker(false); setAbout(true); }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent">
                  <Info className="h-3.5 w-3.5 text-muted-foreground" /><span className="flex-1">{t("关于")}</span>
                </button>
                <button onClick={() => { setPicker(false); switchLang(); }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent">
                  <Languages className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="flex-1">{curLang() === "zh" ? "English" : "中文"}</span>
                </button>
              </div>
            )}
          </div>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {!tabs.length && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-[#1e1e2e] text-sm text-zinc-400">
              <Terminal className="h-10 w-10 opacity-40" />
              右键左侧目标连接(SSH / tmux / 容器)
            </div>
          )}
          {tabs.map(t => t.root
            ? <SplitTab key={tkey(t)} tab={t} visible={active === tkey(t)}
                focus={paneFocus[tkey(t)]}
                onFocus={id => setPaneFocus(f => ({ ...f, [tkey(t)]: id }))}
                onClosePane={id => closePane(tkey(t), id)}
                onRatio={(sid, r) => setTabs(ts => ts.map(x => tkey(x) === tkey(t) ? { ...x, root: setRatioAt(x.root!, sid, r) } : x))}
                onPaneBusy={() => markBusy(tkey(t))} onPaneIdle={() => markIdle(tkey(t))} onPaneWake={() => markWake(tkey(t))} />
            : <TermTab key={tkey(t)} conn={t} keyId={tkey(t)} visible={active === tkey(t)} onClose={() => closeTab(tkey(t))}
                onBusy={() => markBusy(tkey(t))} onIdle={() => markIdle(tkey(t))} onWake={() => markWake(tkey(t))} />)}        </div>
      </div>

      {/* tab 头右键:关闭 / 全部关闭 */}
      {tabCtx && (
        <div onMouseDown={e => e.stopPropagation()}
          className="fixed z-50 min-w-36 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
          style={{ left: tabCtx.x, top: tabCtx.y }}>
          <button onClick={() => { setTabCtx(null); closeTab(tabCtx.k); }}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent">
            关闭
          </button>
          <button onClick={() => { setTabCtx(null); setTabs([]); setActive(null); }}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent">
            全部关闭
          </button>
        </div>
      )}

      {/* 右键连接菜单 */}
      {ctx && (
        <div ref={menuRef} onMouseDown={e => e.stopPropagation()}
          className="fixed z-50 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
          style={{ left: ctx.x, top: ctx.y }}>
          <div className="px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground">
            {ctx.ctn ? `${ctx.t.name} · ${ctx.ctn}` : ctx.t.name}
          </div>
          {item(t("SSH 登入"), ctx.ctn
            ? (engOf(ctx.t.name) === "podman" ? <Box className="h-3.5 w-3.5 text-muted-foreground" /> : <Box className="h-3.5 w-3.5 text-muted-foreground" />)
            : <Monitor className="h-3.5 w-3.5 text-muted-foreground" />,
            e => openConn(ctx.ctn
              ? { target: ctx.t.name, ctn: ctx.ctn, engine: engOf(ctx.t.name) || undefined }
              : { target: ctx.t.name }, e))}
          <div className="mx-2 my-1 h-px bg-border/70" />
          {ctx.sessions === "loading"
            ? <div className="flex items-center gap-2 px-2 py-1.5 text-[13px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("查 tmux 会话…")}</div>
            : <>
              {(ctx.sessions || []).map(s => sessItem(ctx.t, ctx.ctn, s))}
              {item(ctx.sessions?.length ? t("新建会话") : t("新建 tmux"), <Plus className="h-3.5 w-3.5 text-muted-foreground" />,
                e => openConn(ctx.ctn
                  ? { target: ctx.t.name, ctn: ctx.ctn, engine: engOf(ctx.t.name) || undefined, session: nextSession(ctx.sessions) }
                  : { target: ctx.t.name, session: nextSession(ctx.sessions) }, e))}
            </>}
          <div className="px-2 pb-0.5 pt-1 text-[10px] text-muted-foreground/70">{t("Shift+点击=左右拆分 · Alt+点击=上下拆分")}</div>
        </div>
      )}

      {/* 右侧监控栏(keeper 移植):主机资源卡 + URL 探针卡,可收起窄轨 */}
      <MonitorAside />

      {/* ssh config 编辑器 */}
      {sshCfg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={e => { if (e.target === e.currentTarget) setSshCfg(null); }}>
          <div className="flex h-[80vh] w-[60rem] max-w-[92vw] flex-col rounded-lg border border-border bg-card p-4 shadow-xl">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-medium">~/.ssh/config</span>
              <span className="text-[11px] text-muted-foreground">{t("主机列表数据源 · 保存后下拉列表即时刷新")}</span>
              <button onClick={() => setSshCfg(null)} className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden rounded border border-border/70">
              {sshCfg.loading
                ? <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("读取中…")}</div>
                : <CodeArea value={sshCfg.text} onChange={t => setSshCfg(s => s ? { ...s, text: t } : s)} onSave={saveSshCfg} />}
            </div>
            <div className="mt-3 flex justify-end gap-2 text-[13px]">
              <button onClick={() => setSshCfg(null)} className="rounded px-3 py-1.5 text-muted-foreground hover:bg-accent">{t("关闭")}</button>
              <button onClick={saveSshCfg} className="rounded bg-primary px-3 py-1.5 text-primary-foreground hover:opacity-90">{t("保存")}</button>
            </div>
          </div>
        </div>
      )}

      {/* 关于 */}
      {about && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={e => { if (e.target === e.currentTarget) setAbout(false); }}>
          <div className="w-[22rem] rounded-lg border border-border bg-card p-5 shadow-xl">
            <div className="flex flex-col items-center gap-2 text-center">
              <Monitor className="h-10 w-10 text-primary" />
              <span className="text-lg font-semibold tracking-wide">KeeTerm</span>
              <p className="text-[13px] text-muted-foreground">独立 Web 终端 · ssh config 即目标 · 容器 / tmux / 文件工作站</p>
              <p className="text-[11px] text-muted-foreground/70">作者 huangbin(hb9630)</p>
              <a href="https://github.com/hb9630/KeeTerm" target="_blank" rel="noreferrer"
                className="mt-1 text-[13px] text-primary hover:underline">使用手册 · github.com/hb9630/KeeTerm</a>
            </div>
          </div>
        </div>
      )}

      {/* 目标编辑(toml 条目) */}
      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={e => { if (e.target === e.currentTarget) setEdit(null); }}>
          <div className="w-88 w-[24rem] rounded-lg border border-border bg-card p-4 shadow-xl">
            <div className="mb-3 text-sm font-medium">{edit.isNew ? "登记目标" : `编辑 ${edit.name}`}</div>
            <div className="grid gap-2.5 text-[13px]">
              <label className="grid gap-1">名字(与 ~/.ssh/config 别名同名则直连)
                <input value={edit.name} disabled={!edit.isNew} onChange={e => setEdit({ ...edit, name: e.target.value })}
                  className="rounded border border-input bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-ring disabled:opacity-60" /></label>
              <label className="grid gap-1">连接方式
                <select value={edit.mode} onChange={e => setEdit({ ...edit, mode: e.target.value as "addr" | "cmd" })}
                  className="rounded border border-input bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-ring">
                  <option value="addr">地址 + 端口</option>
                  <option value="cmd">ssh 命令</option>
                </select></label>
              {edit.mode === "addr" ? (
                <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2">
                  <label className="grid gap-1">地址(留空=按名字走 ssh config)
                    <input value={edit.addr} onChange={e => setEdit({ ...edit, addr: e.target.value })} placeholder="IP 或 hostname"
                      className="w-full min-w-0 rounded border border-input bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-ring" /></label>
                  <label className="grid gap-1">端口
                    <input value={edit.port} onChange={e => setEdit({ ...edit, port: e.target.value })} placeholder="22"
                      className="w-full min-w-0 rounded border border-input bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-ring" /></label>
                </div>
              ) : (
                <label className="grid gap-1">粘贴 ssh 命令(解析出地址/端口/用户)
                  <input value={edit.cmd} onChange={e => setEdit({ ...edit, cmd: e.target.value })} placeholder="ssh -p 2222 root@192.168.1.10"
                    className="rounded border border-input bg-background px-2 py-1.5 font-mono text-[12.5px] outline-none focus:ring-1 focus:ring-ring" /></label>
              )}
              <label className="grid gap-1">备注
                <input value={edit.note} onChange={e => setEdit({ ...edit, note: e.target.value })}
                  className="rounded border border-input bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-ring" /></label>
            </div>
            <p className="text-[11px] text-muted-foreground">需要密码的主机连接时会在终端里提示输入,无需在此预存</p>
            <div className="mt-4 flex justify-end gap-2 text-[13px]">
              <button onClick={() => setEdit(null)} className="rounded px-3 py-1.5 text-muted-foreground hover:bg-accent">{t("取消")}</button>
              <button onClick={saveEdit} className="rounded bg-primary px-3 py-1.5 text-primary-foreground hover:opacity-90">{t("保存")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* 分屏 tab:递归面板树(leaf=完整 TermTab:终端+预览+文件树,按连接键共享记忆;
   split=左右/上下 + 可拖比例分隔条);面板 hover 出 ×;Ctrl+D 关面板;
   摘到单面板退化回 TermTab(保持全功能) */
function SplitTab({ tab, visible, focus, onFocus, onClosePane, onRatio, onPaneBusy, onPaneIdle, onPaneWake }: {
  tab: Tab; visible: boolean; focus?: string;
  onFocus: (id: string) => void; onClosePane: (id: string) => void; onRatio: (splitId: string, r: number) => void;
  onPaneBusy?: () => void; onPaneIdle?: () => void; onPaneWake?: () => void;
}) {
  const view = (n: PNode): React.ReactNode => {
    if (n.leaf) {
      return (
        <div key={n.id}
          className={cn("group/pane relative flex min-h-0 min-w-0 flex-1",
            focus === n.id && "ring-1 ring-inset ring-sky-500/60")}
          onPointerDownCapture={() => onFocus(n.id)}>
          <TermTab conn={n.conn} keyId={connKeyId(n.conn)} visible={visible} pane
            onClose={() => onClosePane(n.id)}
            onBusy={onPaneBusy} onIdle={onPaneIdle} onWake={onPaneWake} />
          {/* 未激活面板蒙一层薄纱:可辨但不影响阅读输出(不挡交互) */}
          {focus !== n.id && <div className="pointer-events-none absolute inset-0 z-10 bg-black/20" />}
        </div>
      );
    }
    const horiz = n.dir === "h";
    return (
      <div key={n.id} className={cn("flex min-h-0 min-w-0 flex-1", horiz ? "flex-row" : "flex-col")}>
        <div className="flex min-h-0 min-w-0" style={{ flex: `1 1 ${n.ratio * 100}%` }}>{view(n.kids[0])}</div>
        <div className={cn("shrink-0 bg-white/10 hover:bg-primary/60", horiz ? "w-[3px] cursor-col-resize" : "h-[3px] cursor-row-resize")}
          onPointerDown={e => {
            e.preventDefault();
            const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
            const x0 = e.clientX, y0 = e.clientY, r0 = n.ratio;
            const move = (ev: PointerEvent) => {
              const total = Math.max(1, (horiz ? box.width : box.height) - 3);
              const d = (horiz ? ev.clientX - x0 : ev.clientY - y0) / total;
              onRatio(n.id, Math.min(0.85, Math.max(0.15, r0 + d)));
            };
            const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }} />
        <div className="flex min-h-0 min-w-0" style={{ flex: `1 1 ${(1 - n.ratio) * 100}%` }}>{view(n.kids[1])}</div>
      </div>
    );
  };
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[#1e1e2e]", !visible && "hidden")}>
      {view(tab.root!)}
    </div>
  );
}

/* 终端面板:终端|预览|文件树(最右);首激活才连接;后台 hidden 不断线。
   树/预览按 keyId(=连接键)记忆:同一连接在多个 tab/面板间共享工作目录与预览清单。
   单面板 tab 与分屏面板共用此组件——分屏面板同样是完整三栏,不丢文件树/预览。 */
const connKeyId = (c: Conn) => `${c.target}${c.ctn ? `:${c.ctn}@${c.engine || "auto"}` : ""}${c.session ? `:T:${c.session}` : ""}`;
// 面板 id 用 uuid(计数器重启会与恢复的旧树撞名 → insertSplit 匹配多处=面板插两处);
// 公网 http 非安全上下文无 crypto.randomUUID,兜底时间戳+随机
const paneId = () => (typeof crypto !== "undefined" && crypto.randomUUID)
  ? crypto.randomUUID()
  : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
/** 树整体重赋 id:恢复持久化 tab 时净化历史脏数据(旧计数器 bug 可能留下重复 id=焦点/遮罩同时命中两块) */
const reidTree = (n: PNode): PNode =>
  n.leaf ? { ...n, id: paneId() } : { ...n, id: paneId(), kids: [reidTree(n.kids[0]), reidTree(n.kids[1])] };
function TermTab({ conn, keyId, visible, onClose, onBusy, onIdle, onWake, pane }: { conn: Conn; keyId: string; visible: boolean; onClose: () => void; onBusy?: () => void; onIdle?: () => void; onWake?: () => void; pane?: boolean }) {
  const { target, ctn, engine, session } = conn;
  const enc = encodeURIComponent;
  // 树根(当前工作目录):按连接记忆,刷新不回 HOME
  const [root, setRoot] = useState<string | null>(() => {
    try { return JSON.parse(localStorage.getItem(`tg_root:${keyId}`) || "null"); } catch { return null; }
  });
  const [started, setStarted] = useState(visible);
  useEffect(() => { if (visible) setStarted(true); }, [visible]);

  // 本面板布局:树开合/宽、预览宽
  const tk = keyId;
  const [ui, setUi] = useState(() => {
    let s: any = {};
    try { s = JSON.parse(localStorage.getItem(`tg_tabui:${tk}`) || "{}"); } catch { /* */ }
    return {
      treeOpen: window.innerWidth < 768 ? false : s.treeOpen !== false,
      treeW: s.treeW >= 180 && s.treeW <= 480 ? s.treeW : 260,
      pvW: s.pvW >= 320 && s.pvW <= 2400 ? s.pvW : 520,
    };
  });
  useEffect(() => { localStorage.setItem(`tg_tabui:${tk}`, JSON.stringify(ui)); }, [ui]);

  // apiBase 必须纯路径(Explorer 拼 ?path):engine 并进 ctn 段(ctn@engine),不走 query
  const ctnSeg = ctn ? `${ctn}${engine ? `@${engine}` : ""}` : "";
  const fsPath = ctnSeg
    ? `/api/t/target/${enc(target)}/ctn/${enc(ctnSeg)}/fs`
    : `/api/t/target/${enc(target)}/fs`;
  const base = fsPath;

  useEffect(() => { if (!started || root != null) return; (async () => {
    // 树根:优先用记忆的当前工作目录,没记过才回远端 HOME
    try {
      const r = await api<{ home: string }>(`${fsPath}/home`);
      setRoot(r.home || "/");
    } catch { setRoot("/"); }
  })(); }, [started, fsPath]);

  const wsPath = `/api/t/ws?target=${enc(target)}`
    + (ctn ? `&ctn=${enc(ctn)}${engine ? `&engine=${enc(engine)}` : ""}` : "")
    + (session ? `&session=${enc(session)}` : "");
  const canTree = !ctn || true;   // 容器也有文件树(exec 通道);Windows local 由后端报错提示

  // 预览区:文件清单+当前项(刷新恢复清单,内容按 path 回拉)
  const [pvTabs, setPvTabs] = useState<PvTab[]>(() => {
    try {
      const s = JSON.parse(localStorage.getItem(`tg_pv:${tk}`) || "null");
      if (s?.tabs?.length) return (s.tabs as { path: string; name: string; kind: string }[]).map(t => ({ path: t.path, name: t.name, kind: t.kind }));
    } catch { /* */ }
    return [];
  });
  const [pvCur, setPvCur] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`tg_pv:${tk}`) || "null")?.cur || ""; } catch { return ""; }
  });
  useEffect(() => {
    localStorage.setItem(`tg_pv:${tk}`, JSON.stringify({ tabs: pvTabs.map(t => ({ path: t.path, name: t.name, kind: t.kind })), cur: pvCur }));
  }, [pvTabs, pvCur]);

  const dlRemote = (path: string) => {
    (async () => {
      try {
        const r = await fetch(`${fsPath}/download?path=${enc(path)}`);
        if (!r.ok) throw new Error(String(r.status));
        const u = URL.createObjectURL(await r.blob());
        const a = document.createElement("a");
        a.href = u; a.download = path.split("/").pop() || "file"; a.click();
        setTimeout(() => URL.revokeObjectURL(u), 5000);
      } catch { toast("下载失败", true); }
    })();
  };

  const fetchPv = (p: string, kind: string) => {
    (async () => {
      try {
        const r = await fetch(`${fsPath}/download?path=${enc(p)}`);
        if (!r.ok) throw new Error(String(r.status));
        const blob = await r.blob();
        const body = kind === "text" || kind === "md"
          ? { text: await blob.slice(0, 512 * 1024).text() }
          : { url: URL.createObjectURL(blob) };
        setPvTabs(ts => ts.map(t => t.path === p ? { ...t, ...body } : t));
      } catch { setPvTabs(ts => ts.map(t => t.path === p ? { ...t, err: true } : t)); }
    })();
  };
  // 恢复的预览 tab(有清单没内容)自动回拉
  useEffect(() => {
    if (!started) return;
    pvTabs.forEach(t => { if (t.text == null && !t.url && !t.err) fetchPv(t.path, t.kind); });
  }, [started, pvTabs]);

  const openFile = (p: string) => {
    const name = p.split("/").pop() || p;
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const kind =
      ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"].includes(ext) ? "image"
      : ext === "html" || ext === "htm" ? "html"
      : ext === "pdf" ? "pdf"
      : ["md", "markdown", "mdown"].includes(ext) ? "md"
      : ["txt", "json", "js", "mjs", "ts", "tsx", "jsx", "py", "sh", "bash", "yml", "yaml", "toml",
        "ini", "conf", "cfg", "log", "csv", "xml", "css", "go", "rs", "c", "h", "cpp", "sql", "env", "lock",
        "service", "dockerfile", "gitignore", "properties"].includes(ext) || !name.includes(".") ? "text"
      : "";
    if (!kind) { dlRemote(p); return; }
    setPvTabs(ts => ts.some(t => t.path === p) ? ts : [...ts, { path: p, name, kind }]);
    setPvCur(p);
  };

  const closePv = (p: string) => {
    const idx = pvTabs.findIndex(t => t.path === p);
    if (pvTabs[idx]?.url) URL.revokeObjectURL(pvTabs[idx].url!);
    const nx = pvTabs.filter(t => t.path !== p);
    setPvTabs(nx);
    if (pvCur === p) setPvCur(nx.length ? nx[Math.min(idx, nx.length - 1)].path : "");
  };
  const closeAllPv = () => {
    pvTabs.forEach(t => t.url && URL.revokeObjectURL(t.url!));
    setPvTabs([]); setPvCur("");
  };
  // 预览器文件 tab 右键:关闭 / 全部关闭
  const [pvCtx, setPvCtx] = useState<{ x: number; y: number; path: string } | null>(null);
  useEffect(() => {
    if (!pvCtx) return;
    const close = () => setPvCtx(null);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setPvCtx(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [pvCtx]);

  // 简易编辑器:文本/md 可切编辑态(草稿存 tab 项上),保存=整文件写回
  const startEdit = (t: PvTab) => setPvTabs(ts => ts.map(x => x.path === t.path ? { ...x, edit: x.text ?? "" } : x));
  const stopEdit = (t: PvTab) => {
    if (t.edit !== t.text && !confirm("放弃未保存的修改?")) return;
    setPvTabs(ts => ts.map(x => x.path === t.path ? { ...x, edit: undefined } : x));
  };
  const savePv = (t: PvTab) => {
    if (t.edit == null) return;
    const content = t.edit;
    (async () => {
      try {
        await api(`${fsPath}/save`, { method: "POST", body: JSON.stringify({ path: t.path, content }) });
        setPvTabs(ts => ts.map(x => x.path === t.path ? { ...x, text: content } : x));
        toast(t("已保存"));
      } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
    })();
  };

  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background", !visible && "hidden")}>
      <div className="relative flex h-full min-w-0 flex-1 flex-col bg-[#1e1e2e]">
        {(canTree || pane) && (
          <div className="absolute right-2 top-2 z-20 flex gap-1">
            {canTree && (
              <button onClick={() => setUi(u => ({ ...u, treeOpen: !u.treeOpen }))} title={ui.treeOpen ? t("收起文件树") : t("展开文件树")}
                className={cn("rounded-md border border-white/10 bg-zinc-900/80 p-1 transition-opacity",
                  ui.treeOpen ? "text-zinc-100 opacity-100" : "text-zinc-400 opacity-60 hover:text-zinc-100 hover:opacity-100")}>
                <FolderTree className="h-3.5 w-3.5" />
              </button>
            )}
            {pane && (
              <button onClick={onClose} title={t("关闭此面板")}
                className="rounded-md border border-white/10 bg-zinc-900/80 p-1 text-zinc-400 transition-opacity opacity-60 hover:text-red-400 hover:opacity-100">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        {!started
          ? <div className="flex flex-1 items-center justify-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />待激活…</div>
          : <TermView active={visible} onClose={onClose} onBusy={onBusy} onIdle={onIdle} onWake={onWake} wsPath={wsPath} uiOffset={pane ? 64 : 34} />}
      </div>

      {pvTabs.length > 0 && (() => {
        const cur = pvTabs.find(t => t.path === pvCur) || pvTabs[pvTabs.length - 1];
        return (<>
          <div className="h-full w-1 shrink-0 cursor-col-resize bg-card"
            title={t("拖动调整预览区宽度")}
            onPointerDown={e => {
              e.preventDefault();
              const x0 = e.clientX, w0 = ui.pvW;
              const mv = (ev: PointerEvent) => setUi(u => ({ ...u, pvW: Math.min(window.innerWidth - 300, Math.max(320, w0 - (ev.clientX - x0))) }));
              const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
              window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
            }} />
          <div className="flex h-full min-w-0 shrink-0 flex-col border-r border-border/70 bg-card" style={{ width: ui.pvW }}>
            <div className="flex h-9 shrink-0 items-stretch gap-0 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {pvTabs.map(t => (
                <div key={t.path} title={t.path}
                  onContextMenu={e => { e.preventDefault(); setPvCtx({ x: e.clientX, y: e.clientY, path: t.path }); }}
                  className={cn("group/tab flex shrink-0 cursor-pointer items-center gap-1 border-r border-border/60 px-2.5 text-[13px]",
                    t.path === cur.path ? "bg-background font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50")}
                  onClick={() => setPvCur(t.path)}>
                  <span className="max-w-40 truncate">{t.name}</span>
                  <button className="rounded p-0.5 opacity-40 hover:bg-accent hover:opacity-100"
                    onClick={e => { e.stopPropagation(); closePv(t.path); }}>
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <span className="ml-auto flex shrink-0 items-center self-center">
                {["text", "md"].includes(cur.kind) && (cur.edit != null ? (<>
                  <button title={t("保存(Ctrl+S)")} onClick={() => savePv(cur)}
                    className={cn("rounded px-1.5 py-0.5 text-[12px] hover:bg-accent", cur.edit !== cur.text ? "font-medium text-primary hover:text-primary" : "text-muted-foreground hover:text-foreground")}>
                    保存
                  </button>
                  <button title={t("切回预览")} onClick={() => stopEdit(cur)}
                    className="rounded px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground">
                    预览
                  </button>
                </>) : (
                  <button title={t("编辑此文件")} onClick={() => startEdit(cur)}
                    className="rounded px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground">
                    编辑
                  </button>
                ))}
                <button className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title={t("下载当前文件")} onClick={() => dlRemote(cur.path)}>
                  <Download className="h-3.5 w-3.5" />
                </button>
                <button className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-red-500"
                  title={t("关闭预览区")} onClick={closeAllPv}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background">
              {cur.err && <span className="text-sm text-destructive">{t("读取失败")}</span>}
              {cur.text == null && !cur.url && !cur.err && <span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("加载中…")}</span>}
              {cur.edit != null ? (
                <Suspense fallback={<span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载编辑器…</span>}>
                  <CodeArea key={cur.path} value={cur.edit}
                    onChange={v => setPvTabs(ts => ts.map(x => x.path === cur.path ? { ...x, edit: v } : x))}
                    onSave={() => savePv(cur)} />
                </Suspense>
              ) : cur.text != null && (cur.kind === "md"
                ? <div className="h-full w-full overflow-auto p-4"><Markdown text={cur.text}
                    resolveImg={u => {
                      // 相对路径按 md 所在目录换算成远端下载 URL(同源带 cookie)
                      if (/^(https?:|data:)/.test(u)) return u;
                      let p = u.split("#")[0].split("?")[0];
                      if (!p.startsWith("/")) {
                        const dir = cur.path.slice(0, cur.path.lastIndexOf("/"));
                        p = `${dir}/${p}`;
                      }
                      const parts: string[] = [];
                      for (const seg of p.split("/")) {
                        if (!seg || seg === ".") continue;
                        if (seg === "..") parts.pop(); else parts.push(seg);
                      }
                      return `${fsPath}/download?path=${encodeURIComponent("/" + parts.join("/"))}`;
                    }} /></div>
                : <pre className="h-full w-full overflow-auto p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">{cur.text}</pre>)}
              {cur.url && cur.kind === "image" && <img src={cur.url} alt={cur.name} className="max-h-full max-w-full object-contain" />}
              {cur.url && cur.kind === "html" && <iframe src={cur.url} sandbox="" title={cur.name} className="h-full w-full border-0 bg-white" />}
              {cur.url && cur.kind === "pdf" && <iframe src={cur.url} title={cur.name} className="h-full w-full border-0" />}
            </div>
          </div>
        </>);
      })()}

      {ui.treeOpen && (
        <>
          <div className="h-full w-1 shrink-0 cursor-col-resize bg-card"
            title={t("拖动调整文件树宽度")}
            onPointerDown={e => {
              e.preventDefault();
              const x0 = e.clientX, w0 = ui.treeW, p0 = ui.pvW, hasPv = pvTabs.length > 0;
              const mv = (ev: PointerEvent) => {
                const d = ev.clientX - x0;
                setUi(u => {
                  if (!hasPv) return { ...u, treeW: Math.min(480, Math.max(180, w0 - d)) };
                  // 预览展开:把手是预览|树分界,跟随鼠标;联动量取两侧都不越界的最小值——
                  // 任一侧到界(树 180 / 预览上限)整组分界就停,不再把别处拖动
                  const pvMax = window.innerWidth - 300;
                  const room = d > 0
                    ? Math.min(d, w0 - 180, pvMax - p0)
                    : Math.max(d, -(480 - w0), -(p0 - 320));
                  return { ...u, treeW: w0 - room, pvW: p0 + room };
                });
              };
              const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
              window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
            }} />
          <div className="flex h-full min-w-0 shrink-0 flex-col overflow-hidden bg-card" style={{ width: ui.treeW }}>
            {root !== null
              ? <Explorer apiBase={base} root={root}
                  onRoot={r => { setRoot(r); try { localStorage.setItem(`tg_root:${tk}`, JSON.stringify(r)); } catch { /* */ } }}
                  onOpenFile={openFile}
                  onClose={() => setUi(u => ({ ...u, treeOpen: false }))}
                  activeFile={null} />
              : <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("读取家目录…")}</div>}
          </div>
        </>
      )}

      {/* 预览器文件 tab 右键:关闭 / 全部关闭 */}
      {pvCtx && (
        <div onMouseDown={e => e.stopPropagation()}
          className="fixed z-50 min-w-36 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
          style={{ left: pvCtx.x, top: pvCtx.y }}>
          <button onClick={() => { setPvCtx(null); closePv(pvCtx.path); }}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent">
            关闭
          </button>
          <button onClick={() => { setPvCtx(null); closeAllPv(); }}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent">
            全部关闭
          </button>
        </div>
      )}
    </div>
  );
}
