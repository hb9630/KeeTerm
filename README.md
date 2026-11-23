# KeeTerm

[English](README.en.md) | 中文

**独立 Web 终端 · ssh config 即目标 · 容器 / tmux / 文件工作站。**

![终端 + 文件工作站](screen1.png)

![分屏(可嵌套左右/上下拆分)](screen2.png)

Rust 单二进制(前端内嵌),VSCode Remote 哲学:你已装好的 `~/.ssh/config` 就是主机清单,零服务端安装、零协议库(纯编排 ssh 客户端)。

```
$ keeterm 7697 --auth-file pass.txt
```

## 快速上手

- **`+`**(tab 头):新开本机终端
- **`∨` 下拉**:主机/容器树——**左键**展开容器,**右键**选连接方式
- **登记主机**:下拉底部「编辑 ssh config」直接改 `~/.ssh/config`,保存后列表即时刷新;`targets.toml` 只存增强项(备注/密码/端口)

### 连接与修饰键

右键菜单(SSH 登入 / tmux 会话 / 新建 tmux / 容器登入)统一支持:

| 操作 | 行为 |
|---|---|
| 点击 | 新 tab |
| **Shift + 点击** | 在当前焦点面板**右侧**拆分登入 |
| **Alt + 点击** | 在当前焦点面板**下方**拆分登入 |

- 分屏可**继续嵌套拆分**(iTerm 式),分隔条可拖(15%~85%),焦点面板有亮框
- 面板右上按钮组:`Aa` 字体/主题 · 文件树 · `×` 关面板(`Ctrl+D` 同效)
- 每个面板都是完整三栏:**终端 | 文件预览 | 文件树**;树的工作目录按连接记忆
- **tmux 会话在目标机运行**:断线/关 tab 不散场,重连即恢复现场

### 文件工作站

- 文件树:远端目录流式分页(6 万条目录亚秒),右键新建/删除/重命名/上传/下载,目录打 tar.gz
- 预览:文本 / **Markdown 渲染**(含内联 SVG、引用式图片按相对路径取)/ PDF / 图片 / HTML 沙箱
- 编辑:文本/Markdown 可编辑(CodeMirror 内核,无语法高亮保持轻量),`Ctrl+S` 保存回远端

### 终端状态标(tab 头)

- 转圈 = 后台面板有输出(运行中)
- 红点呼吸 = 静默 4 秒(干完/等确认),切过去看即清
- 微输出(tmux 状态栏时钟)不算未读

## 手机

浏览器直接开(自适应布局):

- 终端区**拖动**回滚;**PgUp / PgDn** 翻 tmux 历史(copy-mode)
- 底部辅助键条:Esc / 箭头 / Tab / **Ctrl 粘滞**(Ctrl+C 中断)/ ⌨ 收起软键盘
- tab 条横滑切换;**长按 tab** 拖动排序
- 键鼠活动即保活:空闲超时按最后活动重算,人在终端前连接不断

## 监控右栏

- 主机资源卡:CPU/内存大字 + **CPU 近 2h 曲线** + GPU/存储行(15s 采集)
- URL 探针卡:`{rows,bar,value}` 协议或任意 JSON(自动拍平),自签证书可用
- `+` 配置(主机选 targets、探针填名称+URL),保存即生效,卡片可拖拽排序

## 部署

```
$ cargo build --release          # 自动嵌入 web/dist(前端:cd web && npm run build)
$ ./target/release/term-gateway 7697 --auth-file pass.txt
```

- auth:code-server 式单密码;改密码文件即时生效(旧会话作废);cookie 由密码派生,重启不掉线
- systemd 示例见 `systemd/`;公网建议 frp/反代 + 强密码

---

[https://github.com/hb9630/KeeTerm](https://github.com/hb9630/KeeTerm) · 联系:[h9630@qq.com](mailto:h9630@qq.com)
