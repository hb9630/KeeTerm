/* 轻量 i18n:字典以中文原文为 key(中文模式零查表直出),英文模式查 EN 表;
   切换写 localStorage 后整页重载——菜单级文案用,不做全组件响应式。 */

const EN: Record<string, string> = {
  // 下拉菜单
  "主机 / 容器(右键选择连接方式)": "Hosts / Containers (right-click to connect)",
  "编辑 ssh config(登记主机)": "Edit ssh config (add hosts)",
  "关于": "About",
  "加载目标…": "Loading hosts…",
  // 右键连接菜单
  "SSH 登入": "SSH login",
  "新建会话": "New session",
  "新建 tmux": "New tmux",
  "关闭会话": "Kill session",
  "查 tmux 会话…": "Loading tmux sessions…",
  "Shift+点击=左右拆分 · Alt+点击=上下拆分": "Shift+click = split H · Alt+click = split V",
  // tab 条 / tab 右键
  "新标签:登录本机": "New tab: local shell",
  "选择主机登录(左键展开,右键连接)": "Pick a host (click=expand, right-click=connect)",
  "关闭": "Close",
  "全部关闭": "Close all",
  "关闭(tmux 会话仍在目标机运行)": "Close (tmux keeps running on host)",
  "分屏(N 面板)": "Split panes",   // 动态徽标另有处理
  // 终端面板按钮
  "收起文件树": "Hide file tree",
  "展开文件树": "Show file tree",
  "终端外观:字号 / 主题": "Appearance: font / theme",
  "字号": "Font size",
  "主题(Windows Terminal 配色)": "Theme (Windows Terminal palettes)",
  "重置": "Reset",
  "关闭此面板": "Close pane",
  "运行中": "Running",
  "已静默(干完/等确认)": "Idle (done / awaiting)",
  "待激活…": "Waiting…",
  "正在连接终端…": "Connecting…",
  // TermView 提示
  "连接断开,重连中…": "Disconnected, reconnecting…",
  "重新连接…": "Reconnecting…",
  "连接已停止": "Session ended",
  // 文件树/预览
  "无容器(docker/podman)": "No containers",
  "读取失败": "Read failed",
  "加载中…": "Loading…",
  "下载当前文件": "Download file",
  "关闭预览区": "Close preview",
  "保存": "Save",
  "保存(Ctrl+S)": "Save (Ctrl+S)",
  "切回预览": "Back to preview",
  "编辑此文件": "Edit file",
  "读取家目录…": "Loading home…",
  "拖动调整预览区宽度": "Drag to resize preview",
  "拖动调整文件树宽度": "Drag to resize tree",
  // 监控栏
  "监控": "Monitor",
  "展开/缩起监控栏": "Toggle monitor panel",
  "展开监控栏": "Open monitor panel",
  "循环:展开 → 缩起 → 隐藏": "Cycle: open → mini → hidden",
  "切换标签": "Switch tab",
  "无标签,点 + 新建": "No tabs, tap + to create",
  "暂无监控项": "No monitors yet",
  "配置监控项(主机 / URL 探针)": "Configure monitors (hosts / URL probes)",
  "主机(采集 CPU/内存/存储/GPU)": "Hosts (CPU/mem/disk/GPU)",
  "URL 探针(返回 JSON;{rows,bar,value} 协议或任意 JSON)": "URL probes (JSON; {rows,bar,value} or raw)",
  "+ 添加主机": "+ Add host",
  "+ 添加探针": "+ Add probe",
  "名称": "Name",
  "地址": "Address",
  "端口": "Port",
  "备注": "Note",
  "取消": "Cancel",
  "已保存": "Saved",
  "目标名(ssh config / 已登记)": "Target name (ssh config / registered)",
  "读取中…": "Loading…",
  // ssh config 编辑器
  "主机列表数据源 · 保存后下拉列表即时刷新": "Host list source · refreshes on save",
  // 关于
  "独立 Web 终端 · ssh config 即目标 · 容器 / tmux / 文件工作站": "Standalone web terminal · ssh config is the host list · containers / tmux / file workbench",
  "使用手册 · github.com/hb9630/KeeTerm": "Manual · github.com/hb9630/KeeTerm",
  // 图片/svg 预览缩放
  "滚轮缩放 · 拖拽平移": "Wheel to zoom · drag to pan",
  "缩小": "Zoom out",
  "放大": "Zoom in",
  "还原 100%": "Reset 100%",
};

let lang: "zh" | "en" = (() => {
  try { return localStorage.getItem("tg_lang") === "en" ? "en" : "zh"; } catch { return "zh"; }
})();

export const t = (s: string): string => (lang === "en" ? EN[s] ?? s : s);
export const curLang = () => lang;
export const switchLang = () => {
  try { localStorage.setItem("tg_lang", lang === "en" ? "zh" : "en"); } catch { /* */ }
  location.reload();
};
