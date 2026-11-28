//! 终端 ws 泵:浏览器 ↔ pty(local shell 或 ssh;含容器 exec / tmux 会话变体)。
//! 经验移植(见平台 term.py 踩坑):
//! - 密码注入用 SSH_ASKPASS(单层 pty;sshpass 会再造一层 pty,resize 断链)
//! - portable-pty 的 resize 跨平台(Unix 内部 TIOCSWINSZ+控制终端已正确设置;Windows ConPTY)
//! - 带远端命令必须 -tt,否则 tmux 报 not a terminal
//! - openpty 兜底 80x24,首个 resize 消息覆盖

use crate::targets::{Entry, Registry};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use portable_pty::CommandBuilder;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Deserialize)]
pub struct WsQuery {
    pub target: String,
    #[serde(default)]
    pub ctn: String,
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub session: String,
}

fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn askpass_path() -> std::path::PathBuf {
    use std::io::Write;
    let p = crate::exec::cm_dir().join("askpass.sh");
    if !p.exists() {
        let mut f = std::fs::File::create(&p).unwrap();
        let _ = write!(f, "#!/bin/sh\necho \"$TERM_GATEWAY_PASS\"\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700));
        }
    }
    p
}

#[allow(clippy::too_many_arguments)]
fn build_command(entry: &Entry, ctn: &str, engine: &str, session: &str) -> CommandBuilder {
    let _CTN_SHELL = "[ -e /bin/bash ] && exec /bin/bash || exec /bin/sh";
    if entry.kind == "local" {
        // 本机:Windows=PowerShell(自己登录自己),Unix=登录 shell
        let mut cmd = if cfg!(windows) {
            let mut c = CommandBuilder::new("powershell");
            c.arg("-NoLogo");
            c
        } else {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
            let mut c = CommandBuilder::new(shell);
            c.arg("-l");
            c
        };
        if !session.is_empty() && cfg!(unix) {
            // local 的 tmux 会话(Unix)
            let mut c = CommandBuilder::new("tmux");
            c.arg("new");
            c.arg("-A");
            c.arg("-s");
            c.arg(session);
            cmd = c;
        }
        cmd.env("TERM", "xterm-256color");
        return cmd;
    }

    // ssh 目标:统一先拼完整 ssh argv(选项/-l/目标/ctn/session 变体),再决定直接执行还是包一层用户名询问
    let target = if entry.addr.is_empty() { entry.name.clone() } else { entry.addr.clone() };
    let ask_user = entry.user.is_empty() && !target.contains('@');   // 用户名未知:终端里先问(密码由 ssh 原生提示)

    let mut argv: Vec<String> = vec![
        "-o".into(), "StrictHostKeyChecking=accept-new".into(),
        "-o".into(), "LogLevel=ERROR".into(),   // 抑制首连 known_hosts 提示等 stderr 噪声(闪现后被 tmux 清屏盖掉,像"一闪而过的错误")
        "-o".into(), "ConnectTimeout=20".into(),
        "-o".into(), "ServerAliveInterval=30".into(),
        "-o".into(), "ServerAliveCountMax=4".into(),
    ];
    if !entry.port.is_empty() {
        argv.push("-p".into());
        argv.push(entry.port.clone());
    }
    if !entry.user.is_empty() {
        argv.push("-l".into());
        argv.push(entry.user.clone());
    }
    argv.push(target.clone());
    if !ctn.is_empty() {
        let inner = if session.is_empty() {
            "[ -e /bin/bash ] && exec /bin/bash || exec /bin/sh".to_string()
        } else {
            format!("tmux set -g window-size latest 2>/dev/null; tmux set -g mouse on 2>/dev/null; tmux new -A -s {}", shq(session))
        };
        let run = format!("exec -it {} sh -c {}", shq(ctn), shq(&inner));
        let full = match engine {
            "docker" | "podman" => format!("{engine} {run}"),
            // 引擎探测:CLI 在且 daemon 活着才走 docker——只查 CLI 会闪 "Cannot connect to the
            // Docker daemon at unix:///var/run/docker.sock" 再 fallback podman(一闪而过的错误)
            _ => format!("command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker {run} || podman {run}"),
        };
        argv.push("-tt".into());
        argv.push(full);
    } else if !session.is_empty() {
        argv.push("-tt".into());
        argv.push(format!("tmux set -g window-size latest 2>/dev/null; tmux set -g mouse on 2>/dev/null; tmux new -A -s {}", shq(session)));
    }

    let mut c = if ask_user {
        // read 用户名 → exec ssh -l "$u" <完整参数>(引号逐个保真,经远端 sh 还原)
        let tail = argv.iter().map(|a| shq(a)).collect::<Vec<_>>().join(" ");
        let mut c = CommandBuilder::new("sh");
        c.arg("-c");
        c.arg(format!("read -p '登录用户名: ' u && exec ssh -l \"$u\" {tail}"));
        c
    } else {
        let mut c = CommandBuilder::new("ssh");
        for a in &argv {
            c.arg(a.as_str());
        }
        c
    };

    // 密码:SSH_ASKPASS 注入(Unix;Windows OpenSSH 不支持 force,密钥认证不受影响)
    #[cfg(unix)]
    if !entry.pass.is_empty() {
        c.env("TERM_GATEWAY_PASS", entry.pass.as_str());
        c.env("SSH_ASKPASS", askpass_path().to_string_lossy().as_ref());
        c.env("SSH_ASKPASS_REQUIRE", "force");
        c.env("DISPLAY", ":0");
    }
    #[cfg(not(unix))]
    let _ = &entry.pass;
    c.env("TERM", "xterm-256color");
    c
}

/// 升级入口:鉴权(cookie/Bearer)→ 解析目标 → 泵
pub async fn handler(
    State((reg, auth)): State<(Arc<Registry>, Arc<crate::auth::Auth>)>,
    headers: axum::http::HeaderMap,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    if !auth.check(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(entry) = reg.resolve(&q.target) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (ctn, engine, session) = (q.ctn, q.engine, q.session);
    ws.on_upgrade(move |socket| pump(socket, entry, ctn, engine, session)).into_response()
}

/// 主泵(由 main.rs 在鉴权后调用)
pub async fn pump(mut ws: WebSocket, entry: Entry, ctn: String, engine: String, session: String) {
    use portable_pty::{NativePtySystem, PtySize, PtySystem as _};
    let pty_sys = NativePtySystem::default();   // 具体类型(零字段):Send,可跨 await
    let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
    let pair = match pty_sys.openpty(size) {
        Ok(p) => p,
        Err(e) => { let _ = ws.send(Message::Text(format!("__ERR__pty 打开失败:{e}").into())).await; return; }
    };
    let mut cmd = build_command(&entry, &ctn, &engine, &session);
    let home = if cfg!(windows) {
        std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
    } else {
        std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
    };
    if home.exists() { cmd.cwd(&home); }
    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => { let _ = ws.send(Message::Text(format!("__ERR__进程启动失败:{e}").into())).await; return; }
    };
    drop(pair.slave);

    // portable-pty 的 reader 是同步 Read:出向泵放阻塞线程(spawn_blocking + blocking_send)
    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => { let _ = ws.send(Message::Text(format!("__ERR__pty 读取失败:{e}").into())).await; return; }
    };
    let mut writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => { let _ = ws.send(Message::Text(format!("__ERR__pty 写入失败:{e}").into())).await; return; }
    };
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Message>(64);
    let pump_out = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut buf = vec![0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.blocking_send(Message::Binary(buf[..n].to_vec().into())).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = tx.blocking_send(Message::Text("__ERR__".into()));
    });

    let master = pair.master;
    loop {
        tokio::select! {
            m = ws.recv() => {
                match m {
                    Some(Ok(Message::Binary(data))) => {
                        use std::io::Write;
                        let _ = writer.write_all(&data);
                    }
                    Some(Ok(Message::Text(t))) => {
                        // {"cols","rows"}=resize;其他(如 ping)忽略
                        if let Ok(v) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&t) {
                            let (c, r) = (v.get("cols").and_then(|x| x.as_u64()), v.get("rows").and_then(|x| x.as_u64()));
                            if let (Some(c), Some(r)) = (c, r) {
                                let _ = master.resize(PtySize { rows: r as u16, cols: c as u16, pixel_width: 0, pixel_height: 0 });
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            m = rx.recv() => {
                match m {
                    Some(msg) => { if ws.send(msg).await.is_err() { break; } }
                    None => break,
                }
            }
        }
    }
    pump_out.abort();
    let _ = child.kill();
    let _ = child.wait();
}
