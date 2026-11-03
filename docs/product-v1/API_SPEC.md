# X-UI Product v1 — API 规格（API_SPEC）

> 状态：§2 为 M1 已实现接口；§3 起为 M2 设计（M2-A 修订版，含 M2-B1 加固）。**§3.2 金融机构已在 M2-B2.1 实现，§3.3 账户已在 M2-B2.2 实现，§3.1 个人设置已在 M2-B2.3 实现，§3.4 银行卡的 CRUD 已在 M2-B3 实现，§3.5 银行卡-账户关联与 §3.4.1 `spending-source` 推荐已在 M2-B4 实现，§3.6 支付渠道及其资金来源已在 M2-B5 实现**（M2 全部接口已实现）。
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
| `CHANNEL_SOURCE_KIND` | 400 | 来源类型与渠道类型不符（设备钱包只能挂银行卡；仍有账户来源（含已结束）的渠道不能改为设备钱包，`details = { accountSources, activeAccountSources, endedAccountSources }`，M2-B5） |
| `BALANCE_ACCOUNT_KIND` | 400 | 余额账户只允许 `payment_service` 渠道，且账户类型须为 `e_money` 或 `stored_value` |
| `NOT_FOUND` | 404 | 不存在或不属于当前用户 |
| `DUPLICATE` | 409 | 重名机构 / 重复的有效关联 / 重名渠道 / 账户已是其他渠道的余额账户；`details.existingId` |
| `IN_USE` | 409 | 被引用，不能删除；`details.references` 给出引用计数 |
| `CURRENCY_IN_USE` | 409 | 币种被关联引用，不能移除（应改为关闭） |
| `INSTITUTION_ARCHIVED` | 409 | 机构已归档，不能新建账户（先恢复机构）；`details.institutionId`（M2-B2.2 复审新增；M2-B3 起同样用于新银行卡的发卡机构，M2-B5 起用于新指定的支付渠道服务机构） |
| `LINK_STATE` | 409 | 关联当前的状态不允许该操作：已结束的关联不能再改状态、用途、优先级或设为默认，暂停的关联不能设为默认；`details.status`（M2-B4 新增；M2-B5 起同样用于已结束的支付渠道来源：不能设为默认或再次结束） |

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
| GET | `/settings/profile` | → `{ homeRegion: "CN", isDefault: true }`：当前用户的 `user_preferences`；没有记录时返回默认 `CN`（`isDefault: true`） |
| PATCH | `/settings/profile` | `{ homeRegion }`，ISO alpha-2；写入（不存在则创建）当前用户的 `user_preferences` 行，不影响其他用户；只影响之后新建的 M3 流水，不回写历史；→ 与 GET 相同的 DTO |

实现说明（M2-B2.3）：
- 路径中没有用户 id：读写一律以会话用户为准，无法读取或修改他人的设置；请求体 `.strict()`，带 `userId` 等未知字段 → 400 `VALIDATION`。
- DTO：`{ homeRegion, isDefault }`。`isDefault` 只表示"该用户还没有 `user_preferences` 记录"（由是否存在记录推导，无数据库字段）：无记录 → `{ "CN", true }`；有记录且为 `CN` → `{ "CN", false }`；有记录且为其他地区 → `false`。前端只在 `isDefault` 为 `true` 时显示"默认"标签。
- `GET` 只读：没有记录时返回默认值，**不会**为此写入默认行。
- `PATCH` → 200，返回保存后读取的当前设置（并发时可能已是稍后提交的另一请求的值）。"相同值"指与当前生效值相同（有记录时为记录值，无记录时为 `CN`）：不写入、不改 `updated_at`、不记审计，直接返回当前设置；因此无记录时保存 `CN` 不创建记录，`isDefault` 仍为 `true`。首次保存其他值创建记录，之后更新同一行（保留 `created_at`，更新 `updated_at`）；改回 `CN` 仍保存为一行（`isDefault: false`），不删除记录。
- 并发与审计（M2-B2.3 复审修订）：`PATCH` 是**一个** `db.batch()`（libSQL 与 D1 上均为单个事务；D1 不支持交互式事务），含两条条件写入，二者都在事务内读取当前值，路由不预先读取旧值：
  1. `INSERT INTO audit_log … SELECT … FROM users LEFT JOIN user_preferences WHERE users.id = 当前用户 AND coalesce(home_region, 'CN') <> 新值`：`detail = { from: 事务内的当前生效值, to: 新值, created: 是否尚无记录 }`；
  2. `INSERT INTO user_preferences … SELECT …`（同一条件）`ON CONFLICT(user_id) DO UPDATE`：无记录时创建，有记录时更新。
  写入在 SQLite 与 D1 上都是串行的：并发请求按提交顺序依次生效（后提交者覆盖先提交者），每条审计的 `from` 恰为该次实际替换的值，审计记录首尾相接、最后一条的 `to` 等于数据库中的值；同时保存同一值只产生一次变化与一条审计；同时首次保存只有一条 `created: true`。任一条语句失败 → 整个 batch 回滚（状态与审计都不写入），返回 500；服务端不自动重试。由于写入以当前值为条件，客户端重试是安全的（已生效则成为无变化的相同值保存）。不使用乐观锁或 409（个人设置采用"最后提交者生效"）。数据库约束（CHECK、外键、主键）全部保留，未新增迁移。
- `homeRegion` 只接受 `@xui/ledger-shared` 的 ISO 3166-1 alpha-2 清单（`COUNTRY_CODES`，249 个正式代码；HK、MO、TW 为独立代码）：小写、三位代码、`XK` 等用户自定义代码、保留代码 `UK` → 400 `VALIDATION`，不写入任何数据。数据库 `CHECK(home_region GLOB '[A-Z][A-Z]')` 为最后防线。
- 不使用全局 `settings` 表。值实际改变时记审计 `preferences.home_region`，`detail = { from, to, created }`（两个地区代码与是否为首次创建）；值未变不记录。
- 认证、Origin、CSRF 沿用 M1：未登录 401，`PATCH` 缺 `x-xui-csrf` 或 Origin 不在白名单 → 403。
- 历史：本接口不触及任何流水。M3 在保存流水时把当时的 `home_region` 复制进 Event（快照），之后的修改不改变已有快照，历史交易也不按当前 `home_region` 重新判断（DATA_MODEL §8.3）。

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
实现说明（M2-B2.1）：
- 列表直接返回数组，按 `sort`、`name_key` 排序；`q` 按名称规范化值做子串匹配（`%`、`_` 按字面）；查询参数同样严格校验（未知参数 → 400）。引用计数包含所有状态（已关闭账户仍算引用）。
- `POST` → 201 + 机构 DTO；`PATCH` 空请求体 → 400；`DELETE` → 200 `{ ok: true }`，审计 `institution.delete` 只记 `{ id }`。
- 重名：同一用户下 `name_key` + 国家（空国家视为同一值）相同 → 409 `DUPLICATE` `{ existingId }`，已归档的机构同样参与判断；`PATCH` 改名或改国家同样检查。唯一索引是最后防线：并发冲突同样返回 409。
- `IN_USE`：`details.references = { accounts, cards, channels }`；检查与删除之间新增的引用由 NO ACTION 外键拒绝，同样返回 409。
- 敏感扫描字段：`name`、`notes`、`website`；`details.fields = [{ field, kind }]`，不回显命中的文本。

### 3.3 账户

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/accounts?q=&institutionId=&type=&country=&currency=&status=&cardId=` | 列表；每项含币种、`linkedCardCount` 与前 3 张卡摘要 |
| POST | `/accounts` | 账户 + 币种在一个 batch 中创建 |
| GET | `/accounts/:id` | 详情：币种、关联（含已结束，标记 `status`）、作为余额账户或来源的支付渠道 |
| PATCH | `/accounts/:id` | 部分更新（不含币种）；**不接受 `institutionId`**（400 `VALIDATION`，开户法律实体变化时新建账户）；修改 `accountCountry` 不影响历史流水（M3 快照） |
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

实现说明（M2-B2.2）：
- `institutionId` 必须是当前用户的机构，否则 404 `NOT_FOUND`（他人的或不存在的机构同样处理，无论其状态，不泄露存在性；复合外键是最后防线）。
- 新建账户只能使用 `active` 机构：已归档 → 409 `INSTITUTION_ARCHIVED`（`details.institutionId`），需先恢复机构。已归档机构的现有账户照常可查看、修改、管理币种。竞争保护：账户行以 `INSERT … SELECT … FROM institutions WHERE id、user_id 匹配且 status = 'active'` 写入，与币种在同一 batch 中；若机构在检查之后被归档或删除，该语句写入 0 行，随后的币种 INSERT 因 `(account_id, user_id)` 外键失败而整体回滚，API 重新读取机构状态后返回 409 或 404。不需要修改数据库结构（0001 不变）。
- `POST` → 201 + 账户 DTO（含 `institution` 摘要与 `currencies`）；账户与每个币种各一条 INSERT，放在同一个 `db.batch()` 中（D1 单条语句最多 100 个绑定参数，30 个币种合并为一条会超限），任一失败整体回滚。币种 `sort` = 列表中的位置。
- 列表直接返回数组，按 `sort`、`name_key` 排序；`status` 缺省返回未关闭的账户（正常与冻结），`all` 返回全部；`q` 按规范化值匹配账户名称、机构名称或账号尾号（`%`、`_` 按字面）；`currency` 匹配持有该币种的账户（含已关闭的币种）；`cardId` 只匹配未结束的关联；`linkedCardCount` 为未结束关联的不同银行卡数，`linkedCards` 为按卡片排序的前 3 张。查询参数严格校验。
- 币种 DTO 带 `status`；前端在列表中先显示有效币种，再以「已关闭」标签分隔显示已关闭币种，详情页分「有效币种」「已关闭币种」两节。
- `GET /accounts/:id` 的 `links` 含全部状态（含 `ended`）；`balanceOfChannels` 为以其为余额账户的渠道；`sourceOfChannels` 为以其为有效（`active`）来源的渠道。
- `PATCH` 经服务层 `accountPatchValues`：空请求体、`institutionId` 等未知字段 → 400 `VALIDATION`；与已存值合并后再检查 `depositKind` 仅限 `bank`、`closedOn ≥ openedOn`（400 `VALIDATION`）；被渠道用作余额账户时改为 `bank` / `other` → 400 `BALANCE_ACCOUNT_KIND`（`details.channels`，触发器为最后防线）。状态在 `active`、`frozen`、`closed` 之间任意切换，不修改币种与关联。
- `PUT /currencies`：与已存币种比对，batch 顺序为"清除旧默认 → 删除移除的币种 → 逐个更新或插入（新的默认、状态、`sort`）→ 更新 `updated_at`"，任何时刻不会出现两个默认；保留的币种保留 `created_at`。被关联（任何状态，包括 `ended`）引用的币种不能移除 → 409 `CURRENCY_IN_USE`，`details.currencies` 列出这些币种；检查与 batch 之间新增的引用由 NO ACTION 外键拒绝，同样返回 409 且不做任何修改。改为 `closed` 不受影响，关联保留。
- `DELETE` → 200 `{ ok: true }`，审计 `account.delete` 只记 `{ id }`；被渠道用作余额账户 → 409 `IN_USE`，`details = { references: { balanceOfChannels }, channels: [渠道摘要] }`。
- 敏感扫描字段：`name`、`notes`、`numberHint`。

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

实现说明（M2-B3）：
- 已实现 `GET /cards`、`POST /cards`、`GET /cards/:id`、`PATCH /cards/:id`、`DELETE /cards/:id`。`GET /cards/:id/spending-source`（§3.4.1）依赖关联，已在 M2-B4 随关联实现。未新增迁移，`0000`、`0001` 不变。
- 列表直接返回数组，按 `sort`、`name` 排序；`status` 缺省返回未停用的卡（`active`、`frozen`），`all` 返回全部；`q` 先做与 `name_key` 相同的规范化（NFKC → trim → 合并空白 → 小写），匹配卡片名称、发卡机构名称或后四位（`cards` 表没有 `name_key` 列，比较在服务端进行，`%`、`_` 按字面）；`issuerId` 按发卡机构；`accountId` 只匹配未结束的关联；`linkedAccounts` 为未结束关联的不同账户（含账户的 `accountCountry`）。查询参数严格校验（未知参数 → 400）。
- **到期**（规则在 `@xui/ledger-shared` 的 `expiry.ts`，API 与前端共用同一函数）：
  - `expires_on`（`YYYY-MM`）表示卡片**有效至该月最后一天（含当天）**，闰年 2 月为 29 日；`daysLeft` = 该日 − `today`（整日数，按日历日期计算，与运行环境时区无关）。
  - 分类：`none`（未填有效期）、`expired`（`daysLeft < 0`，即到期月份的次月 1 日起）、`expiring`（`0 ≤ daysLeft ≤ 阈值`）、`valid`（`daysLeft > 阈值`）。原规格未规定"即将到期"阈值，M2-B3 取默认 **60 天**（`DEFAULT_EXPIRING_WITHIN_DAYS`）。
  - `expiringWithinDays=N`（规格原有，0–3650）单独使用 = 尚未过期且 `N` 天内到期；`expiry=none|valid|expiring|expired`（M2-B3 新增）按分类筛选，阈值为 `expiringWithinDays`（若给出）或默认 60 天。
  - `today=YYYY-MM-DD`（M2-B3 新增）：调用方的日历日期。Web 端发送用户本地日期，因此列表筛选与页面标签使用同一天，不因客户端与服务端时区不同而矛盾；只接受与服务器 UTC 日期相差不超过 1 天的值（覆盖 UTC−12 至 UTC+14），否则 400 `VALIDATION`；缺省为服务器的 UTC 日期。
  - 到期是读取时推导的，不写入数据库，**不改变 `status`**：已过期 ≠ 停用（`closed`），冻结/停用只由用户操作。
- `POST` → 201 `{ card }`；带 `createStoredValueAccount` 时 `{ card, account, link }`。发卡机构须为当前用户的有效机构：他人的或不存在 → 404（不泄露状态），已归档 → 409 `INSTITUTION_ARCHIVED`（`details.institutionId`）。与新建账户相同，卡片行以 `INSERT … SELECT … FROM institutions WHERE … status = 'active'` 写入，检查之后被归档的机构不会写入任何行（返回 409）。储值账户的 `institutionId` 缺省为发卡机构，同样须为有效机构；`accountCountry` 必填；卡 → 账户（`stored_value`、`active`）→ 唯一默认币种 → 关联（`spending_source`、`currency = null`、`is_default = 1`）→ 审计记录，五条语句在一个 `db.batch()` 中（libSQL 与 D1 上均为单个事务），任一失败（含审计写入失败）全部回滚，不留下任何部分记录（M2-B3 复审：在 libSQL 与 D1 上对卡、账户、币种、关联、审计逐一注入失败验证）。
  - **重试语义**：`POST /cards` 不是幂等的，没有幂等键。失败（4xx / 5xx）的请求不留下任何记录，重试是安全的；若事务已提交但客户端没有收到响应，重发同一请求会**再创建一套完整的卡（及储值账户、币种、关联、审计）**，不会产生孤立记录，但会出现重复，需要用户删除多余的一张（M2-B3 未增加幂等键或数据库结构，需另行批准）。
- `PATCH`：部分更新；空请求体、未知字段（`userId`、`id`、`createdAt`、`pan` 等）→ 400 `VALIDATION`；`cardType` 非 `debit` / `prepaid` → 400 `CARD_TYPE_UNSUPPORTED`。`issuerInstitutionId` 可修改（共享 Schema 允许，用于纠正误选的发卡机构）：新机构须为当前用户的有效机构（404 / 409），并在 `UPDATE` 条件内复核（`EXISTS … status = 'active'`，预检查之后被归档 → 409、被删除 → 404，卡片所有字段不变；libSQL 与 D1 均验证）；保持原机构（即使已归档）不检查状态。状态在 `active`、`frozen`、`closed` 之间任意切换，不修改关联及其默认标记。卡片被并发删除 → 404。
- `DELETE` → 200 `{ ok: true }`：级联删除该卡的关联（含已结束）与渠道来源，不删除账户、币种或渠道；不存在、属于他人或已被并发请求删除 → 404（`DELETE … RETURNING` 判断）；审计 `card.delete` 记 `{ id, last4 }`，与删除在同一个 batch 中（审计从卡片行读取，卡片已不存在则不写；删除被拒绝或审计写入失败则一起回滚）。M3 起被流水引用 → 409 `IN_USE`（NO ACTION 外键）。`GET /cards/:id` 另返回 `channelSourceCounts: { active, ended }`（M2-B3 新增，渠道来源记录按状态计数），供删除确认使用。前端删除确认按类别列出将被删除的记录数量（账户关联：有效 / 暂停 / 已结束；渠道来源：有效 / 已结束）及不会删除的内容；有引用时"改为停用"为主操作，删除须输入后四位——仅用于防止误操作，不是身份验证。
- 敏感扫描字段：`name`、`notes`、`createStoredValueAccount.name`（`details.fields = [{ field, kind }]`，不回显文本）。`last4` 严格为 4 个 ASCII 数字（全角数字、空格、完整卡号 → 400，校验错误不回显输入值）。
- 审计：`card.create` 记 `{ id, last4 }`（同时创建储值账户时另含 `accountId`、`linkId`），`card.delete` 记 `{ id, last4 }`；不记录名称、备注或请求体。两者都以 `INSERT INTO audit_log … SELECT … FROM cards WHERE id = … AND user_id = …` 写在卡片写入的同一个 batch 中：审计记录存在当且仅当对应的创建 / 删除已提交，不会出现"报告了已回滚的操作"或"操作已提交但无审计"。
- 地区：`issuingCountry` 必填，不从发卡机构国家推断，修改机构国家不影响卡片；卡片详情分别展示发卡机构所在地、发卡国家/地区与关联账户的 `accountCountry`。DTO 无卡片颜色字段（DATA_MODEL 无此列），卡面颜色取发卡机构的头像颜色。

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

实现说明（M2-B4）：
- 只读：卡片、其未结束的关联、这些关联的账户与账户币种在一个 `db.batch()` 中读取（同一快照）。batch 内不使用联表查询：drizzle 在 D1 的 batch 中按列名映射结果，联表的同名列（`id`、`status`）会互相覆盖。查询参数严格校验（`currency` 以外的参数 → 400）。
- 排序：在 DATA_MODEL §5 的 `rank` 末尾增加 `id ASC`，同一毫秒创建的关联也有确定的顺序（结果稳定）。
- 到期不影响推荐：只检查卡片的 `status`（M2-B3：已过期 ≠ 停用；推荐没有日期参数，M3 可能补录到期之前的交易）。已过期但状态为 `active` 的卡照常推荐，页面另以到期标签提示。
- 解释（M2-B4 新增字段，规格原有字段不变）：三种结果都带 `considered`——该卡全部**未结束**关联的判断过程，按决策顺序排列：持有消费币种的合格关联（按 rank）→ 其余合格关联（按 rank）→ 不合格关联（按 rank）；有推荐时 `considered[0]` 就是推荐项。每项 `{ linkId, account（账户摘要）, currency, role, status, isDefault, priority, scope, skipped, exact }`：`scope` 为该关联可用的 active 币种（账户默认币种在前，其余按 `sort`）；`skipped` 为 `null`（合格）或第一个不满足的条件 `not_spending_source` / `link_suspended` / `account_inactive` / `currency_closed`；`exact` 表示合格且 `scope` 含消费币种。`card_inactive` 时 `considered` 为空数组。供 M3 由用户确认或纠正；不含任何金额、汇率或余额。
- 隔离：卡片、关联、账户、币种四个读取都以当前用户限定；`considered` 只描述当前用户自己的关联与账户（账户摘要仅 `id`、`name`、`accountCountry`、`status`）。复合外键使跨用户关联无法写入；即使绕过外键存在这样的行，也会被排除（不返回 500，不出现他人资料）。他人的或不存在的卡 → 404 `{ error, code }`，不带任何解释字段（libSQL 上以关闭外键强行写入跨用户行验证；D1 无法关闭外键）。

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

实现说明（M2-B4）：
- 已实现本节全部五个接口（以及 §3.4.1）。未新增迁移，`0000`、`0001` 不变：复用 `account_card_links` 表及其 CHECK、两个部分唯一索引与三条复合外键。DTO 另含 `createdAt`、`updatedAt`。
- 查询：没有单独的关联列表接口；`GET /cards/:id` 与 `GET /accounts/:id` 的 `links` 列出全部关联（含 `ended`，以 `status` 区分），按 `created_at`、`id` 排序；列表摘要（`linkedAccounts`、`linkedCards`）与 `cardId` / `accountId` 筛选只看未结束的关联。
- 多对多：一张卡可同时有多条关联（不同账户、币种范围、用途），一个账户可关联多张卡；同一组 `(卡, 账户, 币种范围, 用途)` 只能有一条未结束（`active` 或 `suspended`）的关联 → 409 `DUPLICATE`，`details.existingId` 为那一条；结束后可重新建立，历史记录保留。
- `POST` → 201 + 关联 DTO。`cardId`、`accountId` 不是当前用户的（或不存在）→ 404——即使另一用户恰好有相同的关联，也是 404 而不是 409（先确认归属再报告重复）。`currency` 非空时须为该账户的 active 币种，否则 400 `CURRENCY_NOT_ON_ACCOUNT`（`null` = 账户全部币种）。`role` 缺省 `spending_source`；`isDefault` 仅限 `spending_source`（400 `VALIDATION`）；新关联恒为 `active`（请求体不接受 `status`、`endedOn`）；`startedOn` 可空，不推断。允许为已冻结 / 已关闭的卡或账户建立关联（记录历史），但它们在恢复有效之前不会被推荐。
- `PATCH`：可改 `role`、`priority`（`null` 清除）、`notes`、`status`（`active` ⇄ `suspended`）。空请求体以及 `currency`、`cardId`、`accountId`、`isDefault`、`status: "ended"`、`endedOn` 等字段 → 400 `VALIDATION`：卡、账户与币种范围建立后不可修改（需要时解除关联、保留历史，再新建），默认标记只经 `/default` 设置。暂停时清除 `is_default`；把 `role` 改为非 `spending_source` 时同样清除（M2-B4 补充：规格未写明，与 CHECK `is_default = 0 OR role = 'spending_source'` 一致）；恢复为 `active` 或改回 `spending_source` 都不自动恢复默认。改 `role` 后与另一条未结束关联重复 → 409 `DUPLICATE`。没有"取消默认"接口（规格未定义）：默认只能被同范围的新默认替换，或随暂停 / 结束 / 改用途清除。
- 已结束（`ended`）的关联只能修改 `notes`；修改 `role`、`priority`、`status`，设为默认或再次结束 → 409 `LINK_STATE`（`details.status = "ended"`）。暂停的关联设为默认 → 409 `LINK_STATE`（`"suspended"`）；非 `spending_source` 设为默认 → 400 `VALIDATION`（L-6）。
- `POST /default`：请求体为空或 `{}`。已是默认 → 200，不写入。否则一个 batch：先清除同卡同币种范围（`ifnull(currency, '')`）的旧默认，再设置新默认；两条语句都以"目标仍是该用户 active 的 `spending_source`"为条件（事务内判断）——目标在读取之后被暂停、结束、改用途或删除时两条都不生效，旧默认保留，返回 409 / 400 / 404。"所有币种"与某一币种（如 `USD`）是不同的范围，各自至多一个默认。并发设默认依提交顺序生效，任何时刻至多一个默认（部分唯一索引为最后防线）。
- `POST /end`：`{ endedOn? }`，缺省为服务器 UTC 日期（Web 端发送用户本地日期）；须为真实日期，不早于 `startedOn`（同日结束允许；`startedOn` 为空时不比较），不晚于服务器 UTC 日期的次日（时区），否则 400 `VALIDATION`，不写入任何数据。这两条日期检查只在 API 中（数据库只有 `CHECK(ended_on IS NULL OR status = 'ended')`）。状态 → `ended`，记录 `ended_on`，清除默认。审计与更新都以"尚未结束"为条件：重复或并发结束只有一次生效（其余 409 `LINK_STATE`），只有一条审计。
- `DELETE` → 200 `{ ok: true }`，任何状态均可删除（仅用于纠正误录，不保留历史），不影响卡、账户与币种；不存在、属于他人或已被删除 → 404。
- 原子性与并发：创建（关联 → 可选的"清除旧默认 + 设置新默认" → 审计）、设默认（清除 + 设置）、结束（审计 + 更新）、删除（审计 + 删除）各为一个 `db.batch()`（libSQL 与 D1 上均为单个事务；D1 不支持交互式事务）。每条规则只在写入语句自身中执行一次——复合外键（归属）、未结束关联唯一索引（重复）、`INSERT … SELECT` 自该账户的 active 币种（币种范围）、`UPDATE … WHERE` 关联状态与用途（生命周期、默认）——没有可被并发请求绕过的预检查；写入被拒绝或未生效时，路由重新读取以给出原因（404 / 400 / 409）。在 libSQL 与本地 D1 上逐一注入失败（关联写入、审计写入、设置新默认、结束更新、删除）验证整体回滚、旧默认保留。
- 审计：`card_link.create`、`card_link.end`、`card_link.delete`，`detail = { id, cardId, accountId }`（只有 id），以 `INSERT INTO audit_log … SELECT … FROM account_card_links …` 写在同一 batch 中，条件与变更相同：审计存在当且仅当该变更已提交。设默认、暂停 / 恢复、修改用途或备注不记审计（§3.7 未列出）。
- 敏感扫描字段：`notes`（`details.fields`，不回显文本）。
- 状态与删除：账户、账户币种、银行卡的冻结 / 关闭不修改关联（状态、默认标记不变，详情中照常可见），只是不再被推荐，恢复后重新可被推荐；删除卡或账户级联删除其关联；被关联（含已结束的）引用的账户币种不能移除（409 `CURRENCY_IN_USE`），只能关闭；归档机构不影响关联。

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

实现说明（M2-B5）：
- 已实现本节全部九个接口。未新增迁移，`0000`、`0001` 不变：复用 `payment_channels`、`payment_channel_sources` 两张表及其 CHECK（渠道类型、余额账户仅限 `payment_service`、来源 XOR、默认仅限 `active`）、部分唯一索引（余额账户唯一、每个来源一条有效记录、每个渠道一个默认来源）、`UNIQUE(user_id, name_key)`、三个 `BALANCE_ACCOUNT_KIND` 触发器与五条复合外键。`@xui/ledger-shared` 只新增了列表查询 schema（`paymentChannelListQuerySchema`、`CHANNEL_STATUS_FILTERS`），DTO 不变。
- 列表直接返回数组，按 `sort`、`name_key` 排序；`status` 缺省返回未归档的渠道，`all` 返回全部；`type` 按渠道类型；`q` 按规范化值匹配渠道名称或服务机构名称（`%`、`_` 按字面）；查询参数严格校验（未知参数 → 400）。`sourceCount` 为**有效（`active`）**来源数；`provider`、`balanceAccount` 为摘要（未指定时为 `null`）。
- `POST` → 201 + 渠道 DTO；`PATCH` 部分更新（空请求体、`id`、`userId`、`createdAt` 等未知字段 → 400）。名称按 `name_key` 在本人范围内唯一（含已归档的渠道）→ 409 `DUPLICATE`，`details.existingId` 为本人的那个渠道。
- 余额账户：`balanceAccountId` 出现在非 `payment_service` 渠道上 → 400 `BALANCE_ACCOUNT_KIND`（§1.1；共享 schema 的规则以该错误码报告，`PATCH` 与已存值合并后再检查，改类型而不解除余额账户同样被拒绝；`CHECK` 为最后防线）；账户类型不是 `e_money` / `stored_value` → 400 `BALANCE_ACCOUNT_KIND`（触发器判定）；已是另一渠道的余额账户 → 409 `DUPLICATE`，`details.existingId` 为占用它的渠道；他人的或不存在的账户 → 404。`payment_channels_balance_account_uq` 不含 `user_id`：写入失败时**先确认所引用的账户与机构属于当前用户（否则 404），再报告重复**，另一用户正在使用的账户与不存在的账户返回完全相同的 404，不会以 409 暴露。余额账户的状态（冻结、关闭）不限制（规格未定义），摘要显示其状态。`balanceAccountId: null` 解除余额账户，之后该账户可被其他渠道使用或删除。
- 服务机构（可选）：须为当前用户的机构（否则 404）；**新指定**（创建或更换）的机构须为有效机构，已归档 → 409 `INSTITUTION_ARCHIVED`（规格未定义，沿用账户与银行卡的做法）；保留原有的已归档机构不检查。创建以 `INSERT … SELECT … FROM institutions WHERE … status = 'active'` 写入，更换以 `UPDATE … WHERE EXISTS (… status = 'active')` 写入，检查之后被归档或删除的机构不会被写入（409 / 404，渠道不变）。
- 改为 `device_wallet`：渠道仍有账户来源 → 400 `CHANNEL_SOURCE_KIND`，`details = { accountSources, activeAccountSources, endedAccountSources }`；条件写在 `UPDATE … WHERE NOT EXISTS (…)` 中，与并发添加账户来源互斥。**只有已结束的账户来源同样拒绝**：它们是该渠道的历史（曾由哪个账户出资），不能通过修改渠道类型改变其含义；错误信息与前端提示建议新建设备钱包渠道并归档此渠道，**从不建议删除历史来源**（删除仅用于纠正误录）。拒绝时渠道、来源与审计均不变。所有现存来源都是银行卡（含已结束的）时允许修改；改为 `payment_service` 或 `other` 不受账户来源影响。不新增类型快照或数据库结构。
- 归档：只改变渠道状态并在默认列表中隐藏，**不修改、不删除任何来源**；已归档的渠道照常可查看、编辑、管理来源（规格未定义限制，未新增错误码）。
- `GET /:id` 的 `sources` 含全部来源（`active` 与 `ended`），按 `created_at`、`id` 排序，每项带银行卡或账户摘要；前端分「当前来源」「历史来源」两节。只描述引用当前用户自己的银行卡或账户的来源（复合外键使其他情况无法写入；即使绕过外键存在这样的行也不返回）。
- `DELETE /payment-channels/:id` → 200 `{ ok: true }`：一个 batch，审计 `channel.delete`（`detail = { id }`，以 `INSERT … SELECT … FROM payment_channels` 读取，只在渠道存在时写入）→ 删除（级联删除其全部来源，含已结束的）；银行卡、账户、余额账户与机构不受影响；不存在、属于他人或已被并发删除 → 404 且不写审计。删除被拒绝或审计写入失败则整体回滚。M3 起被流水引用 → 409 `IN_USE`。
- `POST /payment-channels/:id/sources`：请求体 `{ cardId }` 或 `{ accountId }`（恰好一个，否则 400），可带 `isDefault`、`notes`；→ 201 + 来源 DTO（新来源恒为 `active`）。来源行以 `INSERT … SELECT … FROM payment_channels WHERE id、user_id 匹配[且（账户来源时）channel_type <> 'device_wallet']` 写入：渠道不存在、属于他人、或在检查之后被删除 → 404；渠道是（或刚被改为）设备钱包而来源是账户 → 400 `CHANNEL_SOURCE_KIND`。他人的或不存在的银行卡 / 账户（含检查后被删除）→ 复合外键拒绝 → 404。同一来源已有有效记录 → 409 `DUPLICATE`（`details.existingId`），同样先确认渠道、银行卡与账户的归属。已结束的来源可以重新添加（新记录，历史保留）。允许把冻结 / 关闭的银行卡或账户记录为来源（与 M2-B4 关联一致）。`isDefault: true` 时同一 batch 中先清除该渠道的旧默认、再设置新来源为默认。
- `PATCH /payment-channel-sources/:id`：`{ isDefault?, notes? }`（空请求体与其他字段 → 400）。`isDefault: true`：一个 batch，先清除同渠道的旧默认、再设置本来源（并同时写入 `notes`），两条语句都以"本来源仍是该用户的 `active` 来源"为条件——来源在读取之后被结束或删除时两条都不生效，旧默认保留，返回 409 `LINK_STATE`（`details.status = "ended"`）/ 404。`isDefault: false` 清除默认标记（任何状态）。规格未定义"已结束"后的恢复，故不提供。已结束的来源只能改 `notes`（及 `isDefault: false`）。
- `POST /payment-channel-sources/:id/end`：请求体为空或 `{}`（来源表没有结束日期列）。状态 → `ended`，同时清除默认；以"仍为 `active`"为条件，重复或并发结束只有一次生效，其余 409 `LINK_STATE`。结束后渠道可能没有默认来源（规格允许）。
- `DELETE /payment-channel-sources/:id` → 200 `{ ok: true }`，任何状态均可删除（仅用于纠正误录），不影响银行卡与账户；不存在、属于他人或已删除 → 404。
- 审计：只记 `channel.delete`（§3.7）；来源的添加、默认切换、结束、删除与渠道的创建、修改、归档不记审计（§3.7 未列出）。
- 原子性与并发：所有多语句写入（来源创建 + 设默认、设默认的清除 + 设置、渠道删除的审计 + 删除）各为一个 `db.batch()`（libSQL 与 D1 上均为单个事务），单语句写入也经 batch 执行；每条规则只在写入语句自身中执行（复合外键、触发器、唯一索引、CHECK、`INSERT … SELECT`、`UPDATE … WHERE`），写入未生效或被拒绝时路由重新读取以给出原因。在 libSQL 与本地 D1 上逐一注入失败（来源写入、设置新默认、结束、删除、审计写入、渠道删除、级联删除来源）验证整体回滚、旧默认保留。
- 敏感扫描字段：渠道的 `name`、`notes`，来源的 `notes`（`details.fields`，不回显文本）。
- 历史：来源只描述渠道背后的银行卡或账户，不是扣款记录；M3 流水保存当时实际使用的银行卡、渠道与资金账户，不依据当前来源或默认标记重新解释（DATA_MODEL §8.3）。

### 3.7 审计

M2 记录以下审计动作（detail 只含 id 与后四位——`card_link.*` 为 `{ id, cardId, accountId }`，`channel.delete` 为 `{ id }`；`preferences.home_region` 只含修改前后的两个地区代码与是否首次创建 `{ from, to, created }`）：`institution.delete`、`account.delete`、`card.create`、`card.delete`、`card_link.create`、`card_link.end`、`card_link.delete`、`channel.delete`、`preferences.home_region`。

审计记录的保留与内容限制见 DATA_MODEL §6.1：删除用户不删除其审计记录，记录中不得出现任何凭证。

## 4. 不在 M2 的接口
- 查看卡号（`/cards/:id/reveal`）—— 不保存 PAN，因此不存在。
- BIN 查询 —— 不存储；如未来需要，只在浏览器端临时查询。
- 任何余额、金额、汇总接口 —— M3 起再定义（且不做换算合计）。
