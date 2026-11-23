//! 非交互命令通道:目标上的 docker/podman ps、tmux 会话、文件树管线都走这里。
//! ssh 目标:`ssh <opts> <target> <cmd>`(cmd 整串由远端 shell 解析);
//! local 目标:本机直接跑(Unix sh;Windows local 第一版仅支持终端,文件 API 后续)。
//! Unix 上给 exec 通道挂 ControlMaster 复用(连点文件树零握手;Windows OpenSSH 不支持 CM,退化为每次直连)。

use crate::targets::Entry;
use anyhow::Result;
use std::time::Duration;
use tokio::process::Command;

pub fn cm_dir() -> std::path::PathBuf {
    let d = dirs::cache_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default())
        .join("term-gateway");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// 组 ssh 公共参数(auth=none;凭据注入只在交互 ws 里做,exec 通道要求免密)
pub fn ssh_base() -> Vec<String> {
    let mut v = vec![
        "-o".into(), "StrictHostKeyChecking=accept-new".into(),
        "-o".into(), "ConnectTimeout=20".into(),
        "-o".into(), "BatchMode=yes".into(), // exec 通道不喂密码,失败快返
        // ServerAlive 让 CM master 半开自愈(网络切换后 master 不死会卡死所有 mux 复用)
        "-o".into(), "ServerAliveInterval=15".into(),
        "-o".into(), "ServerAliveCountMax=2".into(),
    ];
    if cfg!(unix) {
        let cm = cm_dir().join("cm-%r@%h-%p").to_string_lossy().to_string();
        v.extend([
            "-o".to_string(), "ControlMaster=auto".into(),
            "-o".into(), format!("ControlPath={cm}"),
            "-o".into(), "ControlPersist=10m".into(),
        ]);
    }
    v
}

pub fn local_shell_cmd(cmd: &str) -> Vec<String> {
    if cfg!(windows) {
        vec!["-Command".into(), cmd.to_string()] // powershell
    } else {
        vec!["-c".into(), cmd.to_string()] // sh
    }
}

/// 在目标上执行命令,收完输出返回 (退出码, stdout)。超时返回 Err。
pub async fn run(entry: &Entry, cmd: &str, timeout_s: u64) -> Result<(i32, Vec<u8>)> {
    let mut c = if entry.kind == "local" {
        let shell = if cfg!(windows) { "powershell" } else { "sh" };
        let mut c = Command::new(shell);
        c.args(local_shell_cmd(cmd));
        c
    } else {
        let mut c = Command::new("ssh");
        c.args(ssh_base());
        if !entry.port.is_empty() {
            c.args(["-p".into(), entry.port.clone()]);
        }
        if !entry.user.is_empty() {
            c.args(["-l".into(), entry.user.clone()]);
        }
        let target = if entry.addr.is_empty() { &entry.name } else { &entry.addr };
        c.arg(target);
        c.arg(cmd); // 单参数=远端 shell 解析(管线/引号语义完整)
        c
    };
    // spawn 不像 output() 自动接管 stdio:stdout 必须 piped 才能收到命令输出
    c.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // kill_on_drop:超时 drop future 时自动杀子进程,否则 ssh 泄漏堆积(CM 排队卡死场景)
    c.kill_on_drop(true);
    let mut child = c.spawn()?;
    let out = tokio::time::timeout(Duration::from_secs(timeout_s), child.wait_with_output()).await??;
    Ok((out.status.code().unwrap_or(-1), out.stdout))
}

/// 目标是否 Unix 环境(文件树管线是否可用):local 看 cfg!,ssh 目标一律按 Unix
pub fn fs_unix(entry: &Entry) -> bool {
    entry.kind != "local" || cfg!(unix)
}

/// 可达性探测:ssh 过去跑一条 `true`(local 恒在线)。存了密码的主机走 askpass(不能 BatchMode),
/// 其余 BatchMode 快速失败;ConnectTimeout 收紧到 6s,不卡列表。
/// 不走 ControlMaster:mux 复用阶段不受 ConnectTimeout 保护,master 半开会无限排队(踩过)。
pub async fn probe(entry: &Entry) -> bool {
    if entry.kind == "local" { return true; }
    let mut c = Command::new("ssh");
    c.arg("-o").arg("StrictHostKeyChecking=accept-new")
        .arg("-o").arg("ConnectTimeout=6");
    if entry.pass.is_empty() {
        c.arg("-o").arg("BatchMode=yes");
    }
    if !entry.port.is_empty() { c.arg("-p").arg(&entry.port); }
    if !entry.user.is_empty() { c.arg("-l").arg(&entry.user); }
    let target = if entry.addr.is_empty() { &entry.name } else { &entry.addr };
    c.arg(target).arg("true").stdin(std::process::Stdio::null());
    #[cfg(unix)]
    if !entry.pass.is_empty() {
        c.env("TERM_GATEWAY_PASS", &entry.pass);
        c.env("SSH_ASKPASS", crate::ws::askpass_path().to_string_lossy().as_ref());
        c.env("SSH_ASKPASS_REQUIRE", "force");
        c.env("DISPLAY", ":0");
    }
    c.kill_on_drop(true);
    let mut child = match c.spawn() { Ok(ch) => ch, Err(_) => return false };
    matches!(
        tokio::time::timeout(Duration::from_secs(12), child.wait_with_output()).await,
        Ok(Ok(o)) if o.status.success()
    )
}
