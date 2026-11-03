# X-UI Product v1 — 测试计划（TEST_PLAN）

> 状态：§1 为 M1 已有测试；**§2 起为 M2 测试设计（M2-A 修订版）；§3.12 的数据库用例、R-2、R-3、R-5、A-12（schema 与服务层）、H-3（数据库层）、D-3 已在 M2-B1 实现**，API 用例尚未实现；**M2-B2.1 已实现机构 API 用例（`institutions.test.ts`：I-1 – I-5、X-1 – X-4、U-1 – U-3 中与机构相关部分、R-1）、敏感扫描单元测试（`sensitive.test.ts`）与机构浏览器测试（`e2e-v1/institutions.spec.ts`）；M2-B2.2 已实现账户 API 用例（`accounts.test.ts`：A-1 – A-12、D-1、D-2（账户币种部分）、D-4、D-7 以及 X-1 – X-4、U-1 – U-3、R-1 中与账户相关部分）、新建账户须为有效机构（已归档 → 409、恢复后成功、他人机构恒为 404、归档与创建竞争）、替换币种在中间步骤失败时完整回滚（币种集合、默认 USD、`updated_at`、关联均不变），后两类在 libSQL 与本地 D1（`accounts-d1.test.ts`）均验证与账户浏览器测试（`e2e-v1/accounts.spec.ts`，独立测试用户）**。
> 相关文档：[PRODUCT_SPEC.md](PRODUCT_SPEC.md) · [DATA_MODEL.md](DATA_MODEL.md) · [API_SPEC.md](API_SPEC.md)

## 0. 运行方式与准入标准

| 命令 | 内容 |
|---|---|
| `npm run test:v1` | v1 测试（`apps/ledger-api/test/**`） |
| `npm test` | 旧版测试（必须保持全部通过） |
| `npm run typecheck:v1` / `lint:v1` / `build:v1` | v1 类型检查、lint、构建 |
| `npm run test:e2e:v1` | v1 浏览器测试（`e2e-v1/`，生产构建 + `data/e2e-v1/` 临时数据库，端口 8798，与旧版 e2e 互不影响） |

M2-B 完成标准：
- v1 测试、旧版测试、旧版与 v1 的 typecheck/lint/build 全部通过；
- 关键约束做变异验证（临时移除约束，确认对应测试失败）；
- §3.12 的约束用例在本地 SQLite（libsql）与本地 D1（workerd）两个环境中都通过；不连接远程 D1；
- 浏览器冒烟测试通过；
- 旧版数据库与 `.env` 指纹不变。

## 1. M1 已有测试（保持通过）

| 文件 | 覆盖 |
|---|---|
| `identity.test.ts` | 首次初始化、重复启动不重复迁移、中断恢复、拒绝旧版/未知/标记错误数据库、路径守卫、0000 迁移标记 |
| `env.test.ts` | 只读 `XUI_V1_*`、`.env.v1` 生成与保护、IP Origin 拒绝 |
| `auth.test.ts` | 路由鉴权、CSRF、Cookie、登录与锁定、恢复码、首次初始化、step-up、Passkey RP |
| `isolation.test.ts` | 新旧应用 Cookie/CSRF 互不接受、v1 写入不进入旧库、源码不引用旧应用、存储键前缀 |

## 2. 测试工具（M2 新增）

- 夹具 `seedM2(t)`：在测试数据库中创建机构、账户（多币种）、借记卡、预付卡、支付渠道，返回 id。
- `asUser(t, name)`：创建第二个用户并登录，用于隔离测试。
- `rawSql(t, sql, args)`：直接对数据库执行 SQL，用于验证数据库层约束（绕过 API）。
- `schemaColumns(t)`：读取 `PRAGMA table_info` 列出所有表的列名。

## 3. M2 测试用例

### 3.1 机构

| ID | 场景 | 断言 |
|---|---|---|
| I-1 | 一个机构拥有多个账户 | 创建 1 个机构 + 3 个账户；机构详情 `accountCount = 3` 且列出 3 个账户 |
| I-2 | 同名检测 | "Wise"、" wise "、"ＷＩＳＥ"（全角）+ 相同国家 → 409 `DUPLICATE` 且 `existingId` 正确；国家不同 → 201 |
| I-3 | 国家为空的重名 | 两个同名且 `country` 为空 → 第二个 409 |
| I-4 | 删除被引用的机构 | 被账户、银行卡、支付渠道分别引用时 → 409 `IN_USE`；归档成功；无引用时删除成功 |
| I-5 | 原始 SQL 删除被引用的机构 | 数据库拒绝（NO ACTION 外键） |

### 3.2 账户与币种

| ID | 场景 | 断言 |
|---|---|---|
| A-1 | 一个账户多个币种 | USD（默认）、EUR、GBP 创建成功；详情返回 3 个币种，默认为 USD |
| A-2 | 币种校验 | 无币种、两个默认、无默认、重复币种、`XAU`、`usd`（小写）→ 400 |
| A-3 | 默认币种唯一（数据库层） | 原始 SQL 为同一账户插入第二个 `is_default = 1` → 唯一约束失败 |
| A-4 | 替换币种 | `PUT /currencies` 增删改正确；移除被关联引用的币种 → 409 `CURRENCY_IN_USE`；改为 `closed` 成功 |
| A-5 | 不要求余额 | 只提交必填字段即创建成功；请求体带 `balance` / `openingBalance` → 400；DTO 中无金额字段；`schemaColumns` 中无 `balance`、`opening_balance`、`balance_date`、`credit_limit`、`include_in_total` |
| A-6 | `institution_id` 必填 | 缺省 → 400；原始 SQL 插入 NULL → NOT NULL 失败 |
| A-7 | `account_country` 独立 | 必填（缺省 → 400）；创建时不从机构国家填充；修改机构国家后账户国家不变；与卡片发行国家无关 |
| A-8 | 账户类型 | `credit`、`investment`、`cash` → 400；原始 SQL 插入 `credit` → CHECK 失败；`depositKind` 仅 `bank` 允许 |
| A-9 | 账号尾号 | `1234`、`AB12` 成功；`12345`、完整 IBAN、带空格或符号 → 400 / CHECK 失败 |
| A-10 | 删除账户 | 级联删除币种、关联、渠道来源；被渠道用作余额账户 → 409 `IN_USE` |
| A-12 | `institution_id` 不可修改 | `PATCH /accounts/:id { institutionId }`（单独或与其他字段一起）→ 400 `VALIDATION`，账户不变；schema 中没有 `institutionId`；服务层 `accountPatchValues` 生成的更新列中没有 `institution_id`；绕过服务层的 ORM 更新与原始 SQL `UPDATE … SET institution_id`（单行、多列、批量、batch）→ 触发器 `ACCOUNT_INSTITUTION_IMMUTABLE` 失败且行不变，更新其他列与设为相同值正常，删除用户的级联清理不受影响（SQLite 与 D1） |
| A-11 | 级联与 NO ACTION 共存 | 删除带币种范围关联的账户成功（语句结束时无残留引用）；删除用户时级联删除其全部 M2 数据成功 |

### 3.3 银行卡

| ID | 场景 | 断言 |
|---|---|---|
| C-1 | 创建借记卡、预付卡 | 成功；实体与虚拟均可 |
| C-2 | 禁止信用卡 | API `cardType: "credit"` → 400 `CARD_TYPE_UNSUPPORTED`；原始 SQL 插入 `credit` → CHECK 失败 |
| C-3 | 禁止敏感字段 | 请求体带 `pan`、`cardNumber`、`bin`、`cvv`、`cvc`、`pin`、`holderName` 中任一 → 400 `VALIDATION`，数据库无新增行 |
| C-4 | 后四位 | `0042` 成功；`42`、`12345`、`abcd` → 400；原始 SQL → CHECK 失败 |
| C-5 | 无卡号列 | `schemaColumns` 中不存在 `pan`、`pan_enc`、`bin`、`bin_info`、`cvv`、`pin`、`holder_name`、`account_id`（cards 表） |
| C-6 | 有效期 | `2028-01`、`2028-07`、`2028-12` 成功；`2028-00`、`2028-13`、`2028-1`、`07/28` → 400；原始 SQL（SQLite 与 D1）对 `2028-00`、`2028-13`、`2028-1` → CHECK 失败；`expiringWithinDays` 筛选正确 |
| C-7 | 预付卡自动建储值账户 | 一次请求创建卡 + `stored_value` 账户 + 默认币种 + `spending_source` 默认关联；`accountCountry` 缺省 → 400 且**卡和账户都未创建**；对借记卡传 `createStoredValueAccount` → 400 |

### 3.4 银行卡-账户关联

| ID | 场景 | 断言 |
|---|---|---|
| L-1 | 一张卡关联多个账户 | 卡关联账户 A（`spending_source`）与账户 B（`top_up_source`）；卡片详情列出两者及用途 |
| L-2 | 一个账户关联多张卡 | 实体卡 + 两张虚拟卡关联同一账户；账户详情列出三张卡 |
| L-3 | 币种范围 | `currency = EUR` 成功；`currency = JPY`（账户无此币种）或已关闭币种 → 400 `CURRENCY_NOT_ON_ACCOUNT` |
| L-4 | 重复关联 | 相同 `(卡, 账户, 币种范围, 用途)` 的第二条未结束关联 → 409；结束后可重新创建 |
| L-5 | 默认唯一 | 同卡同币种范围设第二个默认 → `/default` 原子切换，旧默认被清除；原始 SQL 插入第二个默认 → 唯一约束失败 |
| L-6 | 默认只属于消费来源 | `top_up_source` / `other` 设默认 → 400；原始 SQL → CHECK 失败 |
| L-7 | 预付卡角色 | 储值账户关联为 `spending_source`；充值账户为 `top_up_source` |
| L-8 | 结束关联 | `/end` 后 `status = ended`、`endedOn` 已记录、默认被清除；详情的历史区可见；`ended` 不能再改状态 |
| L-9 | 暂停关联 | `suspended` 清除默认；恢复为 `active` 不自动恢复默认 |
| L-10 | 删除关联 | `DELETE` 后记录消失，卡与账户不受影响 |
| L-11 | 账户/卡状态变化不改关联 | 冻结账户后关联状态与默认标记不变 |

### 3.5 默认消费来源推荐（`GET /cards/:id/spending-source`）

夹具：Wise 机构 + Wise 多币种账户 W + Wise 借记卡 K，一条 `currency = null` 的默认 `spending_source` 关联 K→W；另有账户 B。

| ID | 场景 | 期望 |
|---|---|---|
| S-1 | 精确匹配 | W 有效币种 USD、EUR、GBP；`?currency=USD` → `exact_currency`，`accountId = W`，`fundingCurrency = USD` |
| S-2 | 需要换汇（Wise USD 消费从 HKD 扣款） | W 有效币种 HKD（默认）、EUR；`?currency=USD` → `conversion_required`，`accountId = W`，`eventCurrency = USD`，**`fundingCurrency = null`**，`candidateCurrencies = [HKD, EUR]` |
| S-3 | 不把默认币种当消费币种 | S-2 的响应中 `fundingCurrency` 不等于 `HKD`，`eventCurrency` 不等于 `HKD`；遍历多个非持有币种（JPY、SGD），`fundingCurrency` 恒为 `null` |
| S-4 | 无合格来源 | 卡只有 `top_up_source` 关联 → `no_match`，`reason = no_eligible_link` |
| S-5 | 银行卡状态 | K 为 `frozen` 或 `closed` → `no_match`，`reason = card_inactive`（即使关联、账户、币种都有效） |
| S-6 | 关联状态 | 默认关联为 `suspended` 或 `ended` → 不推荐它；有其他合格关联时返回下一个，否则 `no_match` |
| S-7 | 账户状态 | W 为 `frozen` 或 `closed` → 不推荐 W；B 合格时返回 B |
| S-8 | 币种状态（币种专属关联） | 关联 `currency = USD`，但 W 的 USD 已 `closed` → 该关联不合格 |
| S-9 | 币种状态（所有币种关联） | W 的 USD 已 `closed`，仍有 EUR → `?currency=USD` 变为 `conversion_required`，候选不含 USD |
| S-10 | 币种一致优先于默认 | K→W 默认（W 无 USD）+ K→B 非默认（B 有 USD）→ `?currency=USD` → `exact_currency`，`accountId = B` |
| S-11 | 币种专属默认优先 | K→W 默认（所有币种，含 GBP）+ K→B 默认（`currency = GBP`）→ `?currency=GBP` → B；`?currency=EUR` → W |
| S-12 | 优先级 | 两条非默认、均精确匹配，priority 2 与 1 → 返回 priority 1；priority 为空排最后 |
| S-13 | 只读与参数 | 调用前后数据库内容一致；`currency` 缺省、小写、非 ISO → 400；他人的卡 → 404 |

### 3.6 支付渠道

| ID | 场景 | 断言 |
|---|---|---|
| P-1 | 渠道类型 | `device_wallet`、`payment_service`、`other` 成功；`bank_transfer` → 400；原始 SQL 插入 `bank_transfer` → CHECK 失败 |
| P-2 | 余额账户 | 仅 `payment_service` 可设；账户类型须为 `e_money` / `stored_value`（API 400 `BALANCE_ACCOUNT_KIND`；原始 SQL 的 INSERT、UPDATE 渠道以及把余额账户改为其他类型 → 触发器 `BALANCE_ACCOUNT_KIND` 失败，SQLite 与 D1）；同一账户被第二个渠道使用 → 409；原始 SQL → 唯一约束失败 |
| P-3 | 来源 | Apple Pay（`device_wallet`）挂两张卡成功，挂账户 → 400 `CHANNEL_SOURCE_KIND`；PayPal 挂卡与账户均成功 |
| P-4 | 来源 XOR | 原始 SQL 同时填 `card_id` 与 `account_id`，或都不填 → CHECK 失败 |
| P-5 | 重复来源与默认 | 同渠道同来源第二条有效记录 → 409；默认唯一；结束来源清除默认 |
| P-6 | 删除级联 | 删除卡 → 其渠道来源被删除，渠道本身保留；删除渠道 → 来源被删除 |

### 3.7 敏感数据防护

| ID | 场景 | 断言 |
|---|---|---|
| X-1 | 备注中含卡号 | `4111 1111 1111 1111`、`4111-1111-1111-1111`、`4111111111111111` 出现在机构/账户/卡/关联/渠道的 `notes` 或 `name` → 400 `SENSITIVE_DATA`，无数据写入 |
| X-2 | 非 Luhn 长数字 | 不通过 Luhn 的 16 位数字 → 允许 |
| X-3 | CVV/PIN | `cvv 123`、`CVC:1234`、`PIN=0000`、`安全码 123` → 400 |
| X-4 | 无绕过 | 带 `force: true`、`allowSensitive: true` 等字段 → 400 `VALIDATION`（未知字段）；不存在任何跳过扫描的参数 |
| X-5 | 日志与审计 | 创建/删除银行卡后，审计 detail 只含 id 与后四位 |

### 3.8 数据隔离

| ID | 场景 | 断言 |
|---|---|---|
| U-1 | API 访问他人数据 | 用户 B 对用户 A 的机构、账户、币种、卡、关联、渠道、来源执行 GET / PATCH / DELETE / POST 子操作 → 全部 404，A 的数据不变 |
| U-2 | API 跨用户引用 | B 创建账户引用 A 的机构、关联 A 的卡、渠道来源引用 A 的卡或账户、余额账户引用 A 的账户 → 404 |
| U-3 | 列表隔离 | B 的所有列表与计数不含 A 的任何数据 |
| U-4 | 复合外键（表驱动） | 对 DATA_MODEL §4 外键矩阵中的**每一条**复合外键，用原始 SQL 插入"子行属于 B、父行属于 A"的记录 → 外键失败。重点覆盖 `payment_channel_sources` 的三条外键（`channel_id`、`card_id`、`account_id`）与 `account_card_links` 的三条外键（含 `(account_id, user_id, currency)`） |
| U-5 | 矩阵完整性 | 读取 `PRAGMA foreign_key_list`，断言每个业务引用都是包含 `user_id` 的复合外键，且父表侧存在对应唯一索引（防止日后新增表时遗漏） |

### 3.9 设置与 M3 准备

| ID | 场景 | 断言 |
|---|---|---|
| H-1 | `home_region` 默认值 | 未设置时 `GET /settings/profile` → `CN` |
| H-2 | 修改 | `PATCH` 为 `HK` 后读取为 `HK`；`hk`、`CHN` → 400 |
| H-3 | 每个用户独立 | 用户 A 改为 `HK` 后用户 B 仍为 `CN`（或其自己的值）；`settings` 中不出现 `home_region`；数据库层：每用户一行、默认 `CN`、CHECK、外键（SQLite 与 D1） |

（M3 的快照与历史不变性测试见 §5。）

### 3.10 鉴权、迁移、回归

| ID | 场景 | 断言 |
|---|---|---|
| R-1 | 鉴权覆盖 | 所有新增路由在未登录时 401；缺 CSRF 头或错误 Origin → 403（沿用 M1 的路由遍历测试，自动包含新路由） |
| R-2 | 迁移 | M1 数据库启动后应用 `0001`；再次启动应用 0 个迁移；旧版数据库仍被拒绝且字节不变 |
| R-3 | 部分索引生效 | 通过 `sqlite_master` 确认各部分唯一索引、CHECK 与触发器存在（防止 drizzle-kit 生成遗漏） |
| R-5 | 迁移生成保护 | `migrations-guard.test.ts` 扫描所有 v1 迁移：引号标识符（拒绝 `` `ifnull("col"` `` 之类）、表达式索引、括号、空语句、journal / SQL / 快照一致、wrangler 拆分与 drizzle 一致、整条链在空库执行且必需触发器存在；自测用 drizzle-kit 的原始错误输出确认能被拒绝 |
| R-4 | 旧版回归 | `npm test`（旧版）全部通过 |

### 3.11 关闭、删除与历史数据

| ID | 场景 | 断言 |
|---|---|---|
| D-1 | 关闭账户后关联保留 | W 有 K 的默认关联；W 改为 `closed` → 关联的 `status`、`is_default` 不变，账户详情与卡详情仍列出该关联；`spending-source` 不再推荐 W（S-7）；W 恢复 `active` → 重新被推荐 |
| D-2 | 关闭币种、冻结卡后关联保留 | 同 D-1，分别对账户币种 `closed`、银行卡 `frozen` 验证：关联不变、不再推荐、恢复后重新推荐 |
| X-6 | 登录失败不记录输入原文 | 用唯一字符串作为用户名（及密码、恢复码）触发 `login.failure` 与 `login.locked`：`audit_log` 中不出现该字符串（含小写形式与其中段）；失败事件仍记录（`{ via }`、时间、IP，已存在账户带 `user_id`），锁定事件只含 `{ scopes }` |
| X-7 | 限流键脱敏、行为不变 | `login_attempts` 中不出现输入的用户名（含大小写变体与中段），用户键等于独立计算的 `HMAC-SHA256(pepper, label + 小写用户名)`，登录与 step-up 写同一个键；行为测试（只经 HTTP 与时钟，不依赖键格式）在旧实现与新实现上都通过：4 次失败不锁定、成功登录清零、5 次锁定且正确凭据也被拒、15 分钟后解锁、大小写合并计数、窗口过期重新计数、不同用户互不影响、未知用户名同样限流、IP 30 次锁定且其他 IP 不受影响、step-up 失败计入同一用户名限额 |
| D-3 | 删除用户的级联清理 | 用户 A、B 各有完整 M2 数据（机构、多币种账户、卡、关联、渠道、来源、`user_preferences`）与认证数据（会话、Passkey、恢复码、审计）。原始 SQL `DELETE FROM users WHERE id = A` 成功（v1 无删除用户接口）；A 在**每张带 `user_id` CASCADE 外键的表**中行数为 0；`audit_log` 中 A 的记录按保留策略原样保留（DATA_MODEL §6.1），且经真实认证流程写入的审计记录不含任何凭证；B 的行数与删除前一致；`PRAGMA foreign_key_check` 为空 |
| D-4 | 余额渠道引用的账户不能删除 | PayPal 渠道的余额账户 → `DELETE /accounts/:id` 409 `IN_USE`（`details.references` 指出渠道）；原始 SQL 删除 → 外键失败；解除余额账户后可删除 |
| D-5 | 历史流水引用的账户不能删除 | **M3 实现**：被 Entry 引用的账户、账户币种、银行卡、支付渠道 → 409 `IN_USE`；原始 SQL 删除 → 外键失败（M3-6） |
| D-6 | 修改 `home_region` 不改写数据 | M2：`PATCH /settings/profile` 前后，除 `user_preferences` 中当前用户一行外，所有表内容一致。M3：已有 Event 的 `home_region` 快照不变（M3-3） |
| D-7 | 修改账户国家不改写数据 | M2：`PATCH /accounts/:id { accountCountry }` 前后，除该账户行外所有表内容一致。M3：已有 Entry 的 `funding_account_country` 快照与统计不变（M3-2） |

### 3.12 SQLite 与 D1 双环境约束测试

同一组用例由两个驱动执行（`describe.each([libsql, d1])`），用例只通过原始 SQL 与 `db.batch()` 访问数据库：

- **libsql**：临时文件数据库，经 `openV1Db()`（身份检查 + 迁移），`PRAGMA foreign_keys = ON`。
- **D1**：wrangler `getPlatformProxy()` 启动的 workerd 内存 D1（`persist: false`、`remoteBindings: false`，wrangler 缓存目录放在临时目录）；按 `_journal.json` 顺序用 wrangler 的 SQL 拆分器执行全部 v1 迁移，与 `wrangler d1 migrations apply` 一致。**不连接远程 D1。**

| ID | 用例 | 两个环境的断言 |
|---|---|---|
| DB-0 | 约束确实开启 | 插入引用不存在父行的记录 → 外键失败（防止假通过）；D1 上 Worker 的身份检查（`xui_v1_meta`）通过 |
| DB-1 | 复合外键（跨用户） | DATA_MODEL §4 矩阵中的每一条复合外键：子行属于 B、父行属于 A → 失败；同用户 → 成功 |
| DB-2 | 可选引用 | `currency`、`card_id`、`provider_institution_id` 等为 NULL 时外键不检查 → 成功 |
| DB-3 | NO ACTION 单独删除 | 单独删除被引用的机构、被关联引用的账户币种、被余额渠道引用的账户 → 失败 |
| DB-4 | NO ACTION 与 CASCADE 同语句 | 删除带币种专属关联的账户 → 成功（币种与关联同时被级联删除）；删除用户 → 成功（机构、账户、卡等全部级联删除），之后 `foreign_key_check` 为空 |
| DB-5 | CASCADE 结果 | 删除卡 → 其关联、渠道来源被删除，渠道保留；删除渠道 → 来源被删除 |
| DB-6 | 部分唯一索引 | 每个账户一个默认币种；同卡同币种范围一个默认关联；未结束关联去重；渠道默认来源唯一；余额账户唯一 —— 冲突插入失败；不冲突的插入（如已结束关联、`is_default = 0`）成功 |
| DB-7 | 表达式索引 | `ifnull(currency, '')`：两条 `currency = NULL` 的同组合未结束关联 → 失败；`ifnull(country, '')`：两个同名且国家为空的机构 → 失败 |
| DB-8 | CHECK | `card_type = credit`、`channel_type = bank_transfer`、来源 XOR、`is_default` 与用途/状态、`last4`、`number_hint` 格式 → 失败 |
| DB-9 | batch 原子性 | "清除旧默认 + 设置新默认"的 batch 中第二条故意违反约束 → 整个 batch 回滚，旧默认仍在 |
| DB-10 | 索引存在 | 从 `sqlite_master` 读取，两个环境的 M2 索引、部分索引条件与外键定义（`PRAGMA foreign_key_list`）一致 |

## 4. 前端与浏览器冒烟（Playwright，临时数据库）

1. 新建机构（并在账户表单内直接新建另一个机构）→ 新建多币种账户（`accountCountry` 必须手动选择，无预填）。
2. 新建借记卡（表单中不存在卡号输入框，只有 4 格后四位）→ 卡片类型选项只有借记、预付。
3. 新建预付卡并勾选"同时创建储值账户" → 账户列表出现储值账户。
4. 在账户详情关联银行卡（指定币种范围）→ 在银行卡详情看到该账户；设为默认 → 两侧同步。
5. 解除关联（提示"保留历史"）→ 两侧进入历史区；删除记录（提示"仅用于纠正误录"）→ 消失。
6. 新建 PayPal 渠道：余额账户 + 卡片来源；新建 Apple Pay：只能选择卡片。
7. 搜索、筛选、状态切换（冻结、关闭、显示已关闭）。
8. 全页面断言：不出现"余额"、金额合计或换算金额；控制台无错误（除匿名 `/auth/me` 401）。
9. 设置 → 通用：本国地区默认显示 CN，可修改。

## 5. M3 测试要求（Event / Entry 与历史完整性，届时实现）

| ID | 场景 | 断言 |
|---|---|---|
| M3-1 | 快照写入 | Event 保存 `event_currency`、`event_amount`、`card_id`、`payment_channel_id`、`home_region`；Entry 保存 `funding_account_id`、`funding_currency`、`amount`、`funding_account_country` |
| M3-2 | 修改账户国家 | 之后历史流水的 `funding_account_country` 与统计结果不变 |
| M3-3 | 修改 `home_region` | 历史流水的境外判断与统计不变 |
| M3-4 | 结束/删除关联 | 历史流水的资金账户、银行卡、渠道与统计不变 |
| M3-5 | 不重算 | 默认来源查找结果变化后，历史流水不变 |
| M3-6 | 删除保护 | 被流水引用的账户、银行卡、支付渠道删除 → 409 `IN_USE`；原始 SQL 删除 → 外键失败 |
| M3-7 | 不重复统计 | PayPal 余额付款与 PayPal 绑卡付款分别只计入一个资金账户；Event 金额不另行计入统计 |
| M3-8 | 跨币种扣款 | Wise 卡 10 USD、从 HKD 扣款：Event = 10.00 USD；Entry = Wise 账户 · HKD · 用户填写的 HKD 金额；按币种统计时只在 HKD 下计入该金额，USD 下不计入 |
| M3-9 | 不自动换算 | 跨币种 Entry 不填金额时为 `pending`，系统不估算、不保存汇率或手续费，不计入金额统计并出现在待补录列表；补录后计入 |
| M3-10 | 扣款币种必须选择 | 推荐为 `conversion_required` 时，未选择 `funding_currency` 不能保存；所选币种不是该账户的 active 币种 → 400 |
| M3-11 | 同币种预填 | 推荐为 `exact_currency` 时扣款金额预填为原始金额，可修改，两者分别保存 |
