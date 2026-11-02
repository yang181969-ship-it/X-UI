# X-UI Product v1 — API 规格（API_SPEC）

> 状态：§2 为 M1 已实现接口；**§3 起为 M2 设计（M2-A 修订版），尚未实现**。
> 相关文档：[PRODUCT_SPEC.md](PRODUCT_SPEC.md) · [DATA_MODEL.md](DATA_MODEL.md) · [TEST_PLAN.md](TEST_PLAN.md)

## 1. 通用约定

- 基础路径 `/api`，JSON 请求与响应；本地 API `127.0.0.1:8788`，浏览器经 `http://localhost:5174` 访问（Vite 代理）。
- 认证：HttpOnly 会话 Cookie `xui_session`（HTTPS 下为 `__Host-xui_session`），SameSite=Strict。
- CSRF：所有非 GET/HEAD/OPTIONS 请求必须带 `x-xui-csrf: 1`，且 `Origin` 在 `XUI_V1_ORIGINS` 中，否则 403（`BAD_ORIGIN` / `CSRF`）。
- 除 §2.1 所列公开接口外，所有接口需要登录，否则 401 `UNAUTHENTICATED`。
- 请求体上限 1 MB（413 `TOO_LARGE`）。响应带 `Cache-Control: no-store` 与安全响应头。
- 错误格式：`{ "error": string, "code": string, "details"?: unknown }`。
- 请求体用 zod `.strict()` 校验：未知字段 → 400 `VALIDATION`。
- 他人的数据一律 404 `NOT_FOUND`（不泄露存在性）。
- 列表默认按 `sort, name` 排序；`status` 筛选缺省时返回非关闭/非归档项，`status=all` 返回全部。
- 所有 DTO **不包含任何金额或余额字段**。

### 1.1 错误码

| code | HTTP | 含义 |
|---|---|---|
| `VALIDATION` | 400 | 字段校验失败（含未知字段，如 `pan`、`cvv`） |
| `SENSITIVE_DATA` | 400 | 自由文本中出现疑似完整卡号或 CVV/PIN（无绕过参数） |
| `CARD_TYPE_UNSUPPORTED` | 400 | 卡片类型不是 `debit` / `prepaid`（如 `credit`） |
| `CURRENCY_NOT_ON_ACCOUNT` | 400 | 关联指定的币种不属于该账户或已关闭 |
| `CHANNEL_SOURCE_KIND` | 400 | 来源类型与渠道类型不符（设备钱包只能挂银行卡） |
| `BALANCE_ACCOUNT_KIND` | 400 | 余额账户只允许 `payment_service` 渠道，且账户类型须为 `e_money` 或 `stored_value` |
| `NOT_FOUND` | 404 | 不存在或不属于当前用户 |
| `DUPLICATE` | 409 | 重名机构 / 重复的有效关联 / 重名渠道 / 账户已是其他渠道的余额账户；`details.existingId` |
| `IN_USE` | 409 | 被引用，不能删除；`details.references` 给出引用计数 |
| `CURRENCY_IN_USE` | 409 | 币种被关联引用，不能移除（应改为关闭） |

## 2. M1 已实现接口（不变）

### 2.1 公开
- `GET /health` → `{ ok, product: "x-ui", edition: "v1" }`
- `GET /auth/me`、`POST /auth/login`、`POST /auth/logout`
- `POST /auth/passkey/options`、`POST /auth/passkey/verify`
- `GET /setup/:token`、`POST /setup/:token/begin`、`POST /setup/:token/confirm`

### 2.2 需要登录
- `PATCH /auth/profile`
- `POST /auth/step-up/options`、`POST /auth/step-up/passkey`、`POST /auth/step-up/totp`
- `GET /auth/sessions`、`DELETE /auth/sessions/:id`
- `GET /auth/passkeys`、`POST /auth/passkeys/options`*、`POST /auth/passkeys/verify`*、`PATCH /auth/passkeys/:id`、`DELETE /auth/passkeys/:id`*
- `POST /auth/password`*、`POST /auth/totp/rebind`*、`POST /auth/totp/rebind/confirm`*
- `GET /auth/recovery-codes`、`POST /auth/recovery-codes`*
- `GET /auth/audit`
- `GET /system/info`

\* 需要 step-up（5 分钟内验证过 Passkey 或 TOTP），否则 403 `STEP_UP_REQUIRED`。

## 3. M2 接口

M2 没有需要 step-up 的操作（不保存 PAN，没有查看卡号接口）。

### 3.1 设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/settings/profile` | → `{ homeRegion: "CN" }`（未设置时返回默认 `CN`） |
| PATCH | `/settings/profile` | `{ homeRegion }`，ISO alpha-2；只影响之后新建的 M3 流水，不回写历史 |

### 3.2 金融机构

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/institutions?q=&type=&country=&status=` | 列表；每项含 `accountCount`、`cardCount`、`channelCount` |
| POST | `/institutions` | 201；规范化名称 + 国家重复 → 409 `DUPLICATE`（`existingId`） |
| GET | `/institutions/:id` | 详情 + 下属账户、所发卡片、相关渠道摘要 |
| PATCH | `/institutions/:id` | 部分更新；改名或改国家同样做重名检查 |
| DELETE | `/institutions/:id` | 被引用 → 409 `IN_USE`（建议归档） |

请求体（POST）：
```json
{ "name": "Wise", "country": "GB", "institutionType": "emi", "website": "https://wise.com", "color": "#9fe870", "notes": null }
```

### 3.3 账户

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/accounts?q=&institutionId=&type=&country=&currency=&status=&cardId=` | 列表；每项含币种、`linkedCardCount` 与前 3 张卡摘要 |
| POST | `/accounts` | 账户 + 币种在一个 batch 中创建 |
| GET | `/accounts/:id` | 详情：币种、关联（含已结束，标记 `status`）、作为余额账户或来源的支付渠道 |
| PATCH | `/accounts/:id` | 部分更新（不含币种）；修改 `accountCountry` 不影响历史流水（M3 快照） |
| PUT | `/accounts/:id/currencies` | 整体替换币种列表；移除被关联引用的币种 → 409 `CURRENCY_IN_USE` |
| DELETE | `/accounts/:id` | 级联删除其币种、关联、渠道来源；被渠道用作余额账户 → 409 `IN_USE`；M3 起被流水引用 → 409 `IN_USE` |

请求体（POST）：
```json
{
  "institutionId": "…",
  "name": "Wise 多币种账户",
  "accountType": "e_money",
  "depositKind": null,
  "accountCountry": "BE",
  "currencies": [
    { "code": "USD", "isDefault": true },
    { "code": "EUR" },
    { "code": "GBP" }
  ],
  "numberHint": "1234",
  "status": "active",
  "openedOn": "2024-03-01",
  "notes": null
}
```
校验：`accountCountry` 必填（无服务端推断）；币种 1–30 个、不重复、恰好一个默认；`depositKind` 仅 `accountType = bank` 时允许。

`PUT /accounts/:id/currencies` 请求体：`{ "currencies": [{ "code": "USD", "isDefault": true, "status": "active" }, { "code": "JPY", "status": "closed" }] }`。

### 3.4 银行卡

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/cards?q=&network=&type=&form=&status=&issuerId=&accountId=&expiringWithinDays=` | 列表；每项含关联账户摘要 |
| POST | `/cards` | 创建；预付卡可同时创建储值账户 |
| GET | `/cards/:id` | 详情：关联账户（含已结束）、所属支付渠道 |
| PATCH | `/cards/:id` | 部分更新 |
| DELETE | `/cards/:id` | 级联删除其关联、渠道来源；M3 起被流水引用 → 409 `IN_USE` |
| GET | `/cards/:id/spending-source?currency=USD` | 默认消费来源推荐（只读，算法见 DATA_MODEL §5），返回 `exact_currency` / `conversion_required` / `no_match`，见 §3.4.1 |

请求体（POST）：
```json
{
  "issuerInstitutionId": "…",
  "name": "Wise Debit",
  "network": "visa",
  "cardType": "debit",
  "form": "physical",
  "last4": "4321",
  "issuingCountry": "BE",
  "expiresOn": "2028-07",
  "status": "active",
  "notes": null
}
```
- `cardType` 只接受 `debit`、`prepaid`；其他值 → 400 `CARD_TYPE_UNSUPPORTED`。
- 不接受 `pan`、`cardNumber`、`bin`、`cvv`、`pin`、`holderName` 等字段（400 `VALIDATION`）。

预付卡自动创建储值账户（仅 `cardType = prepaid`）：
```json
{
  "…": "card fields as above",
  "createStoredValueAccount": {
    "name": "某预付卡余额",
    "institutionId": "…",
    "accountCountry": "HK",
    "currency": "HKD"
  }
}
```
在一个 batch 中创建：银行卡 → 储值账户（`account_type = stored_value`）→ 账户币种（默认）→ 关联（`role = spending_source`、`currency = null`、`is_default = 1`）。`institutionId` 缺省为发卡机构；`accountCountry` 必填（不从发卡国家推断）。任一校验失败则什么都不创建。响应：`{ card, account, link }`。

#### 3.4.1 默认消费来源推荐

`GET /cards/:id/spending-source?currency=USD`

- `currency` 必填，是 **Event 消费币种**（ISO 4217，大写），不合法 → 400 `VALIDATION`；银行卡不存在或不属于当前用户 → 404。
- 只读：调用不会修改任何数据。
- 推荐前检查银行卡、关联（`spending_source` 且 `active`）、账户（`active`）、账户币种（`active`）的状态，任一不合格的来源都不会被返回。
- **不把账户默认币种当作消费币种或扣款币种**：只有 `exact_currency` 会返回 `fundingCurrency`。

响应总是 200，三种形状之一：

```json
{ "match": "exact_currency", "eventCurrency": "USD",
  "accountId": "…", "linkId": "…", "fundingCurrency": "USD" }
```
```json
{ "match": "conversion_required", "eventCurrency": "USD",
  "accountId": "…", "linkId": "…", "fundingCurrency": null,
  "candidateCurrencies": ["HKD", "EUR"] }
```
```json
{ "match": "no_match", "eventCurrency": "USD", "reason": "card_inactive" }
```

| 字段 | 说明 |
|---|---|
| `match` | `exact_currency`：合格来源账户持有该币种；`conversion_required`：有合格来源但不持有该币种；`no_match`：无合格来源 |
| `eventCurrency` | 原样返回请求的消费币种 |
| `fundingCurrency` | 仅 `exact_currency` 时等于 `eventCurrency`；`conversion_required` 时恒为 `null`，由用户选择 |
| `candidateCurrencies` | 仅 `conversion_required`：该来源可用的 active 币种（账户默认币种在前），只是候选 |
| `reason` | 仅 `no_match`：`card_inactive` 或 `no_eligible_link` |

M3 新建流水时：`exact_currency` 预填资金账户与扣款币种（扣款金额可预填为原始金额，用户可改）；`conversion_required` 预填资金账户，用户必须选择扣款币种，扣款金额由用户依据真实交易记录填写或标记待补录；`no_match` 由用户自行选择。M2 不计算汇率与手续费。

### 3.5 银行卡-账户关联

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/card-links` | 创建关联 |
| PATCH | `/card-links/:id` | 修改 `role`、`priority`、`notes`、`status`（`active` ⇄ `suspended`） |
| POST | `/card-links/:id/default` | 设为该卡在该币种范围内的默认消费来源（batch：清除旧默认 + 设置新默认） |
| POST | `/card-links/:id/end` | 解除关联：`{ endedOn? }`（缺省为今天）；状态变为 `ended`，保留历史，同时清除默认 |
| DELETE | `/card-links/:id` | 删除记录，仅用于纠正误录 |

请求体（POST）：
```json
{ "cardId": "…", "accountId": "…", "currency": null, "role": "spending_source", "isDefault": true, "priority": null, "startedOn": "2024-03-05", "notes": null }
```
规则：
- `currency` 非空时必须是该账户的 active 币种，否则 400 `CURRENCY_NOT_ON_ACCOUNT`。
- 同一 `(card, account, currency 范围, role)` 已有未结束关联 → 409 `DUPLICATE`。
- `isDefault` 只允许 `role = spending_source` 且状态为 `active`；设默认时自动清除同卡同币种范围内的旧默认。
- 状态改为 `suspended` 或 `ended` 时同时清除 `is_default`；恢复为 `active` 不会自动恢复默认。
- `ended` 不可再修改状态；需要时重新创建关联。
- 账户、账户币种或银行卡的状态变化（冻结、关闭）不修改关联及其默认标记，关联在详情与历史中照常可见；只是这些来源不再被推荐（§3.4.1），恢复有效后重新可被推荐。

关联 DTO：
```json
{
  "id": "…", "cardId": "…", "accountId": "…", "currency": null,
  "role": "spending_source", "isDefault": true, "priority": null,
  "status": "active", "startedOn": "2024-03-05", "endedOn": null, "notes": null,
  "card": { "id": "…", "name": "Wise Debit", "network": "visa", "last4": "4321", "cardType": "debit", "status": "active" },
  "account": { "id": "…", "name": "Wise 多币种账户", "accountCountry": "BE", "status": "active" }
}
```

### 3.6 支付渠道

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/payment-channels?q=&type=&status=` | 列表；每项含来源数量、余额账户摘要 |
| POST | `/payment-channels` | 创建；重名 → 409 `DUPLICATE` |
| GET | `/payment-channels/:id` | 详情：余额账户、来源（含已结束） |
| PATCH | `/payment-channels/:id` | 部分更新 |
| DELETE | `/payment-channels/:id` | 级联删除来源；M3 起被流水引用 → 409 `IN_USE`（建议归档） |
| POST | `/payment-channels/:id/sources` | 添加来源 `{ cardId }` 或 `{ accountId }`（二选一），可带 `isDefault` |
| PATCH | `/payment-channel-sources/:id` | 修改 `isDefault`、`notes` |
| POST | `/payment-channel-sources/:id/end` | 结束来源（保留历史，清除默认） |
| DELETE | `/payment-channel-sources/:id` | 删除记录，仅用于纠正误录 |

请求体（POST `/payment-channels`）：
```json
{ "name": "PayPal", "channelType": "payment_service", "providerInstitutionId": "…", "balanceAccountId": "…", "region": "LU", "notes": null }
```
规则：
- `channelType` 只接受 `device_wallet`、`payment_service`、`other`（无 `bank_transfer`）。
- `balanceAccountId` 仅 `payment_service` 允许，账户须为 `e_money` 或 `stored_value`，且未被其他渠道占用（否则 409 `DUPLICATE`）。
- `device_wallet` 的来源只能是银行卡（400 `CHANNEL_SOURCE_KIND`）。
- 同一渠道同一来源的有效记录只能有一条（409 `DUPLICATE`）。

### 3.7 审计

M2 记录以下审计动作（detail 只含 id 与后四位）：`institution.delete`、`account.delete`、`card.create`、`card.delete`、`card_link.create`、`card_link.end`、`card_link.delete`、`channel.delete`、`settings.home_region`。

## 4. 不在 M2 的接口
- 查看卡号（`/cards/:id/reveal`）—— 不保存 PAN，因此不存在。
- BIN 查询 —— 不存储；如未来需要，只在浏览器端临时查询。
- 任何余额、金额、汇总接口 —— M3 起再定义（且不做换算合计）。
