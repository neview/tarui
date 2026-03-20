import os
import sys

import argparse
import pyperclip
import requests
import json
from playwright.sync_api import sync_playwright
import time
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8', errors='ignore')
sys.stderr.reconfigure(encoding='utf-8', errors='ignore')

parser = argparse.ArgumentParser(description="参数示例")
parser.add_argument("--outputFormat", type=str, help="outputFormat")
parser.add_argument("--indentInTheLine", type=str, help="indentInTheLine")
parser.add_argument("--startDate", type=str, help="startDate")
parser.add_argument("--endDate", type=str, help="endDate")
args = parser.parse_args()

id=''
strTime=args.startDate
endTime=args.endDate
conformList=[]
index = 0
key = ''
cookies = ''
template_id = ''

# 格式化配置
format_type = int(args.outputFormat) if args.outputFormat else 1        # 输出格式: 1=带序号, 2=不带序号
format_indent = str(args.indentInTheLine).lower() == "true"   # 是否行内缩进: True=缩进, False=不缩进

def fileNoneDate():
    # 文件不存在
    cookies = get_cookies_by_playwright(url)
    saveFile(cookies)

def get_cookies_by_playwright(url: str):
    with sync_playwright() as p:
        # 也可使用 pw_chromium.launch(headless=True, channel="chrome") 使用系统 Chrome
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        try:
            page.goto(url, wait_until="networkidle")  # 等待网络空闲
            time.sleep(5)  # 视业务再加一点缓冲
            cookies = context.cookies()
            return cookies  # 已是字典列表，含 name/value/domain/path/expires/httpOnly/secure/sameSite
        finally:
            browser.close()

def saveFile(cookies):
    # 固定值 cookie
    obj = {
        'markHashId_L': '83437b2d-6266-4068-956f-9bbebeed19bf',
        '_clck': 'uvr0fj|1|fzn|0',
        'optimal_cdn_domain': 'res.wx.qq.com',
    }
    arr = ['low_login_enable','TOK','traceid','hashkey','tdoc_uid','wedoc_openid','wedoc_sid','wedoc_sids','wedoc_skey','wedoc_ticket']
    name2value = {c['name']: c['value'] for c in cookies}
    result = {k: name2value.get(k) for k in arr}
    obj.update(result)
    with open('cookies.txt', 'w', encoding='utf-8') as f:  # 建议指定编码为utf-8，避免乱码
        json.dump(obj, f, ensure_ascii=False, indent=4)  # indent=4让内容格式化，更易读
    getReportInfo(obj)


def is_date_in_range(check_date, start_date_str, end_date_str, date_format="%Y-%m-%d"):
    # 1. 统一转换 check_date 为 datetime 对象
    if isinstance(check_date, int):
        # 如果是时间戳，转 datetime
        check_dt = datetime.fromtimestamp(check_date)
    elif isinstance(check_date, str):
        # 如果是日期字符串，按格式解析
        check_dt = datetime.strptime(check_date, date_format)
    elif isinstance(check_date, datetime):
        # 如果已经是 datetime 对象，直接使用
        check_dt = check_date
    else:
        raise ValueError("check_date 仅支持 datetime/int(时间戳)/str(日期字符串)")

    # 2. 解析起始和结束日期为 datetime 对象
    start_dt = datetime.strptime(start_date_str, date_format)
    end_dt = datetime.strptime(end_date_str, date_format)

    # 3. 判断是否在范围内（包含边界）
    return start_dt <= check_dt <= end_dt

def storeConformList(list):
    global strTime
    global endTime
    global conformList
    for item in list:
        if is_date_in_range(item['createtime'], strTime, endTime):
            conformList.append(item)

def deduplicate_and_sort_by_field(arr, field="A", keep_last=True, reverse=False):
    """
    根据指定字段去重并排序数组（字典数组）
    :param arr: 原始数组（元素为字典）
    :param field: 去重/排序的字段（默认"A"）
    :param keep_last: 去重时保留最后一次出现的项（True）/首次出现的项（False）
    :param reverse: 排序是否降序（True=降序，False=升序）
    :return: 去重+排序后的新数组
    """
    # 步骤1：去重 - 利用字典键唯一特性
    unique_dict = {}
    for item in arr:
        # 确保字段存在，避免KeyError
        if field not in item:
            raise ValueError(f"数组项缺少字段：{field}")

        key = item[field]
        # 保留末次出现：直接覆盖；保留首次出现：仅当键不存在时赋值
        if keep_last or key not in unique_dict:
            unique_dict[key] = item

    # 步骤2：提取去重后的列表，并按A字段排序
    # sorted的key参数指定排序依据，reverse控制升降序
    sorted_list = sorted(
        unique_dict.values(),
        key=lambda x: x[field],  # 按A字段的值排序
        reverse=reverse
    )

    return sorted_list

def format_data_and_copy(data, remove_duplicate=True):
    """
    格式化数据并复制到剪贴板（支持控制是否带序号、行内缩进）
    :param data: 原始数据数组
    :param remove_duplicate: 是否去除重复项（默认True）
    :return: 格式化后的文本
    """
    global format_type, format_indent

    # 工具函数：去除原有序号，保留纯文本内容
    def remove_original_number(text):
        if '、' in text:
            parts = text.split('、', 1)  # 仅分割第一个「、」
            if parts[0].strip().isdigit():
                return parts[1].strip()
        return text.strip()

    # 校验type参数合法性
    type = format_type
    if type not in [1, 2]:
        print("⚠️ type参数仅支持1（带序号）或2（不带序号），已默认使用type=1")
        type = 1

    # 是否行内缩进
    indent = format_indent

    formatted_text = ""
    for item in data:
        # 拼接title
        title = item.get('title', '')
        if not title:
            continue
        formatted_text += f"{title}\n"

        # 处理list数据
        list_items = item.get('list', [])
        if not list_items:
            continue

        # 步骤1：去重 + 剥离原有序号
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

        # 步骤2：根据type和indent生成不同格式的列表项
        indent_str = "    " if indent else ""
        if type == 1:
            # type=1：带序号（1、2、3...）
            for idx, pure_text in enumerate(list_items, 1):
                formatted_text += f"{indent_str}{idx}、{pure_text}\n"
        elif type == 2:
            # type=2：不带序号，仅纯文本
            for pure_text in list_items:
                formatted_text += f"{indent_str}{pure_text}\n"

        # 每个title后加空行分隔
        formatted_text += "\n"

    # 去除末尾多余空行
    formatted_text = formatted_text.strip()

    # 复制到剪贴板
    try:
        pyperclip.copy(formatted_text)
        print(f"✅ 数据已格式化为并复制到剪贴板！")
        print("------------------------ 格式化结果预览 ------------------------")
        print(formatted_text)
    except Exception as e:
        print(f"❌ 复制到剪贴板失败：{str(e)}")
        print("------------------------ 格式化结果 ------------------------")
        print(formatted_text)

    return formatted_text

def mergeData(data):
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

    format_data_and_copy(info)

def requestNextList():
    global index
    global cookies
    global key
    global template_id
    if index < 6:
        try:
            url = 'https://doc.weixin.qq.com/wework/journal'
            obj = {"lastjournal_id": key, "direction": 1, "limit": 20, "isconditionquery": True,
                   "querydetail": {"submission_type": 1, "template_id": template_id, "partyids": [], "vids": []}}
            response = requests.post(url + "/get_journal_list?sid=" + cookies['wedoc_sid'] + "&wedoc_xsrf=1", json=obj,
                                     headers={"Content-Type": "application/json"}, cookies=cookies).json()
            if response['errcode'] == 0:
                index = index + 1
                key = response['entrys'][5]['journalid']
                storeConformList(response['entrys'])
                time.sleep(2)
                requestNextList()
            else:
                print(response)
        except requests.exceptions.RequestException as e:
            print(f"第{index}次接口请求失败：{str(e)}")
            raise
    else:
        result1 = deduplicate_and_sort_by_field(conformList, field="createtime")
        mergeData(result1)
        sys.exit(0)

def getReportInfo(result):
    global id
    global key
    global cookies
    global template_id
    obj={"form_id":id,"fetch_journal_list":True,"is_pre_create":False,"is_answer_from_share":False,"is_answer_from_workplace":False,"fetch_submission_type":1,"is_only_view":True}
    cookies=result
    url='https://doc.weixin.qq.com/journal/'
    response = requests.post(url+"get_template_combine_info?_prefetch=1", json=obj, headers={"Content-Type": "application/json"},cookies=result).json()
    if response["head"]['ret'] == 0:
        print('success')
        storeConformList(response["body"]['entrys'])
        key = response["body"]['entrys'][5]['journalid']
        template_id = response["body"]['template_id']
        requestNextList()
    else:
        print('error:', response)
        with open('cookies.txt', 'w', encoding='utf-8') as f:
            pass  # 不写入任何内容，文件即变为空

if __name__ == "__main__":
    url = "https://doc.weixin.qq.com/forms/j/AKUAmwcxAA4AMcALQaMABgCNxhNl1H9Mj_fork?page=5&_cef_tabid_=9f85d2b15d5507808aacc7beca28b7b7#/journal-answer/8?journaluuid=5tnb2GLSq3uGsirYomG29gnFa1Ew5qBh8eBREjWL4ARBFC71eYfN9QMQ9vboGRmWRM"
    id = url.split('/forms/j/')[1].split('?')[0]
    if os.path.exists('cookies.txt'):
        if os.path.getsize('cookies.txt') == 0:
            fileNoneDate()
        else:
            with open('cookies.txt', "r", encoding="utf-8") as f:
                getReportInfo(json.load(f))
    else:
        fileNoneDate()


