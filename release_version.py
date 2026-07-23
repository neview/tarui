# -*- coding: utf-8 -*-
#
# ⚠️ 唯一真源（Single Source of Truth）：本文件维护在后端仓库 py-test 中。
#    tauri-app/release_version.py 是由 scripts/sync-scripts.mjs 在 dev/build
#    前自动同步生成的副本，请勿直接编辑那份副本——任何改动都应在本文件进行，
#    否则会在下次同步时被覆盖。

import sys
import json
from time import sleep

import requests
import base64
import hashlib
import time
import warnings
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from io import BytesIO

sys.stdout.reconfigure(encoding='utf-8', errors='ignore')
sys.stderr.reconfigure(encoding='utf-8', errors='ignore')

# 全局日志收集
logs = []


def log(msg):
    """收集日志信息

    同时把日志实时打印到 stdout（flush），
    这样在「本地脚本模式」下（由 Tauri/命令行调用）也能实时看到执行进度；
    在「后端接口模式」下这些额外的打印会进入服务端日志，不影响返回的 logs 列表。
    """
    logs.append(msg)
    try:
        print(msg, flush=True)
    except Exception:
        pass


def sendImg(imgPath, name, webhook_key="4cbef34d-76fe-42f1-b218-20c89264279c"):
    """发送图片和消息到企业微信群"""
    try:
        with open(imgPath, 'rb') as file:
            file_data = file.read()
            base64_data = base64.b64encode(file_data).decode('utf-8').replace('\n', '')
            md5_hash = hashlib.md5(file_data).hexdigest()
            if not base64_data:
                warnings.warn('文件缺失')

            obj = {
                "msgtype": "image",
                "image": {
                    "base64": base64_data,
                    "md5": md5_hash,
                },
            }
            response13 = requests.post(
                f"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={webhook_key}",
                headers={"Content-Type": "application/json"}, json=obj).json()
            if response13['errcode'] == 0:
                log('图片发送成功')
            else:
                warnings.warn('图片发送失败')

            obj2 = {
                "msgtype": "text",
                "text": {
                    "content": ' @' + name + ' 测试saas微信小程序',
                    "mentioned_list": [name],
                },
            }
            response14 = requests.post(
                f"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={webhook_key}",
                json=obj2).json()

            if response14['errcode'] == 0:
                log('群消息发送成功')
            else:
                warnings.warn('群消息发送失败')

    except Exception as e:
        log("读取文件失败：" + str(e))


def generateImg(data):
    """执行发布版本的主逻辑"""
    # 清空日志
    logs.clear()

    urlM = "https://supplier.mgmovie.net/v2/api/"
    urlW = "https://api.weixin.qq.com/"
    tokenW = ''
    image_urls = []
    titles = []
    version = data["version"]
    raw_appid = data.get("appid", [])
    appid = json.loads(raw_appid) if isinstance(raw_appid, str) else raw_appid
    username = data["username"]
    password = data["password"]
    name = data["name"]
    desc = data["desc"]
    secretKey = data["secretKey"]
    sendMessage = str(data.get("sendMessage", "1"))
    headers9 = {}

    log('参数获取成功')

    try:
        # 获取token
        data_params = {'code': secretKey, 'timestamp': int(time.time() * 1000)}
        response = requests.post(urlM + '6788b30915ae5', json=data_params).json()
        if response['code'] == 1:
            tokenW = response['data']['token']
        else:
            raise Exception("参数获取失败")
        log('参数获取成功')

        # 获取模板列表并删除最旧版本
        response2 = requests.get(urlW + 'wxa/gettemplatelist?access_token=' + tokenW + '&template_type=0').json()
        if response2['errcode'] == 0:
            log('废弃版本获取成功')
            new_arr_desc = sorted(response2['template_list'], key=lambda x: x["template_id"])
        else:
            warnings.warn(response2['errmsg'])

        dataDeleteTemplate = {'template_id': new_arr_desc[0]['template_id']}
        response3 = requests.post(urlW + 'wxa/deletetemplate?access_token=' + tokenW, json=dataDeleteTemplate).json()
        if response3['errcode'] == 0:
            log('废弃版本删除成功')
        else:
            warnings.warn(response3['errmsg'])

        # 获取草稿列表
        response4 = requests.get(urlW + 'wxa/gettemplatedraftlist?access_token=' + tokenW).json()
        if response4['errcode'] == 0:
            log('版本获取成功')
            draftId = ''
            for draft in response4['draft_list']:
                if draft['user_version'] == version:
                    draftId = draft['draft_id']
                    log('版本号-1：' + draft['user_version'])
                    break

            if draftId == '':
                draftId = response4['draft_list'][0]['draft_id']
                log('版本号-2：' + response4['draft_list'][0]['user_version'])
        else:
            raise Exception("版本获取失败")

        # 添加到模板库
        datAaddtotemplate = {'draft_id': draftId}
        response5 = requests.post(urlW + 'wxa/addtotemplate?access_token=' + tokenW, json=datAaddtotemplate).json()
        if response5['errcode'] == 0:
            log('模版添加成功')
        else:
            warnings.warn(response5['errmsg'])

        # 获取模板信息
        response6 = requests.get(urlW + 'wxa/gettemplatelist?access_token=' + tokenW + '&template_type=0').json()
        itemInfo = {}
        if response6['errcode'] == 0:
            log('模板获取成功')
            for item in response6['template_list']:
                if item['user_version'] == version:
                    itemInfo['template_id'] = item['template_id']
                    itemInfo['user_version'] = item['user_version']

            if not itemInfo.get('template_id') or not itemInfo.get('user_version'):
                warnings.warn('模板获取-未找到指定版本模板')
        else:
            warnings.warn(response6['errmsg'])

        # 登录获取token
        dataM = {'password': password, 'username': username}
        response7 = requests.post(urlM + "6295add6cb1e7", json=dataM).json()
        if response7['code'] == 1:
            log('登录成功')
            headers9 = {'user-token': response7['data']['user_token']}
        else:
            warnings.warn(response7['message'])

        # 获取当前线上版本
        oldVersion = ''
        ver = ''
        listItem = ''
        page = 0
        while not oldVersion:
            page += 1
            response8 = requests.get(urlM + "62be49d5b41e8", headers=headers9, params={"page": page}).json()
            ver = ''
            listItem = ''
            if response8['code'] == 1:
                for item in response8['data']['list']:
                    if item['is_online'] == 1:
                        oldVersion = item['id']
                        ver = item['user_version']
                        listItem = item
                        break
            else:
                warnings.warn(response8['message'])
                break

        if oldVersion:
            if ver == '1.4.4':
                warnings.warn('线上版本异常- 1.4.4，重新获取一下')
            else:
                log('线上版本为：' + ver)

        # 添加模板
        data9 = {'appId': "wx99affa6621d21673", 'template_id': itemInfo['template_id'],
                 'user_version': itemInfo['user_version'], 'version_desc': desc}
        response9 = requests.post(urlM + "62be4a2a4abb8", headers=headers9, json=data9).json()
        if response9['code'] == 1:
            log('添加模版成功')
        else:
            warnings.warn(response9['message'])

        # 获取模板列表
        response10 = requests.get(urlM + "62be49d5b41e8", headers=headers9).json()
        if response10['code'] == 1:
            log('模版列表获取成功')
        else:
            warnings.warn(response10['message'])

        # 提交线上
        data11 = {'code_id': response10['data']['list'][0]['id']}
        response11 = requests.post(urlM + "62be4a393f9e2", headers=headers9, json=data11).json()
        if response11['code'] == 1:
            log('提交线上成功')
        else:
            warnings.warn(response11['message'])

        # 获取应用二维码图片
        def getAppidImg(bid, app_name):
            response12 = requests.get(urlM + "62fc9d43dc3a7", headers=headers9, params={"business_id": bid}).json()
            if response12['code'] == 1:
                log(app_name + '获取成功')
                image_urls.append('https://' + response12['data']['qr_code'])
            else:
                log(app_name + '获取失败-', response12['message'])

        for item in appid:
            responseId = requests.get(urlM + "62cbf4622b81b", headers=headers9,
                                     params={'app_id': item, 'page': 1, 'pageSize': 30}).json()
            if responseId['code'] == 1:
                getAppidImg(item, responseId['data']['list'][0]['app_name'])
                titles.append(responseId['data']['list'][0]['app_name'])
            else:
                log('id:' + item + '应用名称获取失败-' + responseId['message'])

        if not titles:
            warnings.warn('应用名称获取失败')

        # 退回旧版本
        response13 = requests.post(urlM + "62be4a393f9e2", headers=headers9, json={'code_id': oldVersion}).json()
        if response13['code'] == 1:
            log('旧版本：' + ver + '已设回线上')
        else:
            log('旧版本：' + ver + '设回线上失败！')

        # 生成合并图片
        process_images(image_urls, titles)

        if sendMessage == "1":
            sendImg("output/combined_result.png", name)
        else:
            log('已跳过消息推送')
            return {"code": 1, "message": "执行完成，已跳过消息推送", "log": logs}

    except Exception as e:
        log(f"程序执行出错: {e}")
        return {"code": 0, "message": f"程序执行出错: {str(e)}", "log": logs}
    else:
        log("程序执行完成")
        return {"code": 1, "message": "程序执行完成", "log": logs}


def download_image(url):
    """下载网络图片并返回PIL.Image对象"""
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        return Image.open(BytesIO(response.content))
    except Exception as e:
        log('下载图片失败（url）：' + url + '-' + str(e))
        return None


def _get_chinese_font(font_size):
    """优先使用系统中文字体，避免标题乱码"""
    windir = os.environ.get("WINDIR", "C:\\Windows")
    candidates = [
        # Windows
        os.path.join(windir, "Fonts", "msyh.ttc"),
        os.path.join(windir, "Fonts", "msyhbd.ttc"),
        os.path.join(windir, "Fonts", "simhei.ttf"),
        os.path.join(windir, "Fonts", "simsun.ttc"),
        # Linux - WenQuanYi
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        # Linux - Noto CJK
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
        # Linux - Droid
        "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
        # macOS
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ]

    for path in candidates:
        if path and os.path.exists(path):
            try:
                return ImageFont.truetype(path, font_size)
            except Exception:
                continue

    # 尝试通过 fc-list 搜索系统中文字体（Linux/macOS）
    try:
        import subprocess
        result = subprocess.run(
            ["fc-list", ":lang=zh", "-f", "%{file}\n"],
            capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.strip().splitlines():
            fp = line.strip()
            if fp and os.path.exists(fp):
                try:
                    return ImageFont.truetype(fp, font_size)
                except Exception:
                    continue
    except Exception:
        pass

    log("警告: 未找到中文字体，标题可能显示为乱码")
    return ImageFont.load_default()


def add_title_to_image(image, title, font_path="simhei.ttf", font_size=40, text_color=(0, 0, 0)):
    """在图片底部添加标题（支持中文）"""
    title_height = font_size + 36
    new_image = Image.new("RGB", (image.width, image.height + title_height), (255, 255, 255))
    new_image.paste(image, (0, 0))

    draw = ImageDraw.Draw(new_image)
    font = _get_chinese_font(font_size)

    text_bbox = draw.textbbox((0, 0), title, font=font)
    text_width = text_bbox[2] - text_bbox[0]
    text_x = (image.width - text_width) // 2
    text_y = image.height + 10

    draw.text((text_x, text_y), title, font=font, fill=text_color)
    return new_image


def merge_images_horizontally(images, output_path):
    """将多张图片水平合并为一张长图"""
    if not images:
        log("无图片可合并")
        return

    max_height = max(img.height for img in images)
    total_width = sum(img.width for img in images)

    combined_image = Image.new("RGBA", (total_width, max_height), (0, 0, 0, 0))

    x_offset = 0
    for img in images:
        img_rgba = img.convert("RGBA")
        combined_image.paste(img_rgba, (x_offset, 0), img_rgba)
        x_offset += img.width

    combined_image.save(output_path, "PNG")
    log('体验码合并成功')


def process_images(url_list, title_list, output_dir="./output"):
    """批量处理图片：下载→添加标题→水平合并"""
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    processed_images = []

    for i, (url, title) in enumerate(zip(url_list, title_list)):
        image = download_image(url)
        if image is None:
            continue

        titled_image = add_title_to_image(image, title)
        processed_images.append(titled_image)

    if processed_images:
        output_path = os.path.join(output_dir, "combined_result.png")
        merge_images_horizontally(processed_images, output_path)
    else:
        log("无有效图片可合并")


def release_version_handler(data):
    """API处理器 - 发布微信小程序版本"""
    return generateImg(data)


if __name__ == '__main__':
    # 独立运行测试
    import argparse

    parser = argparse.ArgumentParser(description="参数示例")
    parser.add_argument("--username", type=str, help="username")
    parser.add_argument("--password", type=str, help="password")
    parser.add_argument("--secretKey", type=str, help="secretKey")
    parser.add_argument("--version", type=str, help="version")
    parser.add_argument("--name", type=str, help="name")
    parser.add_argument("--sendMessage", type=str, help="是否发送消息(1发送,0不发送)")
    parser.add_argument("--appid", type=str, help="应用ID数组(JSON格式)")
    parser.add_argument("--desc", type=str, help="描述")
    args = parser.parse_args()

    # 本地脚本模式：执行发布逻辑，并把结构化结果以带标记的单行 JSON 输出，
    # 便于调用方（Tauri Rust 端）解析 code / message / log。
    result = generateImg(vars(args))
    try:
        print("RELEASE_RESULT:" + json.dumps(result, ensure_ascii=False), flush=True)
    except Exception:
        pass
    # code==1 视为成功，其余为失败
    sys.exit(0 if isinstance(result, dict) and result.get("code") == 1 else 1)
