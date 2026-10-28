---
name: maimai
description: agent-browser-bridge 的子技能——脉脉（maimai.cn）远程岗位信源专项。当任务需要从脉脉捞远程招聘信息（实名动态/职言的招聘帖、HR 与猎头的帖子、帖子里的微信/邮箱联系方式）时读取本文件执行。覆盖：桌面网页没有求职者职位库的判定依据、站内搜索接口 /sdk/search/web_get 的完整参数与 _csrf 取法、搜索限流页与 204 空体的区分、帖子详情页 URL、发帖人字段与联系方式提取、噪声过滤口径。前置：根 SKILL.md 的桥已就绪，用户已在浏览器登录 maimai.cn。脉脉只当信源，不当投递平台。
---

# 脉脉专项：远程招聘帖信源

> **路径约定**：`<skill 目录>` 指本文件所在目录，`<仓库根>` = `<skill 目录>/../..`。桥接库用 `<skill 目录>/../scripts/lib/bridge.mjs`。

依赖：根 skill（host 存活、扩展已连接、用户已登录 maimai.cn）。本专项全部操作只读。

## 1. 站点结构：桌面网页没有求职者职位库

登录态下导航只有 首页／实名动态／职言／招聘管理／网页聊天，逐条验证过：

| 入口 | 实际内容 |
|---|---|
| `/jobs` | 招聘方宣传页（人才银行、人才智库、拓客通），不是职位列表 |
| `/job` | 302 到 `/jobs/job_detail`，页面显示「当前职位已失效」 |
| `/jobs/list`、`/jobs/search`、`/job_search`、`/sdk/jobs/*` | 404 或落回首页（八个 `/sdk/jobs/*` 猜测全 404） |
| `/zp` | 302 到招聘方控制台 `/ent/talents/discover/search_v2`（搜人才） |
| `/web/search_center` | 只有「实名动态／职言交流／人脉」三个 tab |
| `gaopin.maimai.cn` | ERR_CONNECTION_CLOSED，脉脉高聘没有可访问的独立站点 |

结论：岗位信息只存在于动态/职言的帖子里，脉脉只能当信源（拿到公司名与联系方式后走官网/ATS/邮件）。不要再去猜职位 API。

## 2. 搜索接口（唯一可靠数据源）

页面真实调用：

```
GET /sdk/search/web_get?query=<词>&frm=website&u=<uid>&channel=www&version=4.0.0
    &lim=20&o=0&_csrf=<csrf>&_csrf_token=<token>
```

返回 `{contacts, feeds, gossips, searchTokens, searchKey, result}`：

- `feeds.feeds[]`：实名动态。`{fid, efid, feed:{text, crtime, likes, total_cnt, summary}, contact:{name, position, company, city, headline, mmid}}`
- `gossips.gossips[]`：职言。`{gid, gossip:{text, crtime, username, ...}}`，**没有公司字段**
- `feeds.count / remain / more`：每查询只回 2–4 条；`lim` 无效，`o` 翻页也拿不到更多，**靠关键词面覆盖拿量**，不要花时间调分页参数

`u` 是当前登录用户 id，可从 cookie `u=` 取。

## 3. `_csrf` 与 `_csrf_token`（缺了恒回 204 空体）

- 页面把 token 放在 `sessionStorage['X-CSRF-Token']`，`document.cookie` 里没有（httpOnly），所以 `hasCsrf:false` 是正常现象。
- 真实请求 URL 里 `_csrf` 与 `_csrf_token` 是**两个不同的值**。取法优先级：
  1. `performance.getEntriesByType('resource')` 里最后一条含 `/sdk/search/web_get` 的完整 URL，正则取两个参数（最稳）；
  2. 只有 sessionStorage 单值时，同值顶两处，能跑但更容易 204。
- 拿到 204 先别归因限流：查 `location.href` 是否 `/n/member/mobile/access-limit`，再看页面文案。

## 4. 限流：5 分钟保护机制

- 触发条件：短时间连发。实测 16 个查询/35 秒即触发。
- 现象：跳 `/n/member/mobile/access-limit?type=search`，文案「访问过于频繁，为保障账户安全，系统已触发保护机制」，页面带倒计时（实测 4 分 08 秒）。
- 处置：**立即停手，不 reload、不换 tab 重试**（重试只会加深限制）。把 `limitedUntil` 记进状态文件，到点再跑。
- 安全节奏：每查询 3–4.5 秒抖动，单轮 ≤12 个查询；实测该节奏可连续跑完不触发。
- `/search/check_access_limit?uid=<uid>&word=<词>&type=gossip` 返回 `{is_limited, search_count_1h, search_count_24h}`，可作旁证但实测与页面限流不同步，别当唯一判据。

## 5. 帖子详情

- 实名动态：`https://maimai.cn/article/detail?efid=<efid>&fid=<fid>` 可读正文＋评论区（求内推、HR 回复都在评论里）。
- 职言：`/gossip/detail?egid=`、`/article/detail?efid=<egid>` 均 404 或落回首页，**没有公开详情页**，只能留 `gid` 站内定位。
- `/feed/detail?fid=`、`/web/feed_detail?fid=` 都是 404 或 SPA 兜底首页，不要用。

## 6. 联系方式与噪声

- 微信/邮箱常写在 `contact.headline`（如「有意向可加微信daisyweb3」），正文往往只有岗位与薪资。提取时把 `text + headline` 拼一起跑正则：微信、邮箱、手机号、`https://` 链接。
- 噪声类型：聊行情、比 offer、问建议、面经、求职求内推。判定要三道闸：岗位信号（招聘/急招/急聘/内推/岗位/职位/`4HC`/JD）、岗位名首行（工程师/开发/前端/后端/全栈/产品经理…）、讨论帖信号（怎么选/求建议/请教/吐槽/面经/面试题）。
- 「远程」要分真假：`远程面试/线上面试/视频面试/远程一轮` 是面试形式，先剔除再判远程；裸词「远程」只在开头几行生效。

## 7. 实现方式

本子技能不附带脚本：第 2–6 节已给出完整配方，用 `<skill 目录>/../scripts/lib/bridge.mjs` 的 `Rpc` 实现（`rpc.ev()` 在页面内发请求、`rpc.withPage()` 管理标签页）。
