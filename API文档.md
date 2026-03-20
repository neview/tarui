# API 接口文档

## 基础信息

| 项目 | 说明 |
|------|------|
| 基础URL | `http://your-server:5000` |
| 数据格式 | JSON |
| 字符编码 | UTF-8 |

---

## 接口列表

### 1. 发布微信小程序版本

用于发布微信小程序新版本并生成体验码图片。

**接口地址：** `POST /api/release-version`

#### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| username | string | 是 | 用户名 |
| password | string | 是 | 密码 |
| secretKey | string | 是 | 密钥 |
| version | string | 是 | 版本号 |
| name | string | 是 | 名称（用于@消息推送） |
| sendMessage | string | 否 | 是否发送消息，`1`发送，`0`不发送，默认 `1` |
| appid | string | 是 | 应用ID数组，JSON格式，如 `["wx123456789"]` |
| desc | string | 是 | 版本描述 |

#### 请求示例

```json
{
    "username": "admin",
    "password": "123456",
    "secretKey": "abc123secret",
    "version": "1.0.1",
    "name": "张三",
    "sendMessage": "1",
    "appid": "[\"wx99affa6621d21673\"]",
    "desc": "修复已知问题，优化性能"
}
```

#### 返回示例

**成功：**
```json
{
    "status": 1,
    "message": "程序执行完成"
}
```

**失败：**
```json
{
    "status": 0,
    "message": "缺少必填参数: version"
}
```

---

### 2. 获取微信日报数据

用于获取指定日期范围内的微信日报数据，并格式化返回。

**接口地址：** `POST /api/wx-ribao`

#### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| startDate | string | 是 | 开始日期，格式：`YYYY-MM-DD` |
| endDate | string | 是 | 结束日期，格式：`YYYY-MM-DD` |
| outputFormat | string | 否 | 输出格式，`1`带序号，`2`不带序号，默认 `1` |
| indentInTheLine | string | 否 | 是否行内缩进，`true`是，`false`否，默认 `false` |
| formUrl | string | 否 | 日报表单URL，默认使用预设值 |
| cookiesFile | string | 否 | cookies文件路径，默认 `cookies.txt` |

#### 请求示例

```json
{
    "startDate": "2026-03-01",
    "endDate": "2026-03-17",
    "outputFormat": "1",
    "indentInTheLine": "false"
}
```

#### 返回示例

**成功：**
```json
{
    "status": 1,
    "message": "获取成功",
    "data": {
        "formatted_text": "标题一\n1、内容1\n2、内容2\n\n标题二\n1、内容1\n",
        "count": 15
    }
}
```

**失败：**
```json
{
    "status": 0,
    "message": "缺少必填参数: startDate"
}
```

---

### 3. 健康检查

用于检查服务是否正常运行。

**接口地址：** `GET /health`

#### 返回示例

```json
{
    "status": "ok"
}
```

---

## 错误码说明

| status | 说明 |
|--------|------|
| 0 | 请求失败 |
| 1 | 请求成功 |

---

## 前端调用示例

### JavaScript (fetch)

```javascript
// 发布微信小程序版本
async function releaseVersion(data) {
    const response = await fetch('http://your-server:5000/api/release-version', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    });
    return await response.json();
}

// 获取微信日报数据
async function getWxRibao(data) {
    const response = await fetch('http://your-server:5000/api/wx-ribao', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    });
    return await response.json();
}
```

### Vue 3 (axios)

```javascript
import axios from 'axios';

const apiClient = axios.create({
    baseURL: 'http://your-server:5000',
    timeout: 120000 // 2分钟超时，因为涉及网络请求可能较慢
});

// 发布微信小程序版本
export const releaseVersion = (data) => {
    return apiClient.post('/api/release-version', data);
};

// 获取微信日报数据
export const getWxRibao = (data) => {
    return apiClient.post('/api/wx-ribao', data);
};
```

### 注意事项

1. **超时设置**：建议设置较长的请求超时时间（如2分钟），因为版本发布和日报获取涉及多个网络请求
2. **错误处理**：务必做好 `try-catch` 错误捕获
3. **cookies文件**：`wx-ribao` 接口需要服务器上的 `cookies.txt` 文件有效，若失效需要手动更新
