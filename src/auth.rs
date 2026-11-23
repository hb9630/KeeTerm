//! code-server 式鉴权:单一共享密码(纯小工具,无 API 场景)。
//! --auth <password> 启用;未设=裸跑(本机工具哲学:交反代/绑本地)。
//! 登录:POST /api/auth/login {password} → Set-Cookie tg_auth。
//! token 从当前密码派生(sha256):重启不掉线;改密码=所有旧会话作废。

use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;

#[derive(Clone)]
pub struct Auth {
    pub password: Option<String>,
    pub pass_file: Option<std::path::PathBuf>,
}

impl Auth {
    pub fn new(password: Option<String>, pass_file: Option<std::path::PathBuf>) -> Self {
        Self { password, pass_file }
    }

    /// 当前密码:文件现读(改文件即时生效免重启),失败回退启动参数
    pub fn current_password(&self) -> String {
        if let Some(f) = &self.pass_file {
            if let Ok(s) = std::fs::read_to_string(f) {
                return s.trim().to_string();
            }
        }
        self.password.clone().unwrap_or_default()
    }

    pub fn enabled(&self) -> bool {
        self.password.is_some() || self.pass_file.is_some()
    }

    fn token_from(&self, headers: &HeaderMap) -> Option<String> {
        if let Some(v) = headers.get("cookie").and_then(|v| v.to_str().ok()) {
            if let Some(t) = v.split(';').find_map(|p| p.trim().strip_prefix("tg_auth=")) {
                return Some(t.to_string());
            }
        }
        None
    }

    /// cookie token:由当前密码派生(确定性)。重启不变→不掉线;改密码→旧会话全部作废
    pub fn token(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"keeterm-cookie-v1:");
        h.update(self.current_password().as_bytes());
        hex(&h.finalize())
    }

    pub fn check(&self, headers: &HeaderMap) -> bool {
        if !self.enabled() {
            return true;   // 未启用=裸跑(绑本地/交反代)
        }
        let want = self.token();
        self.token_from(headers)
            .map(|t| constant_eq(t.as_bytes(), want.as_bytes()))
            .unwrap_or(false)
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 恒时比较(防计时侧信道,密码场景的基本礼数)
fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut d = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        d |= x ^ y;
    }
    d == 0
}

/// 统一入口守卫:登录接口放行;已登录访问 /login 回首页;API 未登录=401;页面未登录=302 /login
pub fn gate(auth: &Auth, path: &str, headers: &HeaderMap) -> Option<Response> {
    if !auth.enabled() || path == "/api/auth/login" || path == "/api/t/healthz" || path == "/favicon.ico" {
        return None;
    }
    if auth.check(headers) {
        if path == "/login" {
            return Some(axum::response::Redirect::to("/").into_response());
        }
        return None;
    }
    if path.starts_with("/api/") {
        Some((StatusCode::UNAUTHORIZED, "未登录").into_response())
    } else if path == "/login" {
        None
    } else {
        Some(axum::response::Redirect::temporary(format!("/login?next={path}").as_str()).into_response())
    }
}

use axum::response::IntoResponse;
