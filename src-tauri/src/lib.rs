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

#[tauri::command]
async fn run_python_script(
    app: AppHandle,
    script_path: String,
    params: Vec<String>,
) -> Result<(), String> {
    let python_path = std::env::var("PYTHON_PATH")
        .unwrap_or_else(|_| "python".to_string());

    {
        let child_lock: MutexGuard<'_, Option<Child>> = CURRENT_CHILD.lock().await;
        if child_lock.is_some() {
            return Err("已有脚本正在运行，请先停止".to_string());
        }
    }

    // 设置工作目录为脚本所在目录
    let script_dir = std::path::Path::new(&script_path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    let mut cmd = Command::new(&python_path);
    cmd.arg(&script_path);
    for param in &params {
        cmd.arg(param);
    }
    cmd.current_dir(&script_dir);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![run_python_script, kill_python_script])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
