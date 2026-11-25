//! KeeTerm — 独立 Web 终端:local 本机 shell / ssh 目标(~/.ssh/config 即列表),
//! 容器挂主机树(docker/podman 自动发现)、tmux 会话(attach/新建/关闭)、exec 化文件浏览。
//! 单静态二进制(前端内嵌),零服务端安装;auth 可选(--jwt-secret,qweb 式接入)。

mod auth;
mod exec;
mod fsx;
mod monitor;
mod targets;
mod ws;

use anyhow::Result;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use clap::Parser;
use rust_embed::Embed;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

static AUTH: OnceLock<Arc<auth::Auth>> = OnceLock::new();
static REGK: OnceLock<Arc<targets::Registry>> = OnceLock::new();

#[derive(Parser, Debug)]
#[command(version, about)]
struct Args {
    /// 监听端口(默认 7698)
    port: Option<u16>,
    /// 监听地址(默认 127.0.0.1;平台接入时由 nginx 反代)
    #[arg(long)]
    host: Option<String>,
    /// 访问密码(code-server 式;不设=裸跑,交反代/本地绑定)。可经环境变量 TERM_GATEWAY_AUTH
    #[arg(long, env = "TERM_GATEWAY_AUTH")]
    auth: Option<String>,
    /// 密码文件(内容=纯密码;每次登录现读,改文件即时生效免重启)
    #[arg(long)]
    auth_file: Option<std::path::PathBuf>,
    /// 目标增强配置路径(默认 ~/.config/keeterm/targets.toml)
    #[arg(long)]
    config: Option<PathBuf>,
    /// ssh config 路径(默认 ~/.ssh/config)
    #[arg(long)]
    ssh_config: Option<PathBuf>,
    /// 静态目录(默认用内嵌前端;设了则读磁盘,前端开发热更用)
    #[arg(long)]
    static_dir: Option<PathBuf>,
}

#[derive(Embed)]
#[folder = "web/dist"]
struct Assets;

async fn serve_embedded(path: &str) -> Response {
    let p = path.trim_start_matches('/');
    let p = if p.is_empty() { "index.html" } else { p };
    match Assets::get(p) {
        Some(f) => {
            let mime = mime_guess::from_path(p).first_or_octet_stream();
            let mut r = Response::new(f.data.into());
            r.headers_mut().insert("content-type", mime.as_ref().parse().unwrap());
            if p.ends_with(".html") {
                r.headers_mut().insert("cache-control", "no-cache".parse().unwrap());
            }
            r
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn index() -> Response {
    serve_embedded("index.html").await
}

async fn static_path(Path(p): Path<String>) -> Response {
    serve_embedded(&p).await
}

type Shared = (Arc<targets::Registry>, Arc<auth::Auth>);

// ---------- code-server 式登录 ----------
#[derive(serde::Deserialize)]
struct LoginIn {
    password: String,
}

async fn auth_login(
    State((_, auth)): State<Shared>,
    axum::Json(body): axum::Json<LoginIn>,
) -> Response {
    use axum::http::header::SET_COOKIE;
    let pw = auth.current_password();
    let ok = auth.enabled()
        && body.password.len() == pw.len()
        && body.password.bytes().zip(pw.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0;
    if !ok {
        return (StatusCode::UNAUTHORIZED, "密码不对").into_response();
    }
    let mut r = Json(serde_json::json!({ "ok": true })).into_response();
    r.headers_mut().append(
        SET_COOKIE,
        format!("tg_auth={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800", auth.token()).parse().unwrap(),
    );
    r
}

async fn login_page() -> Response {
    let html = r#"<!doctype html><html lang=zh><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>KeeTerm</title>
<style>body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1e1e2e;color:#cdd6f4;font-family:system-ui}
form{display:flex;flex-direction:column;gap:12px;width:280px}h2{text-align:center;font-weight:600}
input,button{padding:10px 12px;border-radius:8px;border:1px solid #45475a;background:#313244;color:#cdd6f4;font-size:14px;box-sizing:border-box}
button{background:#89b4fa;color:#1e1e2e;font-weight:600;border:none;cursor:pointer}#err{color:#f38ba8;font-size:13px;min-height:18px;text-align:center}</style></head>
<body><form id=f><h2>KeeTerm</h2><input id=pw type=password placeholder=访问密码 autofocus><button>进入</button><p id=err></p></form>
<script>f.onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value})});
if(r.ok){location.href=new URLSearchParams(location.search).get('next')||'/'}else{err.textContent='密码不对';pw.select()}}</script></body></html>"#;
    let mut r = Response::new(html.into());
    r.headers_mut().insert("content-type", "text/html; charset=utf-8".parse().unwrap());
    r.headers_mut().insert("cache-control", "no-cache".parse().unwrap());
    r
}

// ---------- 目标 CRUD ----------
async fn targets_list(State((reg, auth)): State<Shared>, headers: HeaderMap) -> Response {
    if !auth.check(&headers) { return StatusCode::UNAUTHORIZED.into_response(); }
    Json(serde_json::json!({ "targets": reg.list() })).into_response()
}

async fn targets_upsert(
    State((reg, auth)): State<Shared>,
    headers: HeaderMap,
    Json(mut e): Json<targets::Entry>,
) -> Response {
    if !auth.check(&headers) { return StatusCode::UNAUTHORIZED.into_response(); }
    if e.name.trim().is_empty() || !e.name.chars().all(|c| c.is_ascii_alphanumeric() || "._-@:".contains(c)) {
        return (StatusCode::BAD_REQUEST, "名字仅限字母数字._-@:").into_response();
    }
    if e.kind.is_empty() { e.kind = "ssh".into(); }
    e.name = e.name.trim().to_string();
    let mut list = reg.load_toml_pub();
    match list.iter().position(|x| x.name == e.name) {
        Some(i) => {
            // 表单已不展示 user/pass:留空=保留已存值(凭据场景连终端时 ssh 原生提示输入)
            if e.user.is_empty() { e.user = list[i].user.clone(); }
            if e.pass.is_empty() { e.pass = list[i].pass.clone(); }
            list[i] = e;
        }
        None => list.push(e),
    }
    match reg.save_toml(&list) {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, format!("保存失败:{err}")).into_response(),
    }
}

async fn targets_remove(
    State((reg, auth)): State<Shared>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    if !auth.check(&headers) { return StatusCode::UNAUTHORIZED.into_response(); }
    if name == "local" {
        return (StatusCode::BAD_REQUEST, "local 为内置目标").into_response();
    }
    let mut list = reg.load_toml_pub();
    let before = list.len();
    list.retain(|x| x.name != name);
    if list.len() == before {
        return (StatusCode::NOT_FOUND, "条目不存在(ssh config 别名无需删除)").into_response();
    }
    match reg.save_toml(&list) {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, format!("保存失败:{err}")).into_response(),
    }
}

// ---------- 监控面板 ----------
async fn mon_data(headers: HeaderMap) -> Response {
    let auth = AUTH.get().expect("auth init");
    if !auth.check(&headers) { return StatusCode::UNAUTHORIZED.into_response(); }
    let m = monitor::MON.get().expect("mon init").lock().unwrap();
    Json(serde_json::json!({ "hosts": m.hosts, "probes": m.probes })).into_response()
}

async fn mon_cfg_get(headers: HeaderMap) -> Response {
    let auth = AUTH.get().expect("auth init");
    if !auth.check(&headers) { return StatusCode::UNAUTHORIZED.into_response(); }
    Json(monitor::cfg_get()).into_response()
}

async fn mon_cfg_post(headers: HeaderMap, Json(body): Json<monitor::CfgIn>) -> Response {
    let auth = AUTH.get().expect("auth init");
    if !auth.check(&headers) { return StatusCode::UNAUTHORIZED.into_response(); }
    match monitor::cfg_save(&body) {
        Ok(()) => {
            // 立即采一轮:移除的卡片马上消失,新增的几秒内出数据(不等 15s 周期)
            if let Some(reg) = REGK.get() {
                let reg = reg.clone();
                tokio::spawn(async move { monitor::tick_now(&reg).await; });
            }
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

// ---------- 可达性探测 ----------
async fn target_ping(
    State((reg, auth)): State<Shared>,
    headers: HeaderMap,
    Path(target): Path<String>,
) -> Response {
    if !auth.check(&headers) { return StatusCode::UNAUTHORIZED.into_response(); }
    let Some(entry) = reg.resolve(&target) else { return StatusCode::NOT_FOUND.into_response(); };
    Json(serde_json::json!({ "ok": exec::probe(&entry).await })).into_response()
}

// ---------- 容器发现 / tmux ----------
#[derive(serde::Deserialize)]
struct TgtQuery {
    #[serde(default)] pub ctn: String,
    #[serde(default)] pub engine: String,
}

async fn containers(
    State((reg, auth)): State<Shared>,
    headers: HeaderMap,
    Path(target): Path<String>,
    Query(q): Query<TgtQuery>,
) -> Response {
    if !auth.check(&headers) { return StatusCode::UNAUTHORIZED.into_response(); }
    let Some(entry) = reg.resolve(&target) else { return StatusCode::NOT_FOUND.into_response(); };
    // 先带 compose 项目 label(分组用);老版本引擎模板不认 .Label 时回退三列
    let fmts = [
        "'{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Label \"com.docker.compose.project\"}}'",
        "'{{.Names}}\\t{{.Image}}\\t{{.Status}}'",
    ];
    for engine in ["docker", "podman"] {
        for fmt in fmts {
            if let Ok((rc, out)) = fsx::run_on(&entry, "", "", &format!("command -v {engine} >/dev/null 2>&1 && {engine} ps -a --format {fmt}"), 30).await {
                if rc == 0 && !out.is_empty() {
                    let mut v = vec![];
                    for ln in String::from_utf8_lossy(&out).lines() {
                        let mut it = ln.splitn(4, '\t');
                        if let (Some(n), Some(i), Some(s), cp) = (it.next(), it.next(), it.next(), it.next().unwrap_or("")) {
                            if !n.is_empty() {
                                v.push(serde_json::json!({ "name": n, "image": i, "running": s.starts_with("Up"), "compose": cp }));
                            }
                        }
                    }
                    v.sort_by(|a, b| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()));
                    return Json(serde_json::json!({ "engine": engine, "containers": v })).into_response();
                }
            }
        }
    }
    Json(serde_json::json!({ "containers": [] })).into_response()
}

async fn tmux_list(
    State((reg, auth)): State<Shared>,
    headers: HeaderMap,
    Path(target): Path<String>,
    Query(q): Query<TgtQuery>,
) -> Response {
    if !auth.check(&headers) { return StatusCode::UNAUTHORIZED.into_response(); }
    let Some(entry) = reg.resolve(&target) else { return StatusCode::NOT_FOUND.into_response(); };
    let mut names: Vec<String> = vec![];
    if let Ok((rc, out)) = fsx::run_on(&entry, &q.ctn, &q.engine, "tmux list-sessions -F '#{session_name}'", 15).await {
        if rc == 0 {
            for ln in String::from_utf8_lossy(&out).lines() {
                let ln = ln.trim();
                if !ln.is_empty() && ln.len() <= 64 && ln.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                    names.push(ln.to_string());
                }
            }
        }
    }
    names.sort_by_key(|n| n.to_lowercase());
    Json(serde_json::json!({ "sessions": names })).into_response()
}

#[derive(serde::Deserialize)]
struct KillQuery {
    pub session: String,
    #[serde(default)] pub ctn: String,
    #[serde(default)] pub engine: String,
}

async fn tmux_kill(
    State((reg, auth)): State<Shared>,
    headers: HeaderMap,
    Path(target): Path<String>,
    Query(q): Query<KillQuery>,
) -> Response {
    if !auth.check(&headers) { return StatusCode::UNAUTHORIZED.into_response(); }
    let Some(entry) = reg.resolve(&target) else { return StatusCode::NOT_FOUND.into_response(); };
    if q.session.is_empty() || q.session.len() > 64 || !q.session.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return (StatusCode::BAD_REQUEST, "会话名不合法").into_response();
    }
    let c = format!("tmux kill-session -t {}", q.session);
    match fsx::run_on(&entry, &q.ctn, &q.engine, &c, 15).await {
        Ok((0, _)) => Json(serde_json::json!({ "ok": true })).into_response(),
        Ok((_, out)) => (StatusCode::INTERNAL_SERVER_ERROR, format!("关闭失败:{}", String::from_utf8_lossy(&out).trim())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("关闭失败:{e}")).into_response(),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let port = args.port.unwrap_or(7698);
    let host = args.host.unwrap_or_else(|| "127.0.0.1".into());

    let reg = Arc::new(targets::Registry::new(args.config, args.ssh_config));
    let auth = Arc::new(auth::Auth::new(args.auth, args.auth_file));
    let _ = AUTH.set(auth.clone());
    let _ = monitor::MON.set(monitor::start(reg.clone()));
    let _ = REGK.set(reg.clone());
    let shared: Shared = (reg.clone(), auth.clone());

    let app = Router::new()
        .route("/login", get(login_page))
        .route("/api/auth/login", post(auth_login))
        .route("/api/t/targets", get(targets_list).post(targets_upsert))
        .route("/api/t/targets/{name}", delete(targets_remove))
        .route("/api/t/mon", get(mon_data))
        .route("/api/t/mon/cfg", get(mon_cfg_get).post(mon_cfg_post))
        .route("/api/t/target/{target}/ping", get(target_ping))
        .route("/api/t/target/{target}/containers", get(containers))
        .route("/api/t/target/{target}/tmux", get(tmux_list))
        .route("/api/t/target/{target}/tmux/kill", post(tmux_kill))
        .route("/api/t/target/{target}/fs/home", get(fsx::fs_home))
        .route("/api/t/target/{target}/fs", get(fsx::fs_list))
        .route("/api/t/target/{target}/fs/download", get(fsx::fs_download))
        .route("/api/t/target/{target}/fs/op", post(fsx::fs_op))
        .route("/api/t/target/{target}/fs/save", post(fsx::fs_save))
        .route("/api/t/target/{target}/fs/stat", post(fsx::fs_stat))
        .route("/api/t/target/{target}/ctn/{ctn}/fs/home", get(fsx::ctn_fs_home))
        .route("/api/t/target/{target}/ctn/{ctn}/fs", get(fsx::ctn_fs_list))
        .route("/api/t/target/{target}/ctn/{ctn}/fs/download", get(fsx::ctn_fs_download))
        .route("/api/t/target/{target}/ctn/{ctn}/fs/op", post(fsx::ctn_fs_op))
        .route("/api/t/target/{target}/ctn/{ctn}/fs/save", post(fsx::ctn_fs_save))
        .route("/api/t/target/{target}/ctn/{ctn}/fs/stat", post(fsx::ctn_fs_stat))
        .route("/api/t/ws", get(ws::handler))
        .route("/api/t/healthz", get(|| async { Json(serde_json::json!({ "ok": true, "app": "KeeTerm" })) }))
        .route("/", get(index))
        .route("/{*path}", get(static_path))
        .with_state(shared)
        // 文件上传走 JSON(base64),默认 2MB 限制放开到 700MB(与 nginx 512m×1.33 膨胀匹配)
        .layer(axum::extract::DefaultBodyLimit::max(700_000_000));

    let app = app.layer(axum::middleware::from_fn_with_state(
        auth.clone(),
        |State(auth): State<Arc<auth::Auth>>, req: axum::http::Request<axum::body::Body>, next: axum::middleware::Next| async move {
            let path = req.uri().path().to_string();
            if let Some(r) = auth::gate(&auth, &path, req.headers()) {
                return r;
            }
            next.run(req).await
        },
    ));

    // 静态目录模式(前端开发热更):覆盖 embed
    let app = if let Some(dir) = args.static_dir {
        static_dir_router(dir)
    } else {
        app
    };

    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    eprintln!("[KeeTerm] listening on {host}:{port} (targets: ~/.ssh/config + {})", reg.toml_path.display());
    axum::serve(listener, app).await?;
    Ok(())
}

/// 静态目录服务(开发模式):极简实现,够用
fn static_dir_router(dir: PathBuf) -> Router {
    use axum::body::Body;
    use axum::http::Request;
    let dir = dir.canonicalize().unwrap_or(dir);
    Router::new().fallback(move |req: Request<Body>| {
        let dir = dir.clone();
        async move {
            let rel = req.uri().path().trim_start_matches('/');
            let rel = if rel.is_empty() { "index.html" } else { rel };
            let p = dir.join(rel);
            match tokio::fs::read(&p).await {
                Ok(data) => {
                    let mime = mime_guess::from_path(&p).first_or_octet_stream();
                    let mut r = Response::new(data.into());
                    r.headers_mut().insert("content-type", mime.as_ref().parse().unwrap());
                    if p.extension().map(|e| e == "html").unwrap_or(false) {
                        r.headers_mut().insert("cache-control", "no-cache".parse().unwrap());
                    }
                    r
                }
                Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
            }
        }
    })
}
