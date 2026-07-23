# -*- coding: utf-8 -*-

import re
import os
import sys
import time
import json
import uuid
import logging
import traceback
import threading
import requests
from datetime import datetime
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

sys.stdout.reconfigure(encoding='utf-8', errors='ignore')
sys.stderr.reconfigure(encoding='utf-8', errors='ignore')

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')
logger = logging.getLogger(__name__)

# ============ Constants ============

QR_CODE_URL = "https://doc.weixin.qq.com/forms/j/AKUAmwcxAA4AMcALQaMABgCNxhNl1H9Mj_fork?page=5&_cef_tabid_=9f85d2b15d5507808aacc7beca28b7b7#/journal-answer/8?journaluuid=5tnb2GLSq3uGsirYomG29gnFa1Ew5qBh8eBREjWL4ARBFC71eYfN9QMQ9vboGRmWRM"
FORM_ID = QR_CODE_URL.split('/forms/j/')[1].split('?')[0]
COOKIES_FILE = 'cookies.txt'
QR_URL_PATTERN = re.compile(r'src=["\']([^"\']*?/qrcode\?key=[^"\']+)["\']')
BROWSER_ARGS = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--no-first-run',
]
LOGIN_TIMEOUT_S = 300

# ============ Session Management ============

_sessions = {}
_sessions_lock = threading.Lock()

# ============ Real-time Log ============

_thread_sessions = {}


class _Cancelled(Exception):
    pass


def _check_cancelled():
    tid = threading.current_thread().ident
    s = _thread_sessions.get(tid)
    if s and s.get('cancelled'):
        raise _Cancelled()


def _push_log(msg):
    logger.info(msg)
    tid = threading.current_thread().ident
    s = _thread_sessions.get(tid)
    if s is not None:
        s['logs'].append({
            'time': time.strftime('%H:%M:%S'),
            'msg': msg,
        })


# ============ Business State ============

_business_result = None
id = ''
strTime = ''
endTime = ''
conformList = []
index = 0
key = ''
cookies = ''
template_id = ''
format_type = 1
format_indent = False


def _reset_business_state(params):
    global _business_result, id, strTime, endTime, conformList, index, key, cookies, template_id, format_type, format_indent
    _business_result = None
    id = FORM_ID
    strTime = params.get('startDate', '')
    endTime = params.get('endDate', '')
    conformList = []
    index = 0
    key = ''
    cookies = ''
    template_id = ''
    format_type = int(params.get('outputFormat', 1)) if params.get('outputFormat') else 1
    format_indent = str(params.get('indentInTheLine', 'false')).lower() == 'true'


# ============ Browser Helpers ============

def _launch_chromium(pw):
    """跨平台启动浏览器，优先复用系统已装的 Edge/Chrome，避免打包/下载 Chromium。

    选择顺序：
    1. 环境变量 CHROMIUM_PATH 指定的可执行文件（显式优先）；
    2. 服务器（Linux/Docker）：系统安装的 /usr/bin/chromium；
    3. 本地脚本模式：系统已安装的 Edge / Chrome（channel），
       可用环境变量 BROWSER_CHANNEL 覆盖（如 "chrome" / "msedge"）；
    4. 兜底：Playwright 自带的 Chromium（需 `playwright install chromium`）。
    """
    launch_kwargs = {'headless': True, 'args': BROWSER_ARGS}

    # 1) 显式指定的可执行文件路径优先
    exec_path = os.environ.get('CHROMIUM_PATH', '').strip()
    if not exec_path and os.path.exists('/usr/bin/chromium'):
        # 2) 服务器环境
        exec_path = '/usr/bin/chromium'
    if exec_path:
        return pw.chromium.launch(executable_path=exec_path, **launch_kwargs)

    # 3) 本地：优先用系统浏览器渠道（无需下载 Chromium）
    env_channel = os.environ.get('BROWSER_CHANNEL', '').strip()
    channels = [env_channel] if env_channel else ['msedge', 'chrome']
    last_err = None
    for ch in channels:
        try:
            browser = pw.chromium.launch(channel=ch, **launch_kwargs)
            _push_log(f"已使用系统浏览器渠道: {ch}")
            return browser
        except Exception as e:
            last_err = e
            _push_log(f"未找到系统浏览器 {ch}，尝试下一个...")

    # 4) 兜底：Playwright 自带 Chromium
    try:
        browser = pw.chromium.launch(**launch_kwargs)
        _push_log("已使用 Playwright 自带 Chromium")
        return browser
    except Exception as e:
        raise RuntimeError(
            "启动浏览器失败：系统未安装 Edge/Chrome，且未安装 Playwright 自带 Chromium。"
            "请安装 Chrome/Edge，或执行 `playwright install chromium`。"
            f"（自带 Chromium 错误: {e}；系统渠道错误: {last_err}）"
        )


# ============ QR Code Helpers ============

def _scan_frames_for_qrcode(frames):
    for frame in frames:
        try:
            el = frame.query_selector('img.wwLogin_qrcode_img')
            if el:
                src = el.get_attribute('src') or ''
                if src:
                    return src
            html = frame.content()
            m = QR_URL_PATTERN.search(html)
            if m:
                return m.group(1)
        except Exception:
            continue
    return None


# ============ Business Logic ============

def saveFile(cookies_list):
    _push_log("正在保存cookie到本地...")
    obj = {
        'markHashId_L': '83437b2d-6266-4068-956f-9bbebeed19bf',
        '_clck': 'uvr0fj|1|fzn|0',
        'optimal_cdn_domain': 'res.wx.qq.com',
    }
    arr = ['low_login_enable','TOK','traceid','hashkey','tdoc_uid','wedoc_openid','wedoc_sid','wedoc_sids','wedoc_skey','wedoc_ticket']
    name2value = {c['name']: c['value'] for c in cookies_list}
    result = {k: name2value.get(k) for k in arr}
    obj.update(result)
    with open(COOKIES_FILE, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=4)
    _push_log("cookie已保存，正在调用企微接口...")
    getReportInfo(obj)


def is_date_in_range(check_date, start_date_str, end_date_str, date_format="%Y-%m-%d"):
    if isinstance(check_date, int):
        check_dt = datetime.fromtimestamp(check_date)
    elif isinstance(check_date, str):
        check_dt = datetime.strptime(check_date, date_format)
    elif isinstance(check_date, datetime):
        check_dt = check_date
    else:
        raise ValueError("check_date 仅支持 datetime/int(时间戳)/str(日期字符串)")
    start_dt = datetime.strptime(start_date_str, date_format)
    end_dt = datetime.strptime(end_date_str, date_format)
    return start_dt <= check_dt <= end_dt


def storeConformList(list):
    global strTime, endTime, conformList
    for item in list:
        if is_date_in_range(item['createtime'], strTime, endTime):
            conformList.append(item)


def deduplicate_and_sort_by_field(arr, field="A", keep_last=True, reverse=False):
    unique_dict = {}
    for item in arr:
        if field not in item:
            raise ValueError(f"数组项缺少字段：{field}")
        key = item[field]
        if keep_last or key not in unique_dict:
            unique_dict[key] = item
    sorted_list = sorted(
        unique_dict.values(),
        key=lambda x: x[field],
        reverse=reverse
    )
    return sorted_list


def format_data_and_copy(data, remove_duplicate=True):
    global format_type, format_indent

    def remove_original_number(text):
        if '、' in text:
            parts = text.split('、', 1)
            if parts[0].strip().isdigit():
                return parts[1].strip()
        return text.strip()

    type = format_type
    if type not in [1, 2]:
        type = 1

    indent = format_indent

    formatted_text = ""
    for item in data:
        title = item.get('title', '')
        if not title:
            continue
        formatted_text += f"{title}\n"

        list_items = item.get('list', [])
        if not list_items:
            continue

        if remove_duplicate:
            seen = set()
            unique_list = []
            for li in list_items:
                pure_text = remove_original_number(li)
                if pure_text not in seen:
                    seen.add(pure_text)
                    unique_list.append(pure_text)
            list_items = unique_list
        else:
            list_items = [remove_original_number(li) for li in list_items]

        indent_str = "    " if indent else ""
        if type == 1:
            for idx, pure_text in enumerate(list_items, 1):
                formatted_text += f"{indent_str}{idx}、{pure_text}\n"
        elif type == 2:
            for pure_text in list_items:
                formatted_text += f"{indent_str}{pure_text}\n"

        formatted_text += "\n"

    formatted_text = formatted_text.strip()
    _push_log(f"数据格式化完成，共 {len(formatted_text)} 字符")
    return formatted_text


def mergeData(data):
    global _business_result
    _push_log("正在合并整理数据...")
    info = []
    nameList = []
    for item in data:
        obj = item.get('showinfo', {}).get('wordings')
        arr = obj[0].split('：')[1].split('  ')
        for item in arr:
            aaa = item.split(' ')
            if len(aaa) <= 0:
                continue
            name = ''
            for index, item2 in enumerate(aaa):
                if item2 == '':
                    continue
                if index == 0:
                    name = item2
                    if item2 not in nameList:
                        nameList.append(item2)
                        info.append({'title': item2, 'list': []})
                else:
                    for item4 in info:
                        if item4['title'] == name:
                            item4['list'].append(item2)

    _business_result = format_data_and_copy(info)


def requestNextList():
    global index, cookies, key, template_id
    if index < 6:
        try:
            _check_cancelled()
            _push_log(f"正在获取第 {index + 1} 页数据...")
            url = 'https://doc.weixin.qq.com/wework/journal'
            obj = {"lastjournal_id": key, "direction": 1, "limit": 20, "isconditionquery": True,
                   "querydetail": {"submission_type": 1, "template_id": template_id, "partyids": [], "vids": []}}
            response = requests.post(url + "/get_journal_list?sid=" + cookies['wedoc_sid'] + "&wedoc_xsrf=1", json=obj,
                                     headers={"Content-Type": "application/json"}, cookies=cookies).json()
            if response['errcode'] == 0:
                index = index + 1
                key = response['entrys'][5]['journalid']
                storeConformList(response['entrys'])
                _push_log(f"第 {index} 页获取成功，已收集 {len(conformList)} 条记录")
                time.sleep(2)
                requestNextList()
            else:
                _push_log(f"第 {index + 1} 页请求失败: {response}")
        except requests.exceptions.RequestException as e:
            _push_log(f"第 {index + 1} 页接口请求异常: {str(e)}")
            raise
    else:
        _push_log(f"数据采集完成，共 {len(conformList)} 条记录，正在处理...")
        result1 = deduplicate_and_sort_by_field(conformList, field="createtime")
        mergeData(result1)
        return


def getReportInfo(result):
    global id, key, cookies, template_id
    _push_log("正在请求日报模板信息...")
    obj={"form_id":id,"fetch_journal_list":True,"is_pre_create":False,"is_answer_from_share":False,"is_answer_from_workplace":False,"fetch_submission_type":1,"is_only_view":True}
    cookies=result
    url='https://doc.weixin.qq.com/journal/'
    response = requests.post(url+"get_template_combine_info?_prefetch=1", json=obj, headers={"Content-Type": "application/json"},cookies=result).json()
    if response["head"]['ret'] == 0:
        _push_log("日报模板信息获取成功，开始采集数据...")
        storeConformList(response["body"]['entrys'])
        key = response["body"]['entrys'][5]['journalid']
        template_id = response["body"]['template_id']
        requestNextList()
    else:
        _push_log("企微接口返回错误，cookie可能已失效")
        logger.warning('企微接口调用失败: %s', response)
        with open(COOKIES_FILE, 'w', encoding='utf-8') as f:
            pass


# ============ Cookie Management ============

def _read_cookies():
    if not os.path.exists(COOKIES_FILE):
        return None
    if os.path.getsize(COOKIES_FILE) == 0:
        return None
    try:
        with open(COOKIES_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if data.get('wedoc_sid'):
                return data
            return None
    except Exception:
        return None


# ============ Session Worker ============

def _cleanup_old_sessions():
    with _sessions_lock:
        expired = [sid for sid, s in _sessions.items()
                   if time.time() - s.get('created_at', 0) > 600]
        for sid in expired:
            _sessions.pop(sid, None)


def _session_worker(session_id):
    session = _sessions[session_id]
    tid = threading.current_thread().ident
    _thread_sessions[tid] = session

    _push_log("任务开始执行")

    # Phase 1: Try existing cookies
    _push_log("正在检查本地cookie...")
    _check_cancelled()
    saved_cookies = _read_cookies()

    if saved_cookies:
        _push_log("发现已保存的cookie，正在验证有效性...")
        _reset_business_state(session['params'])
        try:
            _check_cancelled()
            getReportInfo(saved_cookies)
            if _business_result:
                session['status'] = 'success'
                session['result'] = _business_result
                _push_log("全部完成!")
                _thread_sessions.pop(tid, None)
                return
            else:
                _push_log("cookie已失效，需要重新扫码登录")
        except _Cancelled:
            raise
        except Exception as e:
            _push_log(f"cookie验证异常: {str(e)}")
    else:
        _push_log("未找到有效的本地cookie")

    _check_cancelled()

    # Phase 2: QR code login
    pw = None
    browser = None
    try:
        _push_log("正在启动浏览器...")
        pw = sync_playwright().start()
        browser = _launch_chromium(pw)
        context = browser.new_context()
        page = context.new_page()

        _push_log("正在加载登录页面...")
        page.goto(QR_CODE_URL, wait_until='domcontentloaded', timeout=30000)

        _check_cancelled()
        _push_log("正在提取二维码...")
        qr_deadline = time.time() + 20
        image_url = None
        while time.time() < qr_deadline:
            _check_cancelled()
            image_url = _scan_frames_for_qrcode(page.frames)
            if image_url:
                break
            page.wait_for_timeout(500)

        if not image_url:
            session['status'] = 'error'
            _push_log("获取二维码失败")
            return

        if image_url.startswith('//'):
            image_url = 'https:' + image_url

        session['imageUrl'] = image_url
        session['status'] = 'need_login'
        _push_log("二维码已获取，请使用企业微信扫码登录")

        # Wait for login
        login_deadline = time.time() + LOGIN_TIMEOUT_S
        logged_in = False
        while time.time() < login_deadline:
            _check_cancelled()
            try:
                ctx_cookies = context.cookies()
                has_sid = any(c['name'] == 'wedoc_sid' and c['value'] for c in ctx_cookies)
                if has_sid:
                    logged_in = True
                    break
            except _Cancelled:
                raise
            except Exception:
                pass
            page.wait_for_timeout(2000)

        if not logged_in:
            session['status'] = 'expired'
            _push_log("二维码已过期，请重新获取")
            return

        _check_cancelled()
        _push_log("扫码成功! 正在提取登录凭证...")
        session['status'] = 'processing'
        raw_cookies = context.cookies()

        _reset_business_state(session['params'])
        try:
            saveFile(raw_cookies)
        except _Cancelled:
            raise
        except Exception as e:
            session['status'] = 'error'
            _push_log(f"数据获取异常: {str(e)}")
            return

        if _business_result:
            session['status'] = 'success'
            session['result'] = _business_result
            _push_log("全部完成!")
        else:
            session['status'] = 'error'
            _push_log("数据获取失败")

    except _Cancelled:
        session['status'] = 'cancelled'
        _push_log("任务已取消")
    except PlaywrightTimeoutError:
        session['status'] = 'error'
        _push_log("页面加载超时")
    except Exception as e:
        logger.error("[session %s] 异常: %s", session_id, traceback.format_exc())
        session['status'] = 'error'
        _push_log(f"执行异常: {str(e)}")
    finally:
        _thread_sessions.pop(tid, None)
        try:
            if browser:
                browser.close()
        except Exception:
            pass
        try:
            if pw:
                pw.stop()
        except Exception:
            pass


# ============ Handlers ============

def wx_ribao_handler(params=None):
    """
    主处理器 - 立即返回 sessionId，后台异步执行

    Returns:
      { sessionId: "xxx" }
    """
    _cleanup_old_sessions()

    params = params or {}
    session_id = str(uuid.uuid4())[:8]

    session = {
        'status': 'running',
        'created_at': time.time(),
        'cancelled': False,
        'params': params,
        'logs': [],
        'imageUrl': None,
        'result': None,
    }

    with _sessions_lock:
        _sessions[session_id] = session

    thread = threading.Thread(target=_session_worker, args=(session_id,), daemon=True)
    session['thread'] = thread
    thread.start()

    return {"sessionId": session_id}


def cancel_handler(session_id):
    """取消正在执行的任务"""
    with _sessions_lock:
        session = _sessions.get(session_id)

    if not session:
        return {"status": "error", "message": "会话不存在"}

    if session['status'] in ('success', 'cancelled', 'expired', 'error'):
        return {"status": session['status'], "message": "任务已结束，无需取消"}

    session['cancelled'] = True
    logger.info("[session %s] 收到取消请求", session_id)
    return {"status": "ok", "message": "取消请求已发送"}


def status_handler(session_id):
    """
    轮询处理器 - 返回状态 + 实时日志

    Returns:
      {
        status: "running"|"need_login"|"processing"|"success"|"expired"|"error",
        logs: [{time, msg}, ...],
        imageUrl: "..." | null,
        data: "..." | null
      }
    """
    with _sessions_lock:
        session = _sessions.get(session_id)

    if not session:
        return {"status": "error", "logs": [], "imageUrl": None, "data": None}

    status = session['status']
    resp = {
        "status": status,
        "logs": list(session['logs']),
        "imageUrl": session.get('imageUrl'),
        "data": None,
    }

    if status == 'success':
        resp['data'] = session.get('result')
        with _sessions_lock:
            _sessions.pop(session_id, None)
    elif status in ('expired', 'error', 'cancelled'):
        with _sessions_lock:
            _sessions.pop(session_id, None)

    return resp


def _run_cli(params):
    """本地脚本流式模式（供桌面端 Tauri 调用）。

    启动任务后轮询内部状态，并把「日志 / 二维码 / 最终结果」以带前缀的
    结构化 JSON 单行输出到 stdout，由 Rust 逐行转发给前端解析：
      WXRIBAO_LOG:{"time": "...", "msg": "..."}
      WXRIBAO_QR:{"imageUrl": "..."}
      WXRIBAO_RESULT:{"status": "...", "data": ..., "message": "..."}
    """
    # 关闭 logging，避免默认 stderr 输出与结构化 stdout 重复
    logging.disable(logging.CRITICAL)

    def emit(tag, payload):
        sys.stdout.write(tag + json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    start = wx_ribao_handler(params)
    sid = start.get('sessionId')
    if not sid:
        emit("WXRIBAO_RESULT:", {"status": "error", "data": None, "message": "启动任务失败"})
        return 1

    # 捕获 worker 线程句柄，便于退出前等待其完成 Playwright 清理
    with _sessions_lock:
        s0 = _sessions.get(sid)
        worker_thread = s0.get('thread') if s0 else None

    # 后台监听 stdin：桌面端写入 "CANCEL" 时优雅取消（worker 会关闭浏览器后退出，
    # 避免强杀导致 Playwright 驱动报 EPIPE）。
    def _stdin_watcher():
        try:
            while True:
                line = sys.stdin.readline()
                if not line:  # EOF：父进程关闭了 stdin
                    break
                if line.strip().upper() == 'CANCEL':
                    cancel_handler(sid)
                    break
        except Exception:
            pass

    threading.Thread(target=_stdin_watcher, daemon=True).start()

    pushed = 0
    qr_sent = False
    while True:
        time.sleep(1)
        s = status_handler(sid)

        logs = s.get('logs') or []
        if len(logs) > pushed:
            for entry in logs[pushed:]:
                emit("WXRIBAO_LOG:", entry)
            pushed = len(logs)

        if s.get('status') == 'need_login' and s.get('imageUrl') and not qr_sent:
            qr_sent = True
            emit("WXRIBAO_QR:", {"imageUrl": s['imageUrl']})

        status = s.get('status')
        if status in ('success', 'expired', 'error', 'cancelled'):
            # 等待 worker 线程结束，确保浏览器/Playwright 已优雅关闭再退出进程
            if worker_thread and worker_thread.is_alive():
                worker_thread.join(timeout=15)
            emit("WXRIBAO_RESULT:", {
                "status": status,
                "data": s.get('data'),
                "message": s.get('message', ''),
            })
            return 0 if status == 'success' else 1


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description="微信日报")
    parser.add_argument("--cli", action="store_true", help="本地脚本流式模式（供桌面端调用）")
    parser.add_argument("--startDate", default="")
    parser.add_argument("--endDate", default="")
    parser.add_argument("--outputFormat", default="1")
    parser.add_argument("--indentInTheLine", default="false")
    args, _unknown = parser.parse_known_args()

    if args.cli:
        sys.exit(_run_cli({
            'startDate': args.startDate,
            'endDate': args.endDate,
            'outputFormat': args.outputFormat,
            'indentInTheLine': args.indentInTheLine,
        }))

    # 无 --cli：本地调试用的轮询演示
    result = wx_ribao_handler({
        'startDate': '2026-03-01',
        'endDate': '2026-03-24',
        'outputFormat': '1',
        'indentInTheLine': 'false',
    })
    print(result)
    sid = result['sessionId']
    while True:
        time.sleep(2)
        s = status_handler(sid)
        print(f"[{s['status']}] logs={len(s['logs'])}")
        for log in s['logs']:
            print(f"  {log['time']} - {log['msg']}")
        if s['status'] in ('success', 'error', 'expired'):
            if s['data']:
                print(s['data'])
            break
