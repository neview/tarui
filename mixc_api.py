#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
华润万象城 App —— 登录 + 积分签到 + 查询剩余积分 一键脚本（交互式）
=========================================================
依赖安装：
    pip install requests pycryptodome

运行：
    python mixc_api.py

【用法】运行后终端会交互提示：
  1. 若存在有效缓存 token → 自动复用，直接签到+查询（跳过登录）
  2. 否则提示选择登录方式：
     [1] 账号密码登录
     [2] 短信验证码登录（自动发验证码 → 等你输入 → 继续）
  3. 登录成功后每个账号单独保存 token（tokens/手机号.json），下次直接复用

【重要】本脚本内已不含任何密钥 / 账号 / 设备指纹。
        所有敏感值统一放在同目录的  mixc_config.txt  里，启动时自动读取：
            账号 ACCOUNT / 密码 PASSWORD / token
            imei / 设备指纹 DEVICE_ID
            AES_KEY / AES_IV
            APP_APPID / APP_SIGN_KEY / APP_SIGN_SALT
            H5_APPID  / H5_SIGN_KEY
        也可用环境变量指定配置位置：MIXC_CONFIG=D:/keys/mixc_config.txt

=========================================================
本 App 有「两套」签名体系，脚本已分别处理：
  1) APP 原生（登录 v3/login / 验证码 v1/loginByCheckCode）
       appId / 签名密钥 / 签名盐   ← 从配置读取
       platform = android
  2) H5（签到 gateway）
       mixc.app.memberSign.sign       ← 真正执行签到
       mixc.app.memberSign.signDate   ← 仅查询签到日历/状态（不签到！）
       mixc.app.memberSign.latticeList← 查询剩余积分/签到步数
       appId / 签名密钥              ← 从配置读取
       platform = h5

密码加密：AES-128-CBC / PKCS5Padding + Base64
          密钥 / IV ← 从配置读取
=========================================================
"""
import base64
import datetime
import hashlib
import json
import os
import re
import sys
import time

import requests
from Crypto.Cipher import AES


# ============================================================
# 零、私密配置加载（账号 / 密钥全部在外部 mixc_config.txt）
# ============================================================

def _load_config() -> dict:
    """按顺序查找并解析配置文件：每行 KEY=VALUE，# 开头为注释"""
    names = ["mixc_config.txt", "mixc_私密配置备份.txt", "config.txt"]
    candidates = []

    env_path = os.environ.get("MIXC_CONFIG", "").strip()
    if env_path:
        candidates.append(env_path)

    base = os.path.dirname(os.path.abspath(__file__))
    candidates += [os.path.join(base, n) for n in names]
    candidates.append(os.path.join(os.getcwd(), names[0]))

    for p in candidates:
        if p and os.path.isfile(p):
            conf = {}
            try:
                with open(p, encoding="utf-8-sig") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#") or "=" not in line:
                            continue
                        k, v = line.split("=", 1)
                        conf[k.strip().upper()] = v.strip()
            except Exception as e:
                print("⚠️ 配置文件解析失败:", p, e)
                continue
            conf["_path"] = p
            return conf
    return {}


CFG = _load_config()


def cfg(key: str, default: str = "") -> str:
    """读取配置项：优先配置文件，其次环境变量 MIXC_<KEY>"""
    return (CFG.get(key.upper())
            or os.environ.get("MIXC_" + key.upper(), "").strip()
            or default)


# 缺失即无法运行的必备字段
REQUIRED_KEYS = [
    ("AES_KEY",      "密码加密 AES 密钥"),
    ("AES_IV",       "AES 初始向量 IV"),
    ("APP_APPID",    "APP 端 appId"),
    ("APP_SIGN_KEY", "APP 端签名密钥"),
    ("APP_SIGN_SALT", "APP 端签名盐"),
    ("H5_APPID",     "H5 端 appId"),
    ("H5_SIGN_KEY",  "H5 端签名密钥"),
    ("DEVICE_ID",    "设备指纹 deviceId"),
]


def check_config() -> bool:
    """启动自检：配置文件是否存在、必备字段是否齐全"""
    if not CFG:
        print("\n⚠️ 未找到配置文件  mixc_config.txt")
        print("   请把 mixc_config.txt 放到脚本同一目录，")
        print("   或设置环境变量 MIXC_CONFIG 指向它的完整路径后重试。")
        return False
    missing = [f"    {k:<14}—— {desc}" for k, desc in REQUIRED_KEYS if not cfg(k)]
    if missing:
        print(f"\n⚠️ 配置文件缺少以下字段（{CFG.get('_path')}）：")
        print("\n".join(missing))
        return False
    return True


# ============================================================
# 一、账号（★★★ 在 mixc_config.txt 里改，这里不再硬编码 ★★★）
# ============================================================
ACCOUNT = cfg("ACCOUNT")      # 手机号
PASSWORD = cfg("PASSWORD")    # 登录密码（可选，密码登录时的默认值；直接回车即用此密码）

# ============================================================
# 二、运行开关
# ============================================================
# DRY_RUN = True  ：离线自检，只打印加密/签名结果、不发真实请求
# DRY_RUN = False ：真实交互运行
DRY_RUN = False

# ============================================================
# 三、设备指纹（已从 2026-10-15 Android 抓包回填，一般不用改）
# ============================================================
DEVICE = {
    "device": "HONOR HLK-AL00",          # 机型（通用值，非敏感）
    "deviceId": cfg("DEVICE_ID"),        # ★ 数美风控设备指纹，从配置读取
    "channel": "C001",                    # 渠道号
    "mallNo": "20129",                    # 商场号
    "osVersion": "10",                    # Android 系统版本
    "gpsLatitude": "0.0",
    "gpsLongitude": "0.0",
    # ★ 登录接口需要「APP 原生 imei」，是真机随机生成的 15 位数字（1-9）。
    #   从配置读取；留空则脚本自动随机生成并本地缓存（模拟 App 行为）。
    #   H5 签到的 imei 固定 "2333"，已内置。
    "imei": cfg("IMEI"),
}

# ============================================================
# 四、两套签名配置（无需改动）
# ============================================================
APP = {
    "api_base": "https://app.mixcapp.com/mixc/api/",
    "appId": cfg("APP_APPID"),           # ← 从配置读取
    "sign_key": cfg("APP_SIGN_KEY"),     # ← 从配置读取
    "sign_salt": cfg("APP_SIGN_SALT"),   # ← 从配置读取
    "platform": "android",
    "appVersion": "4.1.9",
}

H5 = {
    "gateway": "https://app.mixcapp.com/mixc/gateway",
    "appId": cfg("H5_APPID"),            # ← 从配置读取
    "sign_key": cfg("H5_SIGN_KEY"),      # ← 从配置读取
    "platform": "h5",
    "appVersion": "4.1.9",
    "imei": "2333",            # H5 固定占位 imei（已用抓包验证）
}

AES_KEY = cfg("AES_KEY")       # ← 从配置读取
AES_IV = cfg("AES_IV")         # ← 从配置读取

def data_dir() -> str:
    """登录态、imei 缓存目录。桌面端通过 MIXC_DATA_DIR 指定可写目录。"""
    d = os.environ.get("MIXC_DATA_DIR", "").strip()
    if d:
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            pass
        return d
    return os.path.dirname(os.path.abspath(__file__))


def _legacy_token_file() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "token_cache.txt")


# ============================================================
# 五、核心算法
# ============================================================

def md5(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def encrypt_password(pwd: str) -> str:
    """复现 com.crland.mixc.l.a()：AES-128-CBC/PKCS5Padding + Base64"""
    cipher = AES.new(AES_KEY.encode(), AES.MODE_CBC, AES_IV.encode()[:16])
    pad = 16 - (len(pwd.encode()) % 16)
    return base64.b64encode(cipher.encrypt(pwd.encode() + bytes([pad] * pad))).decode()


def sign_of(params: dict, key: str, salt: str = "") -> str:
    """通用签名：MD5( 按 key 升序 "k=v&" 拼接 + key + salt )"""
    concat = "".join(f"{k}={v}&" for k, v in sorted(params.items()))
    return md5(concat + key + salt)


def gson_str_escape(s: str) -> str:
    """模拟 Gson 的 HTML 转义（= < > & ' → \\uXXXX）"""
    return (s.replace('&', '\\u0026').replace('=', '\\u003d')
             .replace('<', '\\u003c').replace('>', '\\u003e').replace("'", '\\u0027'))


def build_device_params(phone: str) -> str:
    """deviceParams = URL_SAFE_Base64( Gson紧凑JSON{device,deviceId,location,phone} )
    关键：键顺序、紧凑无空格、Gson转义、URL-Safe Base64 必须与 App 完全一致"""
    e = gson_str_escape
    json_str = ('{"device":"%s","deviceId":"%s","location":{"gpsLatitude":"%s","gpsLongitude":"%s"},"phone":"%s"}'
                % (e(DEVICE["device"]), e(DEVICE["deviceId"]),
                   e(DEVICE["gpsLatitude"]), e(DEVICE["gpsLongitude"]), e(phone)))
    return base64.urlsafe_b64encode(json_str.encode()).decode()


def build_biz_params(biz: dict) -> str:
    """业务参数 params = URL_SAFE_Base64( Gson紧凑JSON )"""
    e = gson_str_escape
    json_str = '{' + ','.join('"%s":"%s"' % (k, e(str(v))) for k, v in biz.items()) + '}'
    return base64.urlsafe_b64encode(json_str.encode()).decode()


def utc_date_str() -> str:
    """date 参数：格式 YYYY-MM-DD hh:mm:ss（抓包为 UTC 时间）"""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def now_ms() -> str:
    return str(int(time.time() * 1000))


def _to_int(v):
    """安全转 int，失败返回 None"""
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# ============================================================
# 六、登录
# ============================================================

def gen_imei() -> str:
    """模拟 App getImie()：拿不到真实 IMEI 时随机生成 15 位数字（字符集 1-9，与 App 一致）"""
    import random
    return "".join(random.choice("123456789") for _ in range(15))


def get_imei() -> str:
    """获取登录 imei：优先 DEVICE 配置 → 本地缓存 → 随机生成并缓存（模拟 App 的 SP 持久化）"""
    if DEVICE.get("imei"):
        return DEVICE["imei"]
    cache = os.path.join(data_dir(), ".imei_cache")
    try:
        if os.path.exists(cache):
            with open(cache) as f:
                v = f.read().strip()
                if v:
                    return v
    except Exception:
        pass
    v = gen_imei()
    try:
        with open(cache, "w") as f:
            f.write(v)
    except Exception:
        pass
    return v


def _common_params(account: str) -> dict:
    """公共参数（channel/imei/mallNo/platform/appVersion/osVersion/timestamp/deviceParams）"""
    return {
        "channel": DEVICE["channel"],
        "imei": get_imei(),
        "mallNo": DEVICE["mallNo"],
        "platform": APP["platform"],
        "appVersion": APP["appVersion"],
        "osVersion": DEVICE["osVersion"],
        "timestamp": now_ms(),
        "deviceParams": build_device_params(account),
    }


def build_login_params(account: str, password: str) -> dict:
    """构造密码登录 POST /v3/login 的完整参数（APP 原生，加盐签名）"""
    params = _common_params(account)
    params.update({
        "userName": account,
        "password": encrypt_password(password),
        "nationalCode": "86",
    })
    params["sign"] = sign_of(params, APP["sign_key"], APP["sign_salt"])
    return params


def app_login_detail(account: str, password: str) -> dict:
    """密码登录。返回 {token, device_limited, message}。"""
    params = build_login_params(account, password)
    url = APP["api_base"] + "v3/login"

    print("\n" + "=" * 60)
    print("密码登录  POST /v3/login")
    print("=" * 60)

    if DRY_RUN:
        print("[DRY-RUN] 未实际发送。加密密码 =", encrypt_password(password))
        print("  sign =", params["sign"])
        return {"token": "", "device_limited": False, "message": "DRY-RUN"}

    try:
        r = requests.post(url, data=params, headers={
            "User-Agent": f"mixc/{APP['appVersion']} (Android)",
            "Content-Type": "application/x-www-form-urlencoded",
        }, timeout=20)
    except Exception as e:
        print("  请求异常:", e)
        return {"token": "", "device_limited": False, "message": f"请求异常: {e}"}

    print("  状态码:", r.status_code)
    try:
        j = r.json()
    except Exception:
        print("  响应原文:", r.text[:400])
        return {"token": "", "device_limited": False, "message": "登录响应无法解析"}
    code = j.get("code")
    if code not in (0, "0", None):
        print("  登录失败:", json.dumps(j, ensure_ascii=False)[:400])
        message = j.get("message") or j.get("msg") or "登录失败"
        if str(code) == "30113":
            print("  ⚠️ 触发新设备风控，请改用「短信验证码登录」。")
            return {"token": "", "device_limited": True, "message": str(message)}
        return {"token": "", "device_limited": False, "message": str(message)}
    data = j.get("data") or {}
    token = data.get("token") or j.get("token") or ""
    print("  ✅ 登录成功，token =", (token[:20] + "...") if token else "(空)")
    return {"token": token, "device_limited": False, "message": "登录成功"}


def app_login(account: str, password: str) -> str:
    """密码登录，返回 token（失败返回空串）"""
    return app_login_detail(account, password).get("token") or ""


def build_send_code_params(account: str) -> dict:
    """构造发验证码 GET /v2/sendCheckCode 参数（APP 原生，加盐签名）"""
    params = _common_params(account)
    params.update({
        "mob": account,
        "type": "31",          # CODE_TYPE_LOGIN（登录验证码）
        "nationalCode": "86",
    })
    params["sign"] = sign_of(params, APP["sign_key"], APP["sign_salt"])
    return params


def send_check_code(account: str) -> bool:
    """发短信验证码（GET /v2/sendCheckCode）。成功返回 True"""
    url = APP["api_base"] + "v2/sendCheckCode"
    params = build_send_code_params(account)

    print("\n" + "=" * 60)
    print("发送短信验证码  GET /v2/sendCheckCode")
    print("=" * 60)

    if DRY_RUN:
        print("[DRY-RUN] 未实际发送。sign =", params["sign"])
        return True

    try:
        r = requests.get(url, params=params, headers={
            "User-Agent": f"mixc/{APP['appVersion']} (Android)",
        }, timeout=20)
    except Exception as e:
        print("  请求异常:", e)
        return False

    print("  状态码:", r.status_code)
    try:
        j = r.json()
    except Exception:
        print("  响应原文:", r.text[:400])
        return False
    if j.get("code") not in (0, "0", None):
        print("  发送失败:", json.dumps(j, ensure_ascii=False)[:400])
        return False
    print("  ✅ 验证码已发送，请查收短信。")
    return True


def build_sms_login_params(account: str, code: str) -> dict:
    """构造验证码登录 POST /v1/loginByCheckCode 参数（APP 原生，加盐签名）"""
    params = _common_params(account)
    params.update({
        "userName": account,
        "code": code,
        "acceptAgreement": "1",
        "nationalCode": "86",
    })
    params["sign"] = sign_of(params, APP["sign_key"], APP["sign_salt"])
    return params


def app_sms_login(account: str, code: str) -> str:
    """短信验证码登录（POST /v1/loginByCheckCode）。返回 token，失败返回空串"""
    url = APP["api_base"] + "v1/loginByCheckCode"
    params = build_sms_login_params(account, code)

    print("\n" + "=" * 60)
    print("短信验证码登录  POST /v1/loginByCheckCode")
    print("=" * 60)

    if DRY_RUN:
        print("[DRY-RUN] 未实际发送。code =", code)
        print("  sign =", params["sign"])
        return ""

    try:
        r = requests.post(url, data=params, headers={
            "User-Agent": f"mixc/{APP['appVersion']} (Android)",
            "Content-Type": "application/x-www-form-urlencoded",
        }, timeout=20)
    except Exception as e:
        print("  请求异常:", e)
        return ""

    print("  状态码:", r.status_code)
    try:
        j = r.json()
    except Exception:
        print("  响应原文:", r.text[:400])
        return ""
    if j.get("code") not in (0, "0", None):
        print("  登录失败:", json.dumps(j, ensure_ascii=False)[:400])
        return ""
    data = j.get("data") or {}
    token = data.get("token") or j.get("token") or ""
    print("  ✅ 验证码登录成功，token =", (token[:20] + "...") if token else "(空)")
    return token


# ============================================================
# 七、token 缓存（复用登录态，下次免登录）
# ============================================================

def account_key(account: str) -> str:
    """同一手机号只用一个键，避免空格或 +86 造成存、取不是同一个账号。"""
    text = "".join(str(account or "").split())
    digits = "".join(ch for ch in text if ch.isdigit())
    if digits.startswith("86") and len(digits) > 11:
        digits = digits[2:]
    if len(digits) >= 11:
        return digits[-11:]
    return "".join(ch if ch.isalnum() else "_" for ch in text)[:64]


def _token_dir() -> str:
    folder = os.path.join(data_dir(), "tokens")
    os.makedirs(folder, exist_ok=True)
    return folder


def _account_token_path(account: str) -> str:
    return os.path.join(_token_dir(), account_key(account) + ".json")


def _remember_account_token(account: str, token: str, saved_at: str = "") -> None:
    """把旧的单文件缓存拆进该账号自己的文件，不覆盖已有记录。"""
    key = account_key(account)
    if not key or not token:
        return
    path = os.path.join(data_dir(), "tokens", key + ".json")
    if os.path.exists(path):
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({
                "account": key,
                "token": token,
                "saved_at": saved_at or "",
            }, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _import_token_blob(data) -> None:
    if not isinstance(data, dict):
        return
    accounts = data.get("accounts")
    if isinstance(accounts, dict):
        for account, item in accounts.items():
            if isinstance(item, dict) and item.get("token"):
                _remember_account_token(account, item["token"], item.get("saved_at") or "")
        return
    if data.get("account") and data.get("token"):
        _remember_account_token(data["account"], data["token"], data.get("saved_at") or "")


def _migrate_old_token_files() -> None:
    """旧版单个 token_cache 文件只会留下最后一次登录，拆进每个账号自己的文件。"""
    paths = [
        os.path.join(data_dir(), "token_cache.json"),
        os.path.join(data_dir(), "token_cache.txt"),
        _legacy_token_file(),
    ]
    seen = set()
    for path in paths:
        if path in seen or not os.path.exists(path):
            continue
        seen.add(path)
        try:
            with open(path, encoding="utf-8") as f:
                _import_token_blob(json.load(f))
        except Exception:
            pass
    _write_token_index()


def _write_token_index(allow_empty: bool = False) -> None:
    """汇总每个账号的登录文件，方便查看时一次看到全部账号。"""
    folder = os.path.join(data_dir(), "tokens")
    accounts = {}
    if os.path.isdir(folder):
        for name in os.listdir(folder):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(folder, name), encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:
                continue
            if isinstance(data, dict) and data.get("token"):
                accounts[name[:-5]] = {
                    "token": data["token"],
                    "saved_at": data.get("saved_at") or "",
                }
    if not accounts and not allow_empty:
        return
    payload = json.dumps({"accounts": accounts}, ensure_ascii=False, indent=2)
    targets = [os.path.join(data_dir(), "token_cache.json")]
    for extra in (os.path.join(data_dir(), "token_cache.txt"), _legacy_token_file()):
        if os.path.exists(extra) and extra not in targets:
            targets.append(extra)
    for path in targets:
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(payload)
        except Exception:
            pass


def save_token(account: str, token: str) -> bool:
    """每个账号单独一个文件，后登录的账号不会盖掉其他账号。"""
    key = account_key(account)
    if not key or not token:
        return False
    path = _account_token_path(key)
    try:
        previous = {}
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    previous = loaded
            except Exception:
                previous = {}
        previous.update({
            "account": key,
            "token": token,
            "saved_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })
        with open(path, "w", encoding="utf-8") as f:
            json.dump(previous, f, ensure_ascii=False, indent=2)
        _write_token_index()
        return True
    except Exception as e:
        print("  ⚠️ token 保存失败:", e)
        return False


def load_token(account: str):
    """只读取这个账号自己的 token。"""
    _migrate_old_token_files()
    key = account_key(account)
    path = _account_token_path(key) if key else ""
    if path and os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if data.get("token"):
                return {
                    "account": key,
                    "token": data["token"],
                    "saved_at": data.get("saved_at") or "",
                    "points": data.get("points"),
                    "lastSignPoints": data.get("lastSignPoints"),
                    "signedToday": data.get("signedToday"),
                    "signedDate": data.get("signedDate") or "",
                }
        except Exception:
            pass
    t = cfg("TOKEN")
    if t and key and key == account_key(cfg("ACCOUNT")):
        return {
            "account": key,
            "token": t,
            "saved_at": cfg("TOKEN_SAVED_AT") or "配置备份",
        }
    return None


def clear_token(account: str = ""):
    """只删除指定账号的登录文件。不传账号时清掉全部账号。"""
    folder = os.path.join(data_dir(), "tokens")
    try:
        if not account:
            if os.path.isdir(folder):
                for name in os.listdir(folder):
                    if name.endswith(".json"):
                        os.remove(os.path.join(folder, name))
            for path in (
                os.path.join(data_dir(), "token_cache.json"),
                os.path.join(data_dir(), "token_cache.txt"),
                _legacy_token_file(),
            ):
                if os.path.exists(path):
                    os.remove(path)
            return
        path = _account_token_path(account)
        if os.path.exists(path):
            os.remove(path)
        _write_token_index(allow_empty=True)
    except Exception:
        pass


def token_status(token: str, account: str) -> str:
    """ok：可复用；invalid：服务端拒绝，应删掉；unknown：请求失败，保留本地登录态。"""
    j = h5_gateway_post(token, account, "mixc.app.memberSign.latticeList", {"mallNo": DEVICE["mallNo"]})
    if j is None:
        return "unknown"
    if j.get("code") in (0, "0", None):
        return "ok"
    return "invalid"


def token_is_valid(token: str, account: str) -> bool:
    return token_status(token, account) == "ok"


# ============================================================
# 八、签到 与 查询剩余积分（H5 gateway）
# ============================================================

def h5_gateway_post(token: str, account: str, action: str, biz: dict):
    """H5 gateway 请求（无盐签名，已 7/7 验证）。返回响应 JSON 或 None"""
    params = {
        "mallNo": DEVICE["mallNo"],
        "appId": H5["appId"],
        "platform": H5["platform"],
        "imei": H5["imei"],
        "appVersion": H5["appVersion"],
        "osVersion": DEVICE["osVersion"],
        "channel": DEVICE["channel"],
        "action": action,
        "apiVersion": "1.0",
        "timestamp": now_ms(),
        "t": now_ms(),
        "date": utc_date_str(),
        "token": token,
        "deviceParams": build_device_params(account),
        "params": build_biz_params(biz),
    }
    params["sign"] = sign_of(params, H5["sign_key"])

    if DRY_RUN:
        print("  [DRY-RUN] 未实际发送，sign =", params["sign"])
        return None

    try:
        r = requests.post(H5["gateway"], data=params, headers={
            "User-Agent": f"mixc/{H5['appVersion']} (Android)",
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://app.mixcapp.com",
            "X-Requested-With": "com.crland.mixc",
        }, timeout=20)
    except Exception as e:
        print("  请求异常:", e)
        return None
    try:
        return r.json()
    except Exception:
        print("  响应原文:", r.text[:400])
        return None


def query_lattice(token: str, account: str):
    """查询签到状态/积分 action=mixc.app.memberSign.latticeList，返回 data dict 或 None"""
    j = h5_gateway_post(token, account, "mixc.app.memberSign.latticeList",
                        {"mallNo": DEVICE["mallNo"]})
    if j is None:
        return None
    if j.get("code") not in (0, "0", None):
        print("  查询失败:", json.dumps(j, ensure_ascii=False)[:400])
        return None
    return j.get("data") or {}


def _today() -> str:
    return datetime.date.today().isoformat()


def _as_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("1", "true", "yes", "y", "已签", "已签到"):
            return True
        if text in ("0", "false", "no", "n", "未签", "未签到"):
            return False
    return None


def _already_signed(message: str) -> bool:
    return bool(re.search(r"已签|签过|不可重复", message or ""))


def _gain_from_sign(body) -> object:
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        return None
    sign_map = data.get("signDataMap") if isinstance(data.get("signDataMap"), dict) else {}
    for value in (sign_map.get("todayPoint"), data.get("point")):
        if value not in (None, ""):
            return value
    return None


def parse_sign_calendar(data, today: str = ""):
    """从签到日历里取出「今天是否已签」和最近一次签到积分。"""
    today = today or _today()
    today_compact = today.replace("-", "")
    signed_today = None
    last_point = None
    last_day = ""

    def visit(node):
        nonlocal signed_today, last_point, last_day
        if isinstance(node, list):
            for item in node:
                visit(item)
            return
        if not isinstance(node, dict):
            return
        for key in ("todaySigned", "isTodaySign", "isSignToday", "signedToday"):
            if key in node:
                flag = _as_bool(node.get(key))
                if flag is not None:
                    signed_today = flag
        raw_day = ""
        for key in ("signDate", "date", "day", "signDay"):
            if node.get(key):
                raw_day = str(node.get(key)).replace("/", "-")[:10]
                break
        point = None
        for key in ("point", "points", "signPoint", "signPoints", "rewardPoints"):
            if node.get(key) not in (None, ""):
                point = node.get(key)
                break
        signed = None
        for key in ("sign", "signed", "isSign", "signFlag"):
            if key in node:
                signed = _as_bool(node.get(key))
                if signed is not None:
                    break
        if raw_day:
            if raw_day.replace("-", "")[:8] == today_compact:
                if signed is not None:
                    signed_today = signed
                elif point is not None:
                    signed_today = True
                if point is not None and signed is not False:
                    last_point = point
                    last_day = today
            elif signed and point is not None and raw_day >= last_day:
                last_day = raw_day
                last_point = point
        for value in node.values():
            if isinstance(value, (dict, list)):
                visit(value)

    visit(data)
    return signed_today, last_point


def _stored_sign_state(cache: dict):
    signed = cache.get("signedToday")
    signed_date = str(cache.get("signedDate") or "")
    if signed is True and signed_date != _today():
        signed = False if signed_date else None
    return cache.get("points"), cache.get("lastSignPoints"), signed


def save_account_meta(account: str, **fields) -> None:
    key = account_key(account)
    path = _account_token_path(key) if key else ""
    if not path or not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or not data.get("token"):
            return
        for name, value in fields.items():
            if value is not None:
                data[name] = value
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def account_snapshot(token: str, account: str, lattice=None, sign_body=None, already_signed: bool = False) -> dict:
    """汇总积分余额、上次签到积分、今天是否已签。查不到的字段沿用这个账号自己的记录。"""
    cache = load_token(account) or {}
    stored_points, stored_last, stored_today = _stored_sign_state(cache)
    if not isinstance(lattice, dict):
        lattice = query_lattice(token, account) or {}
    points = lattice.get("remaindPoints")
    signed_today = None
    last_point = None
    calendar = h5_gateway_post(token, account, "mixc.app.memberSign.signDate", {"mallNo": DEVICE["mallNo"]})
    if isinstance(calendar, dict) and calendar.get("code") in (0, "0", None):
        signed_today, last_point = parse_sign_calendar(calendar.get("data"))
    gained = _gain_from_sign(sign_body)
    if already_signed or gained not in (None, ""):
        signed_today = True
    if gained not in (None, ""):
        last_point = gained
    if signed_today is None:
        signed_today = stored_today
    if last_point in (None, ""):
        last_point = stored_last
    if points in (None, ""):
        points = stored_points
    meta = {}
    if points not in (None, ""):
        meta["points"] = points
    if last_point not in (None, ""):
        meta["lastSignPoints"] = last_point
    if signed_today is True:
        meta["signedToday"] = True
        meta["signedDate"] = _today()
    elif signed_today is False:
        meta["signedToday"] = False
        meta["signedDate"] = ""
    if meta:
        save_account_meta(account, **meta)
    return {
        "points": points,
        "lastSignPoints": last_point,
        "signedToday": True if signed_today is True else False if signed_today is False else None,
    }


def op_sign(token: str, account: str):
    """操作二：积分签到 action=mixc.app.memberSign.sign

    重要（来自 H5 JS 逆向确认）：
      * mixc.app.memberSign.signDate —— 只是【查询】签到日历/状态，调用它不会签到；
      * mixc.app.memberSign.sign     —— 才是【真正执行签到】的接口。

    逻辑：登录后【直接调用签到接口】，不做任何本地预判，
          并把接口返回的完整 JSON 原样打印出来；
          签到成功后再查一次积分，展示最新剩余积分。
    """
    print("\n" + "=" * 60)
    print("操作二：积分签到  action=mixc.app.memberSign.sign")
    print("=" * 60)

    # 1) 直接调用真正的签到接口（不预判）
    j = h5_gateway_post(token, account, "mixc.app.memberSign.sign",
                        {"mallNo": DEVICE["mallNo"]})
    if j is None:
        return {"ok": False, "message": "签到请求失败"}

    # 2) 完整打印签到接口的原始返回
    print("\n  【签到接口完整返回】")
    print(json.dumps(j, ensure_ascii=False, indent=2))

    code = j.get("code")
    if code not in (0, "0", None):
        message = j.get("message") or j.get("msg") or "签到失败"
        print("\n  ❌ 签到失败：", message)
        after_data = query_lattice(token, account) or {}
        already = _already_signed(str(message))
        return {
            "ok": False,
            "already_signed": already,
            "message": "今天已经签过到" if already else str(message),
            "points": after_data.get("remaindPoints"),
            "lattice": after_data,
            "sign_body": j,
            "gained": _gain_from_sign(j),
        }
    print("\n  ✅ 签到接口返回 code =", code, " message =", j.get("message"))

    # 3) 签到后查询最新积分（展示用）
    after_data = query_lattice(token, account) or {}
    if after_data:
        print("  ----------------------------------------------")
        print("     签到后剩余积分 remaindPoints =", after_data.get("remaindPoints"))
        print("     当前签到步数 currentStep  =", after_data.get("currentStep"))
        print("     剩余步数     remaindStep  =", after_data.get("remaindStep"))
    return {
        "ok": True,
        "already_signed": False,
        "message": "签到成功",
        "points": after_data.get("remaindPoints"),
        "step": after_data.get("currentStep"),
        "lattice": after_data,
        "sign_body": j,
        "gained": _gain_from_sign(j),
    }


def op_query_points(token: str, account: str):
    """操作三：查询当前剩余积分 action=mixc.app.memberSign.latticeList"""
    print("\n" + "=" * 60)
    print("操作三：查询剩余积分  action=mixc.app.memberSign.latticeList")
    print("=" * 60)
    data = query_lattice(token, account)
    if data is None:
        return
    print("  ★ 当前剩余积分 remaindPoints =", data.get("remaindPoints"))
    print("     当前签到步数 currentStep  =", data.get("currentStep"))
    print("     剩余步数     remaindStep  =", data.get("remaindStep"))


# ============================================================
# 九、交互式登录
# ============================================================

def interactive_login(account: str) -> str:
    """交互式选择登录方式，返回 token（失败/退出返回空串）"""
    print("\n" + "=" * 60)
    print("请选择登录方式：")
    print("  [1] 账号密码登录")
    print("  [2] 短信验证码登录")
    print("  [q] 退出")
    print("=" * 60)

    choice = ""
    while choice not in ("1", "2", "q"):
        choice = input("请输入选项（1 / 2 / q）：").strip().lower()

    if choice == "q":
        print("已退出。")
        return ""

    if choice == "2":
        # 短信验证码登录：自动发验证码 → 等待输入 → 登录
        if not send_check_code(account):
            return ""
        code = input("\n请输入收到的短信验证码：").strip()
        if not code:
            print("⚠️ 未输入验证码，退出。")
            return ""
        return app_sms_login(account, code)

    # 密码登录
    tip = f"（直接回车用默认 {PASSWORD}）" if PASSWORD else ""
    pwd = input(f"\n请输入登录密码{tip}：").strip() or PASSWORD
    if not pwd:
        print("⚠️ 未输入密码，退出。")
        return ""
    return app_login(account, pwd)


# ============================================================
# 十、主流程
# ============================================================

def main():
    print("=" * 60)
    print("华润万象城  登录 / 积分签到 / 查询剩余积分")
    print("=" * 60)

    # 0. 配置自检（账号 / 密钥全部来自外部配置文件）
    if not check_config():
        return
    print(f"配置文件  : {CFG.get('_path')}")

    account = ACCOUNT.strip()
    if not account:
        account = input("\n请输入登录手机号：").strip()
        if not account:
            print("⚠️ 未填写手机号，退出。")
            return

    print(f"账号      : {account}")
    print(f"运行模式  : {'DRY-RUN 离线自检（不发请求）' if DRY_RUN else '真实请求'}")

    # DRY-RUN：离线自检，只预览加密/签名
    if DRY_RUN:
        print("\n密码加密(AES) 示例 =", encrypt_password(PASSWORD or "123456"))
        op_sign("DRY_RUN_PLACEHOLDER_TOKEN", account)
        op_query_points("DRY_RUN_PLACEHOLDER_TOKEN", account)
        print("\n[DRY-RUN] 自检结束。核对无误后，把 DRY_RUN 改为 False 即可真实交互运行。")
        return

    token = ""

    # 1. 尝试复用缓存 token（免登录）
    cache = load_token(account)
    if cache:
        print(f"\nℹ️ 检测到缓存 token（{cache.get('saved_at')}），尝试复用，跳过登录。")
        status = token_status(cache["token"], account)
        if status == "invalid":
            print("⚠️ token 已失效，将重新登录。")
            clear_token(account)
        else:
            token = cache["token"]
            print("✅ token 有效，直接复用。" if status == "ok" else "⚠️ 暂时无法验证 token，仍使用本地登录态。")

    # 2. 无有效 token → 交互式登录
    if not token:
        token = interactive_login(account)
        if not token:
            print("\n⚠️ 未取得 token，本次结束。")
            return
        save_token(account, token)
        print(f"\n✅ 登录成功，token 已按账号保存到 tokens/{account_key(account)}.json，下次运行自动复用。")

    # 3. 积分签到
    op_sign(token, account)

    # 4. 查询剩余积分
    op_query_points(token, account)

    print("\n" + "=" * 60)
    print("执行完毕。")
    print("=" * 60)


def _emit_result(payload: dict):
    print("MIXC_RESULT:" + json.dumps(payload, ensure_ascii=False), flush=True)


def _emit_session(account: str, snap: dict, message: str = ""):
    _emit_result({
        "status": "logged_in",
        "loggedIn": True,
        "account": account,
        "message": message,
        "points": snap.get("points"),
        "lastSignPoints": snap.get("lastSignPoints"),
        "signedToday": snap.get("signedToday"),
    })


def _acquire_token(account: str, password: str, code: str):
    """返回 (token, 提前结束时要发给页面的结果)。"""
    cache = load_token(account)
    token = ""
    if cache:
        print(f"检测到账号 {account} 的缓存 token（{cache.get('saved_at')}），尝试验证。")
        state = token_status(cache["token"], account)
        if state == "invalid":
            print("token 已失效。")
            clear_token(account)
        else:
            token = cache["token"]
            print("token 有效，跳过登录。" if state == "ok" else "暂时无法验证 token，仍使用该账号的本地登录态。")
    if token:
        return token, None
    if code:
        token = app_sms_login(account, code)
        if not token:
            return "", {"status": "error", "account": account, "message": "验证码登录失败"}
        save_token(account, token)
        return token, None
    if password:
        detail = app_login_detail(account, password)
        if detail.get("device_limited"):
            return "", {
                "status": "device_limited",
                "account": account,
                "message": detail.get("message") or "登录遇到设备限制，请改用手机验证码",
            }
        token = detail.get("token") or ""
        if not token:
            return "", {
                "status": "error",
                "account": account,
                "message": detail.get("message") or "账号密码登录失败",
            }
        save_token(account, token)
        return token, None
    return "", {
        "status": "logged_out",
        "loggedIn": False,
        "account": account,
        "message": "没有可用的登录状态，请先登录",
    }


def cli_session(account: str):
    """只确认登录态并刷新积分，不执行签到。"""
    if not check_config():
        _emit_result({"status": "error", "account": account, "message": "配置文件缺失或字段不完整"})
        return
    if not account:
        _emit_result({"status": "logged_out", "loggedIn": False, "account": account, "message": "未填写账号"})
        return
    cache = load_token(account)
    if not cache:
        _emit_result({"status": "logged_out", "loggedIn": False, "account": account, "message": "未登录"})
        return
    probed = h5_gateway_post(cache["token"], account, "mixc.app.memberSign.latticeList", {"mallNo": DEVICE["mallNo"]})
    if probed is None:
        points, last_point, signed_today = _stored_sign_state(cache)
        _emit_session(account, {
            "points": points,
            "lastSignPoints": last_point,
            "signedToday": signed_today,
        }, "暂时无法刷新积分，先显示上次记录")
        return
    if probed.get("code") not in (0, "0", None):
        clear_token(account)
        _emit_result({
            "status": "logged_out",
            "loggedIn": False,
            "account": account,
            "message": probed.get("message") or "登录已失效，请重新登录",
        })
        return
    snap = account_snapshot(cache["token"], account, lattice=probed.get("data") or {})
    _emit_session(account, snap)


def cli_login(account: str, password: str, code: str):
    """只登录并保存登录态，不签到。"""
    if not check_config():
        _emit_result({"status": "error", "account": account, "message": "配置文件缺失或字段不完整"})
        return
    if not account:
        _emit_result({"status": "error", "account": account, "message": "未填写账号"})
        return
    token, early = _acquire_token(account, password, code)
    if early and early.get("status") != "logged_out":
        _emit_result(early)
        return
    if not token:
        _emit_result(early or {"status": "logged_out", "loggedIn": False, "account": account, "message": "登录失败"})
        return
    snap = account_snapshot(token, account)
    _emit_session(account, snap, "登录成功")


def cli_logout(account: str):
    clear_token(account)
    _emit_result({"status": "logged_out", "loggedIn": False, "account": account, "message": "已退出登录"})


def cli_sign(account: str, password: str, code: str):
    """非交互签到：有缓存 token 就跳过登录；否则按验证码或密码登录。"""
    if not check_config():
        _emit_result({"status": "error", "account": account, "message": "配置文件缺失或字段不完整"})
        return
    if not account:
        _emit_result({"status": "error", "account": account, "message": "未填写账号"})
        return

    token, early = _acquire_token(account, password, code)
    if early:
        _emit_result(early)
        return

    signed = op_sign(token, account) or {"ok": False, "message": "签到没有返回结果"}
    snap = account_snapshot(
        token,
        account,
        lattice=signed.get("lattice"),
        sign_body=signed.get("sign_body"),
        already_signed=bool(signed.get("already_signed")),
    )
    if not signed.get("ok") and not signed.get("already_signed"):
        _emit_result({
            "status": "error",
            "loggedIn": True,
            "account": account,
            "message": signed.get("message") or "签到失败",
            "points": snap.get("points"),
            "lastSignPoints": snap.get("lastSignPoints"),
            "signedToday": snap.get("signedToday"),
        })
        return
    _emit_result({
        "status": "success",
        "loggedIn": True,
        "account": account,
        "message": signed.get("message") or "签到成功",
        "points": snap.get("points"),
        "lastSignPoints": snap.get("lastSignPoints"),
        "signedToday": snap.get("signedToday"),
        "step": signed.get("step"),
    })


def cli_main():
    """桌面端调用：从 stdin 读 JSON，结果打一行 MIXC_RESULT。"""
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        _emit_result({"status": "error", "account": "", "message": f"参数无法解析: {e}"})
        return
    if not isinstance(data, dict):
        _emit_result({"status": "error", "account": "", "message": "参数格式不正确"})
        return
    action = str(data.get("action") or "").strip()
    account = str(data.get("account") or "").strip()
    password = str(data.get("password") or "")
    code = str(data.get("code") or "").strip()
    if action == "send-code":
        if not check_config():
            _emit_result({"status": "error", "account": account, "message": "配置文件缺失或字段不完整"})
            return
        if not account:
            _emit_result({"status": "error", "account": account, "message": "未填写手机号"})
            return
        ok = send_check_code(account)
        _emit_result({
            "status": "success" if ok else "error",
            "account": account,
            "message": "验证码已发送" if ok else "验证码发送失败",
        })
        return
    if action == "session":
        cli_session(account)
        return
    if action == "login":
        cli_login(account, password, code)
        return
    if action == "logout":
        cli_logout(account)
        return
    if action == "sign":
        cli_sign(account, password, code)
        return
    _emit_result({"status": "error", "account": account, "message": f"未知操作: {action}"})


if __name__ == "__main__":
    if "--cli" in sys.argv:
        cli_main()
    else:
        main()
