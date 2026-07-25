use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

use chrono::Utc;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, PhysicalPosition, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, MutexGuard, Semaphore};
use tokio_util::sync::CancellationToken;

type HmacSha256 = Hmac<Sha256>;
type HmacSha1 = Hmac<Sha1>;

static RUNNING_PID: AtomicU32 = AtomicU32::new(0);

lazy_static::lazy_static!(
    static ref CURRENT_CHILD: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    /// 当前本地脚本（wx_ribao.py --cli）的 stdin，用于发送 "CANCEL" 实现优雅取消
    static ref CURRENT_STDIN: Arc<Mutex<Option<tokio::process::ChildStdin>>> =
        Arc::new(Mutex::new(None));
    /// 正在进行的部署任务的 CancellationToken 注册表，key = deploy_id
    static ref DEPLOY_CANCEL_TOKENS: Arc<Mutex<HashMap<String, CancellationToken>>> =
        Arc::new(Mutex::new(HashMap::new()));
    /// Git Pipeline 任务的 CancellationToken 注册表，key = session_id
    static ref PIPELINE_CANCEL_TOKENS: Arc<Mutex<HashMap<String, CancellationToken>>> =
        Arc::new(Mutex::new(HashMap::new()));
);

/// 取消正在进行的部署任务（由前端点击删除日志时调用）
#[tauri::command]
async fn cancel_deploy(deploy_id: String) -> Result<(), String> {
    let mut map = DEPLOY_CANCEL_TOKENS.lock().await;
    if let Some(token) = map.remove(&deploy_id) {
        token.cancel();
        Ok(())
    } else {
        // 任务可能已经完成，不视为错误
        Ok(())
    }
}

/// 在 exe 同级目录及向上 3 级目录中查找指定脚本，返回 (脚本所在目录, 脚本完整路径)。
/// 这样无论是开发模式（exe 位于 src-tauri/target/debug）还是安装后（脚本与 exe 同级）都能定位到。
fn resolve_script(script_name: &str) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法获取 exe 路径: {}", e))?;
    let exe_dir = exe
        .parent()
        .ok_or("无法获取 exe 所在目录")?
        .to_path_buf();
    let candidates = [
        exe_dir.clone(),
        exe_dir
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| exe_dir.clone()),
        exe_dir
            .parent()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| exe_dir.clone()),
        exe_dir
            .parent()
            .and_then(|p| p.parent().and_then(|p| p.parent().map(|p| p.to_path_buf())))
            .unwrap_or_else(|| exe_dir.clone()),
    ];
    for dir in &candidates {
        let script = dir.join(script_name);
        if script.is_file() {
            let root = dir
                .canonicalize()
                .map_err(|e| format!("项目根目录无效: {} ({})", dir.display(), e))?;
            let script_path = script
                .canonicalize()
                .map_err(|e| format!("脚本路径无效: {} ({})", script.display(), e))?;
            return Ok((root, script_path));
        }
    }
    Err(format!(
        "未找到 {}，已检查: exe 同级及向上 3 级目录（如 {}）",
        script_name,
        exe_dir.display()
    ))
}

/// 微信日报「本地脚本模式」参数（与远程接口 `/api/wx-ribao` 字段一致）。
#[derive(serde::Deserialize)]
struct WxRibaoLocalParams {
    #[serde(rename = "startDate")]
    start_date: String,
    #[serde(rename = "endDate")]
    end_date: String,
    #[serde(rename = "outputFormat", default)]
    output_format: Option<String>,
    #[serde(rename = "indentInTheLine", default)]
    indent_in_the_line: Option<String>,
}

/// 通过本地 Python 脚本（wx_ribao.py --cli）获取微信日报。
///
/// 作为远程接口 `/api/wx-ribao` 的兜底方案：脚本会把「日志/二维码/结果」以带前缀的
/// JSON 单行输出到 stdout，这里逐行原样转发为 `wx-ribao-log` 事件，由前端解析。
/// 需本机已安装 Python、playwright 及 chromium（`playwright install chromium`）。
#[tauri::command]
async fn run_wx_ribao(app: AppHandle, params: WxRibaoLocalParams) -> Result<(), String> {
    let python_path = std::env::var("PYTHON_PATH")
        .unwrap_or_else(|_| "python".to_string());

    {
        let child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        if child_lock.is_some() {
            return Err("已有脚本正在运行，请先停止".to_string());
        }
    }

    let (project_root, script_path) = resolve_script("wx_ribao.py")?;

    let output_format = params
        .output_format
        .clone()
        .unwrap_or_else(|| "1".to_string());
    let indent = params
        .indent_in_the_line
        .clone()
        .unwrap_or_else(|| "false".to_string());

    let mut cmd = Command::new(&python_path);
    cmd.arg(&script_path)
        .arg("--cli")
        .arg("--startDate").arg(&params.start_date)
        .arg("--endDate").arg(&params.end_date)
        .arg("--outputFormat").arg(&output_format)
        .arg("--indentInTheLine").arg(&indent);
    cmd.current_dir(&project_root);
    cmd.stdin(Stdio::piped()); // 用于优雅取消：向脚本发送 "CANCEL"
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| {
        format!("启动 Python 进程失败: {}（请确认已安装 Python 及依赖）", e)
    })?;

    if let Some(pid) = child.id() {
        RUNNING_PID.store(pid, Ordering::SeqCst);
    }

    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("无法捕获 stdout")?;
    let stderr = child.stderr.take().ok_or("无法捕获 stderr")?;

    {
        let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        *child_lock = Some(child);
    }
    {
        let mut stdin_lock = CURRENT_STDIN.lock().await;
        *stdin_lock = stdin;
    }

    // stdout/stderr 都转发为 wx-ribao-log 事件：结构化行由前端按前缀解析，
    // 其它原始行（如 Python 报错）直接展示到日志面板。
    let app_stdout = app.clone();
    let stdout_handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_stdout.emit("wx-ribao-log", line);
        }
    });

    let app_stderr = app.clone();
    let stderr_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_stderr.emit("wx-ribao-log", line);
        }
    });

    // 轮询等待进程结束：把 Child 保留在 CURRENT_CHILD 里（每次轮询之间释放锁），
    // 这样用户取消时 kill_python_script 仍能拿到并杀掉进程。
    loop {
        {
            let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
            match child_lock.as_mut() {
                Some(c) => match c.try_wait() {
                    Ok(Some(_status)) => {
                        // 进程正常结束：退出码非 0（过期/出错）已通过事件告知前端，不额外报错。
                        *child_lock = None;
                        RUNNING_PID.store(0, Ordering::SeqCst);
                        break;
                    }
                    Ok(None) => { /* 仍在运行 */ }
                    Err(e) => {
                        *child_lock = None;
                        RUNNING_PID.store(0, Ordering::SeqCst);
                        return Err(format!("等待进程失败: {}", e));
                    }
                },
                // 已被 kill_python_script 取出（用户取消）
                None => break,
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }

    {
        let mut stdin_lock = CURRENT_STDIN.lock().await;
        *stdin_lock = None;
    }

    let _ = stdout_handle.await;
    let _ = stderr_handle.await;

    Ok(())
}

/// 优雅停止本地微信日报脚本：向其 stdin 写入 "CANCEL"，让 Python 端主动取消任务、
/// 关闭 Playwright 浏览器后再退出，避免强杀导致 Playwright 驱动报 EPIPE。
/// 兜底：若 6 秒内仍未退出，则强制结束进程，防止残留浏览器。
#[tauri::command]
async fn stop_wx_ribao() -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    {
        let mut stdin_lock = CURRENT_STDIN.lock().await;
        if let Some(stdin) = stdin_lock.as_mut() {
            let _ = stdin.write_all(b"CANCEL\n").await;
            let _ = stdin.flush().await;
        }
    }

    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        if let Some(child) = child_lock.as_mut() {
            let _ = child.kill().await;
            *child_lock = None;
            RUNNING_PID.store(0, Ordering::SeqCst);
        }
    });

    Ok(())
}

#[tauri::command]
async fn kill_python_script() -> Result<(), String> {
    let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
    if let Some(child) = child_lock.as_mut() {
        child.kill().await.map_err(|e| format!("停止进程失败: {}", e))?;
        *child_lock = None;
        RUNNING_PID.store(0, Ordering::SeqCst);
        Ok(())
    } else {
        Err("没有正在运行的脚本".to_string())
    }
}

// ==================== 发布微信小程序版本（本地脚本模式） ====================

#[derive(serde::Deserialize)]
struct ReleaseVersionParams {
    username: String,
    password: String,
    #[serde(rename = "secretKey")]
    secret_key: String,
    version: String,
    name: String,
    #[serde(rename = "sendMessage", default)]
    send_message: Option<String>,
    /// 应用 ID 数组的 JSON 字符串，例如 ["wx123456789"]
    appid: String,
    #[serde(default)]
    desc: String,
}

/// 通过本地 Python 脚本（release_version.py）发布微信小程序版本。
/// 作为远程接口 `/api/release-version` 的兜底方案：当服务器不可用时可改用本地脚本。
///
/// 返回值结构与远程接口一致：`{ code, message, log }`。
#[tauri::command]
async fn run_release_version(
    app: AppHandle,
    params: ReleaseVersionParams,
) -> Result<serde_json::Value, String> {
    let python_path =
        std::env::var("PYTHON_PATH").unwrap_or_else(|_| "python".to_string());

    let (project_root, script_path) = resolve_script("release_version.py")?;

    let send_message = params
        .send_message
        .clone()
        .unwrap_or_else(|| "1".to_string());

    let mut cmd = Command::new(&python_path);
    cmd.arg(&script_path)
        .arg("--username").arg(&params.username)
        .arg("--password").arg(&params.password)
        .arg("--secretKey").arg(&params.secret_key)
        .arg("--version").arg(&params.version)
        .arg("--name").arg(&params.name)
        .arg("--sendMessage").arg(&send_message)
        .arg("--appid").arg(&params.appid)
        .arg("--desc").arg(&params.desc);
    cmd.current_dir(&project_root);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 Python 进程失败: {}（请确认已安装 Python 及依赖）", e))?;

    let stdout = child.stdout.take().ok_or("无法捕获 stdout")?;
    let stderr = child.stderr.take().ok_or("无法捕获 stderr")?;

    // 实时把 stdout 推给前端（release-log 事件），并捕获 RELEASE_RESULT 结果行
    let app_out = app.clone();
    let stdout_handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut result_json: Option<String> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(rest) = line.strip_prefix("RELEASE_RESULT:") {
                result_json = Some(rest.trim().to_string());
            } else {
                let _ = app_out.emit("release-log", &line);
            }
        }
        result_json
    });

    let app_err = app.clone();
    let stderr_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        let mut buf = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit("release-log", &line);
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("等待进程失败: {}", e))?;

    let result_json = stdout_handle.await.ok().flatten();
    let stderr_buf = stderr_handle.await.unwrap_or_default();

    if let Some(json_str) = result_json {
        let value: serde_json::Value = serde_json::from_str(&json_str)
            .map_err(|e| format!("解析脚本结果失败: {}（原始: {}）", e, json_str))?;
        return Ok(value);
    }

    // 未拿到结构化结果：脚本可能崩溃或缺少依赖
    Err(format!(
        "本地脚本执行失败（退出码: {:?}）。{}",
        status.code(),
        if stderr_buf.trim().is_empty() {
            "未捕获到错误输出，请检查 Python 环境与依赖。".to_string()
        } else {
            format!("错误输出:\n{}", stderr_buf.trim())
        }
    ))
}

// ==================== 腾讯云 CDN API (TC3-HMAC-SHA256) ====================

fn sha256_hash(data: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().to_vec()
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key)
        .expect("HMAC can take key of any size");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

async fn call_tencent_cdn_api(
    secret_id: &str,
    secret_key: &str,
    action: &str,
    payload: &str,
) -> Result<serde_json::Value, String> {
    let host = "cdn.tencentcloudapi.com";
    let service = "cdn";
    let version = "2018-06-06";
    let now = Utc::now();
    let timestamp = now.timestamp();
    let date = now.format("%Y-%m-%d").to_string();

    let hashed_payload = hex::encode(sha256_hash(payload.as_bytes()));
    let canonical_request = format!(
        "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:{host}\n\ncontent-type;host\n{hashed_payload}"
    );

    let credential_scope = format!("{date}/{service}/tc3_request");
    let hashed_canonical = hex::encode(sha256_hash(canonical_request.as_bytes()));
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{hashed_canonical}"
    );

    let secret_date = hmac_sha256(
        format!("TC3{secret_key}").as_bytes(),
        date.as_bytes(),
    );
    let secret_service = hmac_sha256(&secret_date, service.as_bytes());
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request");
    let signature = hex::encode(hmac_sha256(&secret_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, SignedHeaders=content-type;host, Signature={signature}"
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("https://{host}"))
        .header("Authorization", &authorization)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Host", host)
        .header("X-TC-Action", action)
        .header("X-TC-Timestamp", timestamp.to_string())
        .header("X-TC-Version", version)
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| format!("CDN API 请求失败: {}", e))?;

    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取 CDN API 响应失败: {}", e))?;

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析 CDN API 响应失败: {}", e))?;

    if let Some(response) = json.get("Response") {
        if response.get("Error").is_some() {
            return Err(format!(
                "CDN API 返回错误: {}",
                serde_json::to_string_pretty(response).unwrap_or_default()
            ));
        }
    }

    Ok(json)
}

// ==================== 部署命令 ====================

#[derive(serde::Deserialize)]
struct DeployParams {
    deploy_id: String,
    project_dir: String,
    build_command: Option<String>,
    cos_secret_id: String,
    cos_secret_key: String,
    cos_region: String,
    cos_bucket: String,
    cdn_secret_id: String,
    cdn_secret_key: String,
    cdn_domain: Option<String>,
}

async fn run_shell_command(
    app: &AppHandle,
    program: &str,
    args: &[&str],
    cwd: &std::path::Path,
    event_name: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let needs_shell = matches!(program, "npm" | "npx" | "pnpm" | "yarn");

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = if needs_shell {
            let mut c = Command::new("cmd");
            c.arg("/C");
            c.arg(program);
            c
        } else {
            Command::new(program)
        };
        for arg in args {
            c.arg(arg);
        }
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(program);
        for arg in args {
            c.arg(arg);
        }
        c
    };

    cmd.env("NODE_OPTIONS", "--openssl-legacy-provider");
    cmd.current_dir(cwd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动命令 {} 失败: {}", program, e))?;

    let stdout = child.stdout.take().ok_or("无法捕获 stdout")?;
    let stderr = child.stderr.take().ok_or("无法捕获 stderr")?;

    let app_out = app.clone();
    let event_out = event_name.to_string();
    let stdout_handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(event_out.as_str(), &line);
        }
    });

    let app_err = app.clone();
    let event_err = event_name.to_string();
    let stderr_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(event_err.as_str(), &line);
        }
    });

    // 轮询等待子进程退出，同时监听取消信号
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => return Err(format!("等待命令完成失败: {}", e)),
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                // 让 child 彻底收尾
                let _ = child.wait().await;
                return Err("已取消".to_string());
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(150)) => {}
        }
    };

    let timeout = tokio::time::Duration::from_secs(5);
    let _ = tokio::time::timeout(timeout, stdout_handle).await;
    let _ = tokio::time::timeout(timeout, stderr_handle).await;

    if !status.success() {
        return Err(format!(
            "命令执行失败，退出码: {:?}",
            status.code()
        ));
    }

    Ok(())
}

fn strip_unc_prefix(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    if s.starts_with(r"\\?\") {
        std::path::PathBuf::from(&s[4..])
    } else {
        p.to_path_buf()
    }
}

// ==================== 腾讯云 COS 原生上传 (v5 签名) ====================

fn sha1_hex(data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn hmac_sha1_hex(key: &[u8], data: &[u8]) -> String {
    let mut mac = HmacSha1::new_from_slice(key).expect("HMAC accepts any key size");
    mac.update(data);
    hex::encode(mac.finalize().into_bytes())
}

/// 按 COS 规范对 URL 路径做 encode：保留 `/`，其余字符用 %XX
fn cos_encode_path(key: &str) -> String {
    key.split('/')
        .map(|seg| urlencoding::encode(seg).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// 生成 COS PUT Object 请求签名（只签 host 头，v5 算法）
/// 参考：https://cloud.tencent.com/document/product/436/7778
///
/// 注意：COS 服务端验签用的是 **URL 解码后** 的原始路径与 header，所以
/// `UriPathname` 与 `http_headers` 必须用原始字符串，而不是 URL-encoded 后的。
fn build_cos_authorization(
    secret_id: &str,
    secret_key: &str,
    method: &str, // lowercase, e.g. "put"
    key: &str,    // 对象 key，如 "assets/main.js"，无前导 /
    host: &str,
) -> String {
    let now = Utc::now().timestamp();
    let start = now - 60;
    let end = now + 3600;
    let key_time = format!("{};{}", start, end);

    let sign_key = hmac_sha1_hex(secret_key.as_bytes(), key_time.as_bytes());

    let uri_pathname = format!("/{}", key);
    let header_list = "host";
    let http_headers = format!("host={}", host);

    let http_string = format!("{}\n{}\n\n{}\n", method, uri_pathname, http_headers);
    let string_to_sign = format!(
        "sha1\n{}\n{}\n",
        key_time,
        sha1_hex(http_string.as_bytes())
    );

    let signature = hmac_sha1_hex(sign_key.as_bytes(), string_to_sign.as_bytes());

    format!(
        "q-sign-algorithm=sha1&q-ak={sid}&q-sign-time={kt}&q-key-time={kt}&q-header-list={hl}&q-url-param-list=&q-signature={sig}",
        sid = secret_id,
        kt = key_time,
        hl = header_list,
        sig = signature,
    )
}

/// 判断错误是否值得重试（网络错误 / 5xx / 429 重试，其它不重试）
fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

async fn upload_single_file_to_cos(
    client: &reqwest::Client,
    secret_id: &str,
    secret_key: &str,
    bucket: &str,
    region: &str,
    key: &str,
    file_path: &std::path::Path,
    cancel: &CancellationToken,
) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err("已取消".to_string());
    }

    let body = tokio::fs::read(file_path)
        .await
        .map_err(|e| format!("读取文件失败: {}", e))?;

    let host = format!("{}.cos.{}.myqcloud.com", bucket, region);
    let url = format!("https://{}/{}", host, cos_encode_path(key));
    let content_type = mime_guess::from_path(key)
        .first_or_octet_stream()
        .to_string();

    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err: String = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        if cancel.is_cancelled() {
            return Err("已取消".to_string());
        }

        // 每次重试都重新签名，避免 key_time 过期
        let authorization = build_cos_authorization(secret_id, secret_key, "put", key, &host);

        // 显式设置 Content-Length，避免空文件 (如 Element Plus 按需生成的空 CSS)
        // 在 HTTP/2 下被省略该头导致 COS 返回 411 Length Required
        let send_fut = client
            .put(&url)
            .header("Authorization", &authorization)
            .header("Content-Type", &content_type)
            .header("Content-Length", body.len().to_string())
            .body(body.clone())
            .send();

        let send_result = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("已取消".to_string()),
            r = send_fut => r,
        };

        match send_result {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return Ok(());
                }
                let text = resp.text().await.unwrap_or_default();
                last_err = format!("COS 返回 {}: {}", status, text);
                if !is_retryable_status(status) {
                    return Err(last_err);
                }
            }
            Err(e) => {
                last_err = format!("HTTP 请求失败: {}", e);
            }
        }

        if attempt < MAX_ATTEMPTS {
            let delay_ms = 500u64 * (1u64 << (attempt - 1)); // 500ms, 1s
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("已取消".to_string()),
                _ = tokio::time::sleep(std::time::Duration::from_millis(delay_ms)) => {}
            }
        }
    }

    Err(format!("重试 {} 次后仍失败: {}", MAX_ATTEMPTS, last_err))
}

async fn upload_dir_to_cos(
    app: &AppHandle,
    event: &str,
    secret_id: &str,
    secret_key: &str,
    bucket: &str,
    region: &str,
    dist_path: &std::path::Path,
    cancel: &CancellationToken,
) -> Result<(), String> {
    if secret_id.trim().is_empty()
        || secret_key.trim().is_empty()
        || bucket.trim().is_empty()
        || region.trim().is_empty()
    {
        return Err("COS 凭证不完整：请检查 SecretId / SecretKey / Bucket / Region".to_string());
    }

    let mut files: Vec<(std::path::PathBuf, String)> = Vec::new();
    for entry in walkdir::WalkDir::new(dist_path) {
        let entry = entry.map_err(|e| format!("扫描目录失败: {}", e))?;
        if entry.file_type().is_file() {
            let abs = entry.path().to_path_buf();
            let rel = abs
                .strip_prefix(dist_path)
                .map_err(|e| format!("路径处理失败: {}", e))?;
            let key = rel.to_string_lossy().replace('\\', "/");
            files.push((abs, key));
        }
    }

    let total = files.len();
    if total == 0 {
        return Err("dist 目录为空，没有可上传的文件".to_string());
    }
    let _ = app.emit(event, format!("发现 {} 个文件待上传", total));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let concurrency = 8usize;
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let done_counter = Arc::new(AtomicU32::new(0));

    let mut handles = Vec::with_capacity(total);
    for (abs_path, key) in files {
        let sem = semaphore.clone();
        let client = client.clone();
        let secret_id = secret_id.to_string();
        let secret_key = secret_key.to_string();
        let bucket = bucket.to_string();
        let region = region.to_string();
        let app = app.clone();
        let event = event.to_string();
        let counter = done_counter.clone();
        let cancel = cancel.clone();

        let handle = tokio::spawn(async move {
            if cancel.is_cancelled() {
                return Err("已取消".to_string());
            }
            let _permit = sem.acquire().await.map_err(|e| format!("并发控制失败: {}", e))?;
            upload_single_file_to_cos(
                &client,
                &secret_id,
                &secret_key,
                &bucket,
                &region,
                &key,
                &abs_path,
                &cancel,
            )
            .await
            .map_err(|e| format!("上传 {} 失败: {}", key, e))?;

            let done = counter.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = app.emit(
                event.as_str(),
                format!("  [{}/{}] ✓ {}", done, total, key),
            );
            Ok::<(), String>(())
        });
        handles.push(handle);
    }

    let mut errors: Vec<String> = Vec::new();
    let mut cancelled_count: usize = 0;
    for h in handles {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if e.contains("已取消") {
                    cancelled_count += 1;
                } else {
                    errors.push(e);
                }
            }
            Err(e) => errors.push(format!("任务调度失败: {}", e)),
        }
    }

    // 如果是用户主动取消，返回统一的取消错误
    if cancel.is_cancelled() {
        return Err("已取消".to_string());
    }

    let _ = cancelled_count; // 未取消时忽略

    if !errors.is_empty() {
        const MAX_SHOWN: usize = 5;
        let shown = errors.len().min(MAX_SHOWN);
        let head = errors[..shown].join("\n");
        let remaining = errors.len().saturating_sub(shown);
        let summary = if remaining > 0 {
            format!("{} 个文件上传失败。前 {} 条错误:\n{}\n... 另有 {} 条省略", errors.len(), shown, head, remaining)
        } else {
            format!("{} 个文件上传失败:\n{}", errors.len(), head)
        };
        return Err(summary);
    }
    Ok(())
}

#[tauri::command]
async fn run_build_and_deploy(app: AppHandle, params: DeployParams) -> Result<(), String> {
    let project_path = std::path::PathBuf::from(&params.project_dir);

    if !project_path.is_dir() {
        return Err(format!("目录不存在: {}", params.project_dir));
    }
    if !project_path.join("package.json").is_file() {
        return Err("目标目录中未找到 package.json".to_string());
    }

    let event: String = format!("deploy-log-{}", params.deploy_id);
    let event = event.as_str();

    // 注册取消 token
    let cancel = CancellationToken::new();
    {
        let mut map = DEPLOY_CANCEL_TOKENS.lock().await;
        map.insert(params.deploy_id.clone(), cancel.clone());
    }

    // 包装：无论成败都记得清理 token
    let result = run_build_and_deploy_inner(&app, event, &params, &project_path, &cancel).await;

    {
        let mut map = DEPLOY_CANCEL_TOKENS.lock().await;
        map.remove(&params.deploy_id);
    }

    result
}

async fn run_build_and_deploy_inner(
    app: &AppHandle,
    event: &str,
    params: &DeployParams,
    project_path: &std::path::Path,
    cancel: &CancellationToken,
) -> Result<(), String> {
    // ===== Step 1: Build =====
    let _ = app.emit(event, "[1/5] 正在执行 build 命令...");

    let build_cmd = params
        .build_command
        .as_deref()
        .unwrap_or("npm run build");
    let parts: Vec<&str> = build_cmd.split_whitespace().collect();
    if parts.is_empty() {
        return Err("build 命令不能为空".to_string());
    }

    run_shell_command(app, parts[0], &parts[1..], project_path, event, cancel)
        .await
        .map_err(|e| {
            if e == "已取消" {
                e
            } else {
                format!("Build 失败: {}", e)
            }
        })?;

    let dist_path = project_path.join("dist");
    if !dist_path.is_dir() {
        return Err("Build 完成但未找到 dist 目录".to_string());
    }

    let _ = app.emit(event, "[1/5] Build 完成 ✓");

    if cancel.is_cancelled() {
        return Err("已取消".to_string());
    }

    // ===== Step 2: Upload to COS (native Rust, no Node.js required) =====
    let _ = app.emit(event, "[2/5] 正在上传文件到 COS...");

    let clean_dist = strip_unc_prefix(&dist_path);
    upload_dir_to_cos(
        app,
        event,
        &params.cos_secret_id,
        &params.cos_secret_key,
        &params.cos_bucket,
        &params.cos_region,
        &clean_dist,
        cancel,
    )
    .await
    .map_err(|e| {
        if e == "已取消" {
            e
        } else {
            format!("COS 上传失败: {}", e)
        }
    })?;

    let _ = app.emit(event, "[2/5] COS 上传完成 ✓");

    if cancel.is_cancelled() {
        return Err("已取消".to_string());
    }

    if let Some(domain) = params.cdn_domain.as_deref()
        .map(|d| d.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/'))
        .filter(|d| !d.is_empty())
    {
        // ===== Step 3: Purge URL Cache =====
        let _ = app.emit(event, "[3/5] 正在刷新 URL 缓存...");

        let purge_url_payload = serde_json::json!({
            "Urls": [format!("http://{domain}/"), format!("https://{domain}/")]
        })
        .to_string();

        call_tencent_cdn_api(
            &params.cdn_secret_id,
            &params.cdn_secret_key,
            "PurgeUrlsCache",
            &purge_url_payload,
        )
        .await?;

        let _ = app.emit(event, "[3/5] URL 缓存刷新完成 ✓");

        // ===== Step 4: Purge Directory Cache =====
        let _ = app.emit(event, "[4/5] 正在刷新目录缓存...");

        let purge_dir_payload = serde_json::json!({
            "Paths": [format!("http://{domain}/"), format!("https://{domain}/")],
            "FlushType": "flush"
        })
        .to_string();

        call_tencent_cdn_api(
            &params.cdn_secret_id,
            &params.cdn_secret_key,
            "PurgePathCache",
            &purge_dir_payload,
        )
        .await?;

        let _ = app.emit(event, "[4/5] 目录缓存刷新完成 ✓");

        // ===== Step 5: Preheat URL =====
        let _ = app.emit(event, "[5/5] 正在预热 URL...");

        let preheat_payload = serde_json::json!({
            "Urls": [format!("http://{domain}/"), format!("https://{domain}/")],
            "Area": "mainland"
        })
        .to_string();

        call_tencent_cdn_api(
            &params.cdn_secret_id,
            &params.cdn_secret_key,
            "PushUrlsCache",
            &preheat_payload,
        )
        .await?;

        let _ = app.emit(event, "[5/5] URL 预热完成 ✓");
    } else {
        let _ = app.emit(event, "[3-5/5] 未配置 CDN 域名，跳过 CDN 刷新和预热 ✓");
    }

    let _ = app.emit(event, "🎉 全部部署流程完成！");

    Ok(())
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path)
        .map_err(|e| format!("读取文件失败: {} ({})", path, e))
}

#[tauri::command]
async fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败: {} ({})", parent.display(), e))?;
        }
    }
    std::fs::write(&path, content).map_err(|e| format!("写入文件失败: {} ({})", path, e))
}

// ==================== 操作日志落盘（写入安装根目录 / exe 同级目录） ====================

/// 前端上报的一条操作日志（time 为前端已按本地时区格式化好的字符串）。
#[derive(serde::Deserialize)]
struct OperationLogRecord {
    time: String,
    #[serde(rename = "pageLabel")]
    page_label: String,
    action: String,
    status: String,
    #[serde(default)]
    detail: String,
}

/// 操作日志文件路径。
/// 若传入自定义目录 `dir` 则写到该目录，否则默认与 exe 同级（安装后即“安装根目录”）。
fn operation_log_file(dir: Option<&str>) -> Result<std::path::PathBuf, String> {
    let base = match dir {
        Some(d) if !d.trim().is_empty() => std::path::PathBuf::from(d),
        _ => {
            let exe =
                std::env::current_exe().map_err(|e| format!("无法获取 exe 路径: {}", e))?;
            exe.parent()
                .ok_or("无法获取 exe 所在目录")?
                .to_path_buf()
        }
    };
    Ok(base.join("operation-logs.log"))
}

/// 追加写入一条操作日志到磁盘，返回日志文件的绝对路径。
/// `dir` 为可选的自定义目录，不传则写到安装根目录。
#[tauri::command]
fn append_operation_log(record: OperationLogRecord, dir: Option<String>) -> Result<String, String> {
    use std::io::Write;
    let path = operation_log_file(dir.as_deref())?;
    // 确保目标目录存在（自定义目录可能尚未创建）
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建日志目录 {}: {}", parent.display(), e))?;
    }
    let status_text = match record.status.as_str() {
        "success" => "成功",
        "error" => "失败",
        _ => "信息",
    };
    let detail = if record.detail.trim().is_empty() {
        String::new()
    } else {
        format!(" -> {}", record.detail)
    };
    let line = format!(
        "[{}] [{}] [{}] {}{}\n",
        record.time, record.page_label, status_text, record.action, detail
    );
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("无法打开日志文件 {}: {}", path.display(), e))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("写入日志失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// 获取操作日志文件路径（供前端展示）。
#[tauri::command]
fn get_operation_log_path(dir: Option<String>) -> Result<String, String> {
    Ok(operation_log_file(dir.as_deref())?
        .to_string_lossy()
        .to_string())
}

/// 清空磁盘上的操作日志文件。
#[tauri::command]
fn clear_operation_log_file(dir: Option<String>) -> Result<(), String> {
    let path = operation_log_file(dir.as_deref())?;
    if path.exists() {
        std::fs::write(&path, b"")
            .map_err(|e| format!("清空日志文件失败: {}", e))?;
    }
    Ok(())
}

/// 在系统文件管理器中定位日志文件（Windows 用资源管理器选中该文件）。
#[tauri::command]
fn reveal_operation_log(dir: Option<String>) -> Result<(), String> {
    let path = operation_log_file(dir.as_deref())?;
    #[cfg(target_os = "windows")]
    {
        let arg = if path.exists() {
            format!("/select,{}", path.display())
        } else {
            path.parent()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| path.display().to_string())
        };
        std::process::Command::new("explorer")
            .arg(arg)
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        let target = if path.exists() {
            path.clone()
        } else {
            path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| path.clone())
        };
        std::process::Command::new("open")
            .arg("-R")
            .arg(target)
            .spawn()
            .map_err(|e| format!("打开访达失败: {}", e))?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
    }
    Ok(())
}

// ==================== SSH 远程命令执行 ====================

#[derive(serde::Deserialize)]
struct SshServer {
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key_path: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct SshResult {
    host: String,
    name: String,
    success: bool,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
}

#[derive(serde::Serialize, Clone)]
struct SshProgress {
    host: String,
    status: String,
    message: String,
}

fn run_ssh_single(server: &SshServer, command: &str) -> SshResult {
    let addr = format!("{}:{}", server.host, server.port);
    let tcp = match std::net::TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| {
            format!("{}:{}", server.host, server.port)
                .parse()
                .unwrap()
        }),
        std::time::Duration::from_secs(10),
    ) {
        Ok(s) => s,
        Err(e) => {
            return SshResult {
                host: server.host.clone(),
                name: String::new(),
                success: false,
                stdout: String::new(),
                stderr: format!("连接失败: {}", e),
                exit_code: None,
            };
        }
    };

    let mut sess = match ssh2::Session::new() {
        Ok(s) => s,
        Err(e) => {
            return SshResult {
                host: server.host.clone(),
                name: String::new(),
                success: false,
                stdout: String::new(),
                stderr: format!("创建 SSH 会话失败: {}", e),
                exit_code: None,
            };
        }
    };

    sess.set_tcp_stream(tcp);
    if let Err(e) = sess.handshake() {
        return SshResult {
            host: server.host.clone(),
            name: String::new(),
            success: false,
            stdout: String::new(),
            stderr: format!("SSH 握手失败: {}", e),
            exit_code: None,
        };
    }

    let auth_result = if server.auth_type == "key" {
        if let Some(key_path) = &server.private_key_path {
            sess.userauth_pubkey_file(
                &server.username,
                None,
                std::path::Path::new(key_path),
                server.password.as_deref(),
            )
        } else {
            Err(ssh2::Error::from_errno(ssh2::ErrorCode::Session(-1)))
        }
    } else {
        sess.userauth_password(
            &server.username,
            server.password.as_deref().unwrap_or(""),
        )
    };

    if let Err(e) = auth_result {
        return SshResult {
            host: server.host.clone(),
            name: String::new(),
            success: false,
            stdout: String::new(),
            stderr: format!("认证失败: {}", e),
            exit_code: None,
        };
    }

    let mut channel = match sess.channel_session() {
        Ok(c) => c,
        Err(e) => {
            return SshResult {
                host: server.host.clone(),
                name: String::new(),
                success: false,
                stdout: String::new(),
                stderr: format!("创建通道失败: {}", e),
                exit_code: None,
            };
        }
    };

    if let Err(e) = channel.exec(command) {
        return SshResult {
            host: server.host.clone(),
            name: String::new(),
            success: false,
            stdout: String::new(),
            stderr: format!("执行命令失败: {}", e),
            exit_code: None,
        };
    }

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();

    use std::io::Read;
    let _ = channel.read_to_string(&mut stdout_buf);
    let _ = channel.stderr().read_to_string(&mut stderr_buf);

    let _ = channel.wait_close();
    let exit_code = channel.exit_status().ok();
    let success = exit_code == Some(0);

    SshResult {
        host: server.host.clone(),
        name: String::new(),
        success,
        stdout: stdout_buf,
        stderr: stderr_buf,
        exit_code,
    }
}

#[tauri::command]
async fn execute_ssh_commands(
    app: AppHandle,
    servers: Vec<SshServer>,
    command: String,
    session_id: String,
) -> Result<Vec<SshResult>, String> {
    let event_name = format!("ssh-progress-{}", session_id);
    let mut results = Vec::new();

    for server in &servers {
        let _ = app.emit(
            event_name.as_str(),
            SshProgress {
                host: server.host.clone(),
                status: "connecting".to_string(),
                message: format!("正在连接 {}...", server.host),
            },
        );

        let result = {
            let s = SshServer {
                host: server.host.clone(),
                port: server.port,
                username: server.username.clone(),
                auth_type: server.auth_type.clone(),
                password: server.password.clone(),
                private_key_path: server.private_key_path.clone(),
            };
            let cmd = command.clone();
            tokio::task::spawn_blocking(move || run_ssh_single(&s, &cmd))
                .await
                .map_err(|e| format!("任务执行失败: {}", e))?
        };

        let status = if result.success { "success" } else { "error" };
        let _ = app.emit(
            event_name.as_str(),
            SshProgress {
                host: server.host.clone(),
                status: status.to_string(),
                message: if result.success {
                    "执行完成".to_string()
                } else {
                    result.stderr.clone()
                },
            },
        );

        results.push(result);
    }

    Ok(results)
}

#[tauri::command]
async fn test_ssh_connection(server: SshServer) -> Result<String, String> {
    let result = tokio::task::spawn_blocking(move || run_ssh_single(&server, "echo ok"))
        .await
        .map_err(|e| format!("测试失败: {}", e))?;

    if result.success {
        Ok("连接成功".to_string())
    } else {
        Err(result.stderr)
    }
}

// ==================== Git Pipeline ====================

#[derive(serde::Serialize, Clone)]
struct ChangedFile {
    status: String,
    path: String,
}

#[derive(serde::Serialize, Clone)]
struct GitStatus {
    path: String,
    name: String,
    is_repo: bool,
    branch: Option<String>,
    remote: Option<String>,
    ahead: u32,
    behind: u32,
    modified: u32,
    added: u32,
    deleted: u32,
    renamed: u32,
    untracked: u32,
    conflicted: u32,
    files: Vec<ChangedFile>,
    error: Option<String>,
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 同步执行 git 命令并返回 (exit_code, stdout, stderr)
fn run_git_sync(
    cwd: &std::path::Path,
    args: &[&str],
) -> Result<(i32, String, String), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args);
    cmd.current_dir(cwd);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("执行 git 失败: {} (请确认已安装 git)", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let code = output.status.code().unwrap_or(-1);
    Ok((code, stdout, stderr))
}

fn parse_porcelain_line(line: &str) -> Option<ChangedFile> {
    if line.len() < 3 {
        return None;
    }
    let status = &line[..2];
    let path = line[3..].trim().to_string();
    Some(ChangedFile {
        status: status.to_string(),
        path,
    })
}

/// 并行采集 git 状态时的最大工作线程数
const GIT_STATUS_WORKERS: usize = 8;

fn empty_git_status(path: String, name: String, error: Option<String>) -> GitStatus {
    GitStatus {
        path,
        name,
        is_repo: false,
        branch: None,
        remote: None,
        ahead: 0,
        behind: 0,
        modified: 0,
        added: 0,
        deleted: 0,
        renamed: 0,
        untracked: 0,
        conflicted: 0,
        files: vec![],
        error,
    }
}

fn git_change_total(s: &GitStatus) -> u32 {
    s.modified + s.added + s.deleted + s.renamed + s.untracked + s.conflicted
}

/// 采集单个目录的 git 状态（阻塞式）
fn collect_git_status(p: &str) -> GitStatus {
    let path = std::path::PathBuf::from(p);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    if !path.is_dir() {
        return empty_git_status(p.to_string(), name, Some("目录不存在".to_string()));
    }

    let is_repo = run_git_sync(&path, &["rev-parse", "--is-inside-work-tree"])
        .map(|(c, s, _)| c == 0 && s.trim() == "true")
        .unwrap_or(false);

    if !is_repo {
        return empty_git_status(p.to_string(), name, Some("不是 git 仓库".to_string()));
    }

    let branch = run_git_sync(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|(c, _, _)| *c == 0)
        .map(|(_, s, _)| s.trim().to_string());

    let remote = run_git_sync(&path, &["remote", "get-url", "origin"])
        .ok()
        .filter(|(c, _, _)| *c == 0)
        .map(|(_, s, _)| s.trim().to_string());

    // ahead / behind
    let (mut ahead, mut behind) = (0u32, 0u32);
    if let Ok((c, out, _)) = run_git_sync(
        &path,
        &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
    ) {
        if c == 0 {
            let parts: Vec<&str> = out.trim().split_whitespace().collect();
            if parts.len() == 2 {
                behind = parts[0].parse().unwrap_or(0);
                ahead = parts[1].parse().unwrap_or(0);
            }
        }
    }

    // 变更文件
    let mut files: Vec<ChangedFile> = Vec::new();
    let (mut modified, mut added, mut deleted, mut renamed, mut untracked, mut conflicted) =
        (0u32, 0u32, 0u32, 0u32, 0u32, 0u32);
    if let Ok((c, out, _)) = run_git_sync(
        &path,
        &["-c", "core.quotepath=false", "status", "--porcelain=v1"],
    ) {
        if c == 0 {
            for line in out.lines() {
                if let Some(f) = parse_porcelain_line(line) {
                    let s = f.status.as_bytes();
                    if s == b"??" {
                        untracked += 1;
                    } else if s[0] == b'U' || s[1] == b'U' || s == b"AA" || s == b"DD" {
                        conflicted += 1;
                    } else {
                        if matches!(s[0], b'A') || matches!(s[1], b'A') {
                            added += 1;
                        } else if matches!(s[0], b'D') || matches!(s[1], b'D') {
                            deleted += 1;
                        } else if matches!(s[0], b'R') || matches!(s[1], b'R') {
                            renamed += 1;
                        } else if matches!(s[0], b'M') || matches!(s[1], b'M') {
                            modified += 1;
                        }
                    }
                    files.push(f);
                }
            }
        }
    }

    GitStatus {
        path: p.to_string(),
        name,
        is_repo: true,
        branch,
        remote,
        ahead,
        behind,
        modified,
        added,
        deleted,
        renamed,
        untracked,
        conflicted,
        files,
        error: None,
    }
}

/// 多线程并行采集一批目录的 git 状态，返回顺序与输入一致
fn collect_statuses_parallel(paths: &[String]) -> Vec<GitStatus> {
    let total = paths.len();
    if total == 0 {
        return Vec::new();
    }
    let workers = std::cmp::min(GIT_STATUS_WORKERS, total);
    let cursor = std::sync::atomic::AtomicUsize::new(0);
    let slots: std::sync::Mutex<Vec<Option<GitStatus>>> = std::sync::Mutex::new(vec![None; total]);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let i = cursor.fetch_add(1, Ordering::SeqCst);
                if i >= total {
                    break;
                }
                let st = collect_git_status(&paths[i]);
                if let Ok(mut guard) = slots.lock() {
                    guard[i] = Some(st);
                }
            });
        }
    });

    slots
        .into_inner()
        .map(|v| v.into_iter().flatten().collect())
        .unwrap_or_default()
}

#[tauri::command]
async fn check_git_status(paths: Vec<String>) -> Result<Vec<GitStatus>, String> {
    tokio::task::spawn_blocking(move || collect_statuses_parallel(&paths))
        .await
        .map_err(|e| format!("任务执行失败: {}", e))
}

// ==================== 目录扫描：批量发现 git 仓库 ====================

const GIT_SCAN_DEFAULT_DEPTH: u32 = 3;
const GIT_SCAN_MAX_REPOS: usize = 400;

/// 扫描时直接跳过的目录名（依赖/构建产物等，内部不可能是独立项目仓库）
const GIT_SCAN_SKIP_DIRS: &[&str] = &[
    "node_modules",
    "bower_components",
    "dist",
    "build",
    "target",
    "out",
    "output",
    "coverage",
    "vendor",
    "__pycache__",
    "venv",
    "env",
    "Pods",
    "Library",
    "AppData",
];

/// 被省略条目的上报上限，避免一次返回过多内容
const GIT_SCAN_MAX_SKIPPED: usize = 600;

/// 扫描过程中被省略（没有 git 关联）的条目
#[derive(serde::Serialize, Clone)]
struct SkippedEntry {
    path: String,
    name: String,
    /// file = 文件；dir = 文件夹但没有 git；ignored = 依赖/产物/隐藏目录，直接跳过
    kind: String,
    reason: String,
}

struct ScanCtx {
    repos: Vec<String>,
    skipped: Vec<SkippedEntry>,
    /// 省略条目总数（可能大于 skipped.len()，因为有上报上限）
    skipped_total: u32,
    max_depth: u32,
    truncated: bool,
    /// 前端维护的"跳过检测"清单，命中后既不进入结果也不再上报
    skip: std::collections::HashSet<String>,
}

/// 统一路径写法便于比对：反斜杠转正斜杠，Windows 下忽略大小写
fn normalize_scan_path(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(target_os = "windows") {
        s.to_lowercase()
    } else {
        s
    }
}

impl ScanCtx {
    fn record_skipped(&mut self, path: &std::path::Path, name: &str, kind: &str, reason: &str) {
        self.skipped_total += 1;
        if self.skipped.len() < GIT_SCAN_MAX_SKIPPED {
            self.skipped.push(SkippedEntry {
                path: path.to_string_lossy().to_string(),
                name: name.to_string(),
                kind: kind.to_string(),
                reason: reason.to_string(),
            });
        }
    }
}

/// 递归扫描目录，收集 git 仓库以及被省略的条目。
/// - 目录内存在 `.git` 即视为仓库，且不再深入其内部（避免把子模块/内部目录当成独立项目）
/// - 文件、隐藏目录、依赖/构建目录直接省略
/// - 整棵子树都没有仓库时，只把这个子树的顶层目录记为一条省略项，不再逐个展开里面的内容
///
/// 返回该目录（含子树）是否包含 git 仓库。
fn walk_git_repos(ctx: &mut ScanCtx, dir: &std::path::Path, depth: u32, limit: usize) -> bool {
    if ctx.repos.len() >= limit {
        ctx.truncated = true;
        return false;
    }

    if dir.join(".git").exists() {
        ctx.repos.push(dir.to_string_lossy().to_string());
        return true;
    }

    if depth >= ctx.max_depth {
        return false;
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };

    // 本层的省略项先攒着：只有当这一层确实通往真实仓库时才上报，
    // 否则整个子树会由上层合并成一条记录
    let mut pending: Vec<(std::path::PathBuf, String, &'static str, &'static str)> = Vec::new();
    let mut child_dirs: Vec<(std::path::PathBuf, String)> = Vec::new();

    for entry in entries.flatten() {
        let raw_name = entry.file_name();
        let name = match raw_name.to_str() {
            Some(n) => n.to_string(),
            None => continue,
        };
        let path = entry.path();

        // 已被加入"跳过检测"的条目：既不遍历也不上报
        if !ctx.skip.is_empty()
            && ctx
                .skip
                .contains(&normalize_scan_path(&path.to_string_lossy()))
        {
            continue;
        }

        // file_type 不跟随符号链接，可天然避免软链接成环
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if !is_dir {
            pending.push((path, name, "file", "文件，不是项目目录"));
            continue;
        }
        if name.starts_with('.') {
            pending.push((path, name, "ignored", "隐藏目录，已跳过"));
            continue;
        }
        if GIT_SCAN_SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
            pending.push((path, name, "ignored", "依赖 / 构建产物目录，已跳过"));
            continue;
        }
        child_dirs.push((path, name));
    }

    let mut found_any = false;
    for (path, name) in child_dirs {
        if walk_git_repos(ctx, &path, depth + 1, limit) {
            found_any = true;
        } else {
            pending.push((path, name, "dir", "文件夹，没有 git 关联"));
        }
    }

    // 根目录始终上报，便于用户确认"这个目录里到底有什么被跳过了"
    if found_any || depth == 0 {
        for (path, name, kind, reason) in pending {
            ctx.record_skipped(&path, &name, kind, reason);
        }
    }

    found_any
}

#[derive(serde::Serialize)]
struct GitScanResult {
    /// 扫描发现的 git 仓库状态（按路径升序）
    repos: Vec<GitStatus>,
    /// 发现的 git 仓库总数
    total: u32,
    /// 其中存在工作区改动的仓库数
    changed: u32,
    /// 是否因为仓库数量上限而截断
    truncated: bool,
    /// 被省略的文件/无 git 文件夹（最多 600 条）
    skipped: Vec<SkippedEntry>,
    /// 被省略条目的实际总数
    skipped_total: u32,
}

/// 扫描一个或多个根目录，找出其中所有 git 仓库并返回它们的状态。
/// 非 git 的目录与文件不会出现在结果中，`skip_paths` 里的条目会被直接忽略。
#[tauri::command]
async fn scan_git_repos(
    roots: Vec<String>,
    max_depth: Option<u32>,
    skip_paths: Option<Vec<String>>,
) -> Result<GitScanResult, String> {
    if roots.is_empty() {
        return Err("请先选择要扫描的根目录".to_string());
    }
    let depth = max_depth.unwrap_or(GIT_SCAN_DEFAULT_DEPTH).clamp(1, 8);

    tokio::task::spawn_blocking(move || {
        let skip: std::collections::HashSet<String> = skip_paths
            .unwrap_or_default()
            .iter()
            .map(|p| normalize_scan_path(p))
            .collect();

        let mut ctx = ScanCtx {
            repos: Vec::new(),
            skipped: Vec::new(),
            skipped_total: 0,
            max_depth: depth,
            truncated: false,
            skip,
        };

        for root in &roots {
            let root_path = std::path::PathBuf::from(root);
            if !root_path.is_dir() {
                continue;
            }
            walk_git_repos(&mut ctx, &root_path, 0, GIT_SCAN_MAX_REPOS);
        }

        // 多个根目录可能相互嵌套，去重后再采集状态
        let mut paths = ctx.repos;
        paths.sort();
        paths.dedup();

        let mut skipped = ctx.skipped;
        skipped.sort_by(|a, b| a.path.cmp(&b.path));

        let repos = collect_statuses_parallel(&paths);
        let total = repos.len() as u32;
        let changed = repos
            .iter()
            .filter(|r| r.is_repo && git_change_total(r) > 0)
            .count() as u32;

        GitScanResult {
            repos,
            total,
            changed,
            truncated: ctx.truncated,
            skipped,
            skipped_total: ctx.skipped_total,
        }
    })
    .await
    .map_err(|e| format!("扫描任务执行失败: {}", e))
}

/// 简易 shell 风格命令解析：支持双/单引号 & 反斜杠转义
fn split_command_line(cmd: &str) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quote: Option<char> = None;
    let mut started = false;
    let mut chars = cmd.chars().peekable();
    while let Some(c) = chars.next() {
        match in_quote {
            Some(q) => {
                if c == q {
                    in_quote = None;
                } else if c == '\\' && q == '"' {
                    if let Some(&next) = chars.peek() {
                        if next == '"' || next == '\\' {
                            cur.push(next);
                            chars.next();
                            continue;
                        }
                    }
                    cur.push(c);
                } else {
                    cur.push(c);
                }
            }
            None => match c {
                '"' | '\'' => {
                    in_quote = Some(c);
                    started = true;
                }
                '\\' => {
                    if let Some(next) = chars.next() {
                        cur.push(next);
                        started = true;
                    }
                }
                c if c.is_whitespace() => {
                    if started {
                        args.push(std::mem::take(&mut cur));
                        started = false;
                    }
                }
                c => {
                    cur.push(c);
                    started = true;
                }
            },
        }
    }
    if in_quote.is_some() {
        return Err("命令中存在未闭合的引号".to_string());
    }
    if started {
        args.push(cur);
    }
    if args.is_empty() {
        return Err("命令为空".to_string());
    }
    Ok(args)
}

#[derive(serde::Deserialize, Clone)]
struct PipelineStep {
    name: String,
    command: String,
    enabled: bool,
    #[serde(rename = "continueOnError", default)]
    continue_on_error: bool,
    #[serde(rename = "allowEmptyCommit", default)]
    allow_empty_commit: bool,
}

#[derive(serde::Deserialize)]
struct RunPipelineParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    repos: Vec<String>,
    steps: Vec<PipelineStep>,
    #[serde(rename = "onRepoError", default)]
    on_repo_error: Option<String>,
}

#[tauri::command]
async fn cancel_git_pipeline(session_id: String) -> Result<(), String> {
    let mut map = PIPELINE_CANCEL_TOKENS.lock().await;
    if let Some(token) = map.remove(&session_id) {
        token.cancel();
    }
    Ok(())
}

/// 在指定工作目录执行单条命令，实时把 stdout/stderr 推到事件里
async fn run_pipeline_step(
    app: &AppHandle,
    event: &str,
    cwd: &std::path::Path,
    command: &str,
    cancel: &CancellationToken,
) -> Result<(i32, String, String), String> {
    let argv = split_command_line(command)?;
    let program = &argv[0];
    let args: Vec<&str> = argv[1..].iter().map(|s| s.as_str()).collect();

    // Windows 下 npm/pnpm/yarn/npx 需要走 cmd /C
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let needs_shell = matches!(
            program.as_str(),
            "npm" | "npx" | "pnpm" | "yarn" | "cnpm" | "bun"
        );
        let mut c = if needs_shell {
            let mut c = Command::new("cmd");
            c.arg("/C");
            c.arg(program);
            c
        } else {
            Command::new(program)
        };
        for a in &args {
            c.arg(a);
        }
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(program);
        for a in &args {
            c.arg(a);
        }
        c
    };

    cmd.current_dir(cwd);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动命令 {} 失败: {}", program, e))?;

    let stdout = child.stdout.take().ok_or("无法捕获 stdout")?;
    let stderr = child.stderr.take().ok_or("无法捕获 stderr")?;

    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));

    let out_app = app.clone();
    let out_event = event.to_string();
    let out_buf = stdout_buf.clone();
    let out_handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            {
                let mut b = out_buf.lock().await;
                b.push_str(&line);
                b.push('\n');
            }
            let _ = out_app.emit(out_event.as_str(), &line);
        }
    });

    let err_app = app.clone();
    let err_event = event.to_string();
    let err_buf = stderr_buf.clone();
    let err_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            {
                let mut b = err_buf.lock().await;
                b.push_str(&line);
                b.push('\n');
            }
            let _ = err_app.emit(err_event.as_str(), &line);
        }
    });

    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {}
            Err(e) => return Err(format!("等待命令完成失败: {}", e)),
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err("已取消".to_string());
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(150)) => {}
        }
    };

    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), out_handle).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), err_handle).await;

    let so = stdout_buf.lock().await.clone();
    let se = stderr_buf.lock().await.clone();
    Ok((status.code().unwrap_or(-1), so, se))
}

#[tauri::command]
async fn run_git_pipeline(app: AppHandle, params: RunPipelineParams) -> Result<(), String> {
    let event = format!("git-pipeline-log-{}", params.session_id);
    let event = event.as_str();

    let cancel = CancellationToken::new();
    {
        let mut map = PIPELINE_CANCEL_TOKENS.lock().await;
        map.insert(params.session_id.clone(), cancel.clone());
    }

    let on_err = params
        .on_repo_error
        .clone()
        .unwrap_or_else(|| "stop-all".to_string());

    let result: Result<(), String> = async {
        for (repo_idx, repo) in params.repos.iter().enumerate() {
            if cancel.is_cancelled() {
                return Err("已取消".to_string());
            }
            let repo_path = std::path::PathBuf::from(repo);
            let repo_name = repo_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            let _ = app.emit(
                event,
                format!(
                    "\n━━━━━━ [{}/{}] {} ━━━━━━",
                    repo_idx + 1,
                    params.repos.len(),
                    if repo_name.is_empty() { repo.clone() } else { repo_name.clone() }
                ),
            );

            if !repo_path.is_dir() {
                let _ = app.emit(event, format!("✗ 目录不存在: {}", repo));
                if on_err == "stop-all" {
                    return Err(format!("目录不存在: {}", repo));
                }
                continue;
            }

            let mut repo_failed = false;
            for (step_idx, step) in params.steps.iter().enumerate() {
                if !step.enabled {
                    continue;
                }
                if cancel.is_cancelled() {
                    return Err("已取消".to_string());
                }

                let _ = app.emit(
                    event,
                    format!(
                        "\n▶ [{}/{}] {} :: $ {}",
                        step_idx + 1,
                        params.steps.len(),
                        step.name,
                        step.command
                    ),
                );

                let res =
                    run_pipeline_step(&app, event, &repo_path, &step.command, &cancel).await;

                match res {
                    Ok((code, stdout, stderr)) => {
                        if code == 0 {
                            let _ = app.emit(event, format!("  ✓ 完成 ({})", step.name));
                        } else {
                            // allow_empty_commit: 常见提示
                            let lower_out = stdout.to_lowercase();
                            let lower_err = stderr.to_lowercase();
                            let is_empty_commit = step.allow_empty_commit
                                && (lower_out.contains("nothing to commit")
                                    || lower_out.contains("no changes added to commit")
                                    || lower_out.contains("working tree clean")
                                    || lower_err.contains("nothing to commit")
                                    || lower_err.contains("无文件要提交"));

                            if is_empty_commit {
                                let _ = app.emit(
                                    event,
                                    format!("  ↷ 跳过 ({}): 无改动", step.name),
                                );
                                continue;
                            }

                            let _ = app.emit(
                                event,
                                format!("  ✗ 失败 exit={} ({})", code, step.name),
                            );
                            if step.continue_on_error {
                                continue;
                            }
                            repo_failed = true;
                            break;
                        }
                    }
                    Err(e) => {
                        if e == "已取消" {
                            return Err("已取消".to_string());
                        }
                        let _ = app.emit(event, format!("  ✗ 失败: {}", e));
                        if step.continue_on_error {
                            continue;
                        }
                        repo_failed = true;
                        break;
                    }
                }
            }

            if repo_failed {
                let _ = app.emit(event, format!("✗ 仓库 {} 执行失败", repo));
                match on_err.as_str() {
                    "stop-all" => return Err(format!("仓库 {} 执行失败，已中止", repo)),
                    _ => continue,
                }
            } else {
                let _ = app.emit(event, format!("✓ 仓库 {} 完成", repo));
            }
        }
        let _ = app.emit(event, "\n🎉 全部任务完成");
        Ok(())
    }
    .await;

    {
        let mut map = PIPELINE_CANCEL_TOKENS.lock().await;
        map.remove(&params.session_id);
    }

    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            run_wx_ribao,
            stop_wx_ribao,
            kill_python_script,
            run_release_version,
            run_build_and_deploy,
            cancel_deploy,
            read_text_file,
            write_text_file,
            append_operation_log,
            get_operation_log_path,
            clear_operation_log_file,
            reveal_operation_log,
            execute_ssh_commands,
            test_ssh_connection,
            check_git_status,
            scan_git_repos,
            run_git_pipeline,
            cancel_git_pipeline
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            if let Some(monitor) = window.current_monitor().ok().flatten() {
                let screen = monitor.size();
                let scale = monitor.scale_factor();
                let win_size = window.outer_size().unwrap_or(tauri::PhysicalSize::new(1000, 700));
                let x = ((screen.width as f64 - win_size.width as f64) / 2.0) as i32;
                let y = (screen.height as f64 / scale - win_size.height as f64 / scale - 48.0) as i32;
                let _ = window.set_position(PhysicalPosition::new(
                    (x as f64 * scale) as i32,
                    (y as f64 * scale) as i32,
                ));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
