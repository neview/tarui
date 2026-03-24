// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, MutexGuard};

static RUNNING_PID: AtomicU32 = AtomicU32::new(0);

lazy_static::lazy_static!(
    static ref CURRENT_CHILD: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
);

/// 从 exe 所在目录推导项目根目录（wx-ribao.py 与 cookies.txt 所在目录）
fn resolve_project_root() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法获取 exe 路径: {}", e))?;
    let exe_dir = exe
        .parent()
        .ok_or("无法获取 exe 所在目录")?
        .to_path_buf();
    // 先尝试 exe 同级目录（打包后脚本可与 exe 放一起），再尝试开发模式：向上 3 级到项目根
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
        let script = dir.join("wx-ribao.py");
        if script.is_file() {
            return dir.canonicalize().map_err(|e| {
                format!("项目根目录无效: {} ({})", dir.display(), e)
            });
        }
    }
    Err(format!(
        "未找到 wx-ribao.py，已检查: exe 同级及向上 3 级目录（如 {}）",
        exe_dir.display()
    ))
}

#[tauri::command]
async fn run_wx_ribao(app: AppHandle, params: Vec<String>) -> Result<(), String> {
    let python_path = std::env::var("PYTHON_PATH")
        .unwrap_or_else(|_| "python".to_string());

    {
        let child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        if child_lock.is_some() {
            return Err("已有脚本正在运行，请先停止".to_string());
        }
    }

    let project_root = resolve_project_root()?;
    let script_path = project_root.join("wx-ribao.py");
    if !script_path.is_file() {
        return Err(format!(
            "未找到脚本: {}，请确保 wx-ribao.py 在项目根目录",
            script_path.display()
        ));
    }
    let script_path = script_path
        .canonicalize()
        .map_err(|e| format!("脚本路径无效: {}", e))?;

    let mut cmd = Command::new(&python_path);
    cmd.arg(&script_path);
    for param in &params {
        cmd.arg(param);
    }
    cmd.current_dir(&project_root);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("启动 Python 进程失败: {}", e))?;

    if let Some(pid) = child.id() {
        RUNNING_PID.store(pid, Ordering::SeqCst);
    }

    let stdout = child.stdout.take().ok_or("无法捕获 stdout")?;
    let stderr = child.stderr.take().ok_or("无法捕获 stderr")?;

    {
        let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        *child_lock = Some(child);
    }

    let app_stdout = app.clone();
    let app_stderr = app.clone();

    let stdout_handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_stdout.emit("python-stdout", line);
        }
    });

    let stderr_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_stderr.emit("python-stderr", line);
        }
    });

    let status = {
        let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        if let Some(mut c) = child_lock.take() {
            RUNNING_PID.store(0, Ordering::SeqCst);
            drop(child_lock);
            c.wait().await.map_err(|e| format!("等待进程失败: {}", e))?
        } else {
            return Err("进程已被停止".to_string());
        }
    };

    let _ = stdout_handle.await;
    let _ = stderr_handle.await;

    if !status.success() {
        return Err(format!("Python 脚本执行失败，退出码: {:?}", status.code()));
    }

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

#[tauri::command]
async fn capture_qr_code(app: AppHandle) -> Result<String, String> {
    let python_path =
        std::env::var("PYTHON_PATH").unwrap_or_else(|_| "python".to_string());

    {
        let child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        if child_lock.is_some() {
            return Err("已有脚本正在运行，请先停止".to_string());
        }
    }

    let project_root = resolve_project_root()?;
    let script_path = project_root.join("wx-ribao.py");
    if !script_path.is_file() {
        return Err(format!(
            "未找到脚本: {}，请确保 wx-ribao.py 在项目根目录",
            script_path.display()
        ));
    }
    let script_path = script_path
        .canonicalize()
        .map_err(|e| format!("脚本路径无效: {}", e))?;

    let mut cmd = Command::new(&python_path);
    cmd.arg(&script_path);
    cmd.arg("--step").arg("qr");
    cmd.current_dir(&project_root);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 Python 进程失败: {}", e))?;

    let stdout = child.stdout.take().ok_or("无法捕获 stdout")?;
    let stderr = child.stderr.take().ok_or("无法捕获 stderr")?;

    {
        let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        *child_lock = Some(child);
    }

    let app_stdout = app.clone();
    let app_stderr = app.clone();

    // 在后台转发 stdout/stderr
    let _stdout_handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_stdout.emit("python-stdout", line);
        }
    });

    let _stderr_handle = tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_stderr.emit("python-stderr", line);
        }
    });

    // 等待进程结束
    {
        let mut child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        if let Some(mut c) = child_lock.take() {
            drop(child_lock);
            let status = c
                .wait().await
                .map_err(|e| format!("等待进程失败: {}", e))?;
            if !status.success() {
                return Err(format!("Python 脚本执行失败，退出码: {:?}", status.code()));
            }
        } else {
            return Err("进程已被停止".to_string());
        }
    }

    let qr_result = std::fs::read_to_string(project_root.join("qr_result_tmp.json"))
        .ok()
        .filter(|content| !content.trim().is_empty());

    if let Some(qr) = qr_result {
        Ok(qr)
    } else {
        Err("未找到二维码结果，请查看运行日志".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![run_wx_ribao, kill_python_script, capture_qr_code])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
