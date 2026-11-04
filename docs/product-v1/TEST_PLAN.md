# X-UI Product v1 — 测试计划（TEST_PLAN）

> 状态：§1 为 M1 已有测试；**§2 起为 M2 测试设计（M2-A 修订版）；§3.12 的数据库用例、R-2、R-3、R-5、A-12（schema 与服务层）、H-3（数据库层）、D-3 已在 M2-B1 实现**，API 用例尚未实现；**M2-B2.1 已实现机构 API 用例（`institutions.test.ts`：I-1 – I-5、X-1 – X-4、U-1 – U-3 中与机构相关部分、R-1）、敏感扫描单元测试（`sensitive.test.ts`）与机构浏览器测试（`e2e-v1/institutions.spec.ts`）；M2-B2.2 已实现账户 API 用例（`accounts.test.ts`：A-1 – A-12、D-1、D-2（账户币种部分）、D-4、D-7 以及 X-1 – X-4、U-1 – U-3、R-1 中与账户相关部分）、新建账户须为有效机构（已归档 → 409、恢复后成功、他人机构恒为 404、归档与创建竞争）、替换币种在中间步骤失败时完整回滚（币种集合、默认 USD、`updated_at`、关联均不变），后两类在 libSQL 与本地 D1（`accounts-d1.test.ts`）均验证与账户浏览器测试（`e2e-v1/accounts.spec.ts`，独立测试用户）；M2-B2.3 已实现个人设置 API 用例（`settings.test.ts`：H-1 – H-4、H-6、D-6、R-1 中与设置相关部分（H-5 为 M3 规则），同一组用例在 libSQL 与本地 D1 各执行一次）与设置浏览器测试（`e2e-v1/settings.spec.ts`，独立测试用户）；M2-B3 已实现银行卡 API 用例（`cards.test.ts`：C-1 – C-4、C-6、C-7、C-8、X-1 – X-5 以及 U-1 – U-3、R-1 中与银行卡相关部分，另含新建/改挂须为有效机构、归档与创建竞争、改挂机构与归档/删除竞争（卡片各列不变）、储值账户联合创建在卡/账户/币种/关联/审计任一步注入失败时整库不变且重试只生成一套完整记录、审计与卡片写入同事务（创建与删除）、"已提交但未收到响应"时重发的行为（非幂等，生成第二套完整记录）、删除只影响该卡自身的关联与渠道来源、并发删除；同一组用例在 libSQL 与本地 D1 各执行一次）、到期规则单元测试（`expiry.test.ts`）与银行卡浏览器测试（`e2e-v1/cards.spec.ts`，独立测试用户）；C-5 由 `m2-schema.test.ts` 覆盖；M2-B4 已实现关联与推荐 API 用例（`card-links.test.ts`：L-1 – L-11、S-1 – S-13、D-1、D-2，以及 X-1、X-4、U-1、U-2、U-4、R-1 中与关联相关部分；另含 `endedOn` 校验（正常结束、同日结束、早于开始日期被拒且不写入、省略时为当天并按此存储、数据库只约束 `ended_on` 与 `ended` 状态）、`considered` 在三种响应形状中只含本人数据（libSQL 上关闭外键强行写入跨用户关联行验证查询层隔离）、修改用途与重复、按币种范围的默认、到期不影响推荐、`considered` 解释、为非正常状态的卡/账户记录关联、删除/归档不留孤立关联；原子性：创建、设默认、结束、删除在关联 / 审计 / 设置新默认 / 更新 / 删除任一步注入失败时整库不变且旧默认保留；并发：并发设默认与创建默认始终只有一个默认，检查之后被暂停 / 结束 / 改用途 / 删除时旧默认不被清除，创建与币种关闭、卡片删除、重复关联竞争，PATCH 与设默认 / 结束竞争，并发结束与删除各只生效一次且只有一条审计；同一组用例在 libSQL 与本地 D1 各执行一次），30 个变异（逐一移除服务端的状态、归属、币种、排序、日期与审计条件，以及推荐查询的用户限定）均被测试发现，与关联浏览器测试（`e2e-v1/card-links.spec.ts`，独立测试用户）；M2-B5 已实现支付渠道与来源 API 用例（`channels.test.ts`：P-1 – P-6，以及 X-1、X-2、X-4、U-1 – U-4、I-4、A-10、D-4、R-1 中与渠道相关部分；另含名称唯一（规范化、含已归档、另一用户同名不影响 `existingId`）、余额账户仅限支付服务与 PATCH 合并检查、余额账户状态不限制、服务机构须为有效机构（创建与更换，保留已归档的不检查）、有账户来源（含已结束）的渠道不能改为设备钱包、来源的结束 / 重新添加 / 删除与历史、已结束来源设默认或再次结束 → 409 `LINK_STATE`、归档不改变来源且不阻止管理；隔离：他人的余额账户（正被其渠道使用或未使用）、机构、银行卡、账户一律 404 而非 409，libSQL 上关闭外键强行写入跨用户来源行验证详情只描述本人数据；原子性：来源写入、设置新默认、结束、删除、审计写入、渠道删除及其级联在任一步注入失败时整库不变且旧默认保留；并发：并发设默认与默认创建始终只有一个默认，检查之后被结束 / 删除时旧默认不被清除，来源创建与银行卡 / 账户 / 渠道删除、渠道改为设备钱包、重复来源、渠道归档竞争，渠道修改与余额账户被删除 / 改类型 / 被占用、服务机构被归档 / 删除、渠道被删除、账户来源被添加、余额账户被设置竞争，并发占用同一余额账户、添加同一来源、结束、删除来源与删除渠道各只生效一次且只有一条 `channel.delete` 审计；同一组用例在 libSQL 与本地 D1 各执行一次），变异验证结果见 M2-B5 报告，与支付渠道浏览器测试（`e2e-v1/channels.spec.ts`，独立测试用户）**。
> **§5 为 M3 定稿测试矩阵**（P1–P9 已获用户批准，见 [M3_DECISIONS.md](M3_DECISIONS.md)）：**M3-B1 已实现 §5.2 – §5.17 中的共享函数与数据库层用例**（`m3-shared.test.ts`、`m3-db-probe.test.ts`、`m3-schema.test.ts`、`m3-chains.test.ts`、`m3-migration.test.ts`；数据库用例在 libSQL 与本地 D1 各执行一次），API、HTTP 与浏览器用例（含 ISO-6）随 M3-B2 – B5 实现。**M3-B2.0** 按 M3-B2-A 复审决定（Q1–Q10）补充了边界用例：ISO-7、IDEM-11、IDEM-12、BF-9、CC-7、CC-8、DEL-6、LST-1 – LST-8，并细化 D-4、BF-1、BF-5、CC-4、DEL-1、§5.17。**M3-B2 已实现的 API / HTTP 用例**（同一组用例在 libSQL 与本地 D1 各执行一次）：`transactions-create.test.ts`——M3-1、M3-2 / M3-3（新建部分）、AMT-4、AMT-6、AMT-7、AMT-8（新建部分）、SHP-1 – SHP-6、SHP-8、REG-3、REG-4、REG-6、REG-7、BF-1、BF-2、BF-3、BF-5、BF-7、BF-9、HRD-1 – HRD-3、ISO-2、ISO-3、ISO-5、ISO-6（新建部分）；`transactions-idempotency.test.ts`——IDEM-1、IDEM-3、IDEM-5、IDEM-6、IDEM-9 – IDEM-12、RTY-1、RTY-4、FI（新建）、CC-1、CC-2、CC-4、CC-7、CC-8、ISO-7；`transactions-read.test.ts`——ISO-1（读取部分）、ISO-4、REG-3 / REG-8（列表部分）、IMM-8、BF-6、LST-1 – LST-8；`m3-delete-protection.test.ts`——M3-6、D-5、DEL-1（API 部分）、DEL-6、CC-5；`accounts.test.ts`——D-4（新结构）；`db-errors.test.ts`——可信数据库错误读取与日志脱敏（M3-B2-C2 / Final 安全修复）。更正、作废、备注、版本接口相关的 IDEM-2、IDEM-4、IDEM-8（HTTP）、RTY-2、RTY-3、CC-3、CC-6、COR 随 M3-B3，SUM 随 M3-B5，浏览器用例随 M3-B4 / B5。
> 相关文档：[PRODUCT_SPEC.md](PRODUCT_SPEC.md) · [DATA_MODEL.md](DATA_MODEL.md) · [API_SPEC.md](API_SPEC.md) · [M3_DECISIONS.md](M3_DECISIONS.md)

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
| C-8 | 到期分类（M2-B3） | 有效至到期月份最后一天：本月、下月、跨年、两个月后、已过期、无到期日期分别归类正确；月末当天为 `expiring`（剩 0 天）、次日为 `expired`；闰年 2 月 29 日与平年 2 月 28 日；阈值边界（60 / 61 天）与 `expiringWithinDays` 调整；同一日历日期在任何运行时区结果相同，同一时刻在上海与洛杉矶是不同日期（客户端发送 `today=`，服务端与页面一致）；`today` 与服务器 UTC 日期相差超过 1 天 → 400；到期不改变 `status` |

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
| H-1 | `home_region` 默认值 | 未设置时 `GET /settings/profile` → `{ homeRegion: CN, isDefault: true }`；保存后（含保存 `CN`）`isDefault: false` |
| H-2 | 修改 | `PATCH` 为 `HK` 后读取为 `HK`；`hk`、`CHN` → 400 |
| H-3 | 每个用户独立 | 用户 A 改为 `HK` 后用户 B 仍为 `CN`（或其自己的值）；`settings` 中不出现 `home_region`；请求体带 `userId` → 400，B 不变；数据库层：每用户一行、默认 `CN`、CHECK、外键（SQLite 与 D1） |
| H-4 | 读取不写入、upsert、相同值 | 无记录时 `GET` 不写入任何数据（整库快照不变；`user_preferences` 上的禁止写入触发器不被触发）；首次 `PATCH` 创建一行（`created_at = updated_at`，审计 `created: true`）；再次 `PATCH` 更新同一行（`created_at` 不变，审计 `created: false`），不产生重复行；保存与当前值相同的地区（含无记录时保存 `CN`）整库不变：不写审计、不改 `updated_at`，返回当前设置 |
| H-6 | 并发与原子性（libSQL 与 D1） | 同时两次首次保存（同值 / 不同值）、同时改为不同地区、同时改为相同地区、另一请求在本请求写入前提交：审计记录首尾相接（第一条 `from = CN`，每条 `from` 为实际被替换的值且 `from ≠ to`，只有第一条 `created: true`，最后一条 `to` 等于数据库值），只有一行；两个用户并发互不影响。写入中途失败（审计之后的偏好写入失败，或审计本身失败）→ 500，整库不变；之后重试只生效一次 |
| H-5 | 历史快照规则（M3） | M3 保存流水时写入当时的 `home_region` 快照；修改设置后已有流水的快照不变；历史流水的境外判断只读快照，不用当前 `home_region` 重新解释（M3-1、M3-3） |

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
| D-4 | 余额渠道引用的账户不能删除 | PayPal 渠道的余额账户 → `DELETE /accounts/:id` 409 `IN_USE`（`details.references` 指出渠道）；原始 SQL 删除 → 外键失败；解除余额账户后可删除。M3-B2 起 `details` 的完整断言（`toEqual`，强度不降低）只增加 `references.transactions`：`{ references: { balanceOfChannels: 1, transactions: 0 }, channels: [渠道摘要] }`（API_SPEC §5.12） |
| D-5 | 历史流水引用的账户不能删除 | **M3 实现**：被 Entry 引用的账户、账户币种、银行卡、支付渠道 → 409 `IN_USE`；原始 SQL 删除 → 外键失败（M3-6） |
| D-6 | 修改 `home_region` 不改写数据 | M2：`PATCH /settings/profile` 前后，除 `user_preferences` 中当前用户一行与新增的一条 `preferences.home_region` 审计记录外，所有表内容一致（其他用户的设置行不变）。M3：已有 Event 的 `home_region` 快照不变（M3-3） |
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
9. 设置 → 通用：本国地区默认显示 CN（带"默认"标记与说明，读取后数据库中无该用户的设置行），可修改；保存成功与失败均有提示，失败时已保存的值不变；刷新页面、退出并重新登录后仍为新值；另一用户仍为 CN；中英文界面均显示用途说明与"不会自动重分类历史交易"。

## 5. M3 测试要求（Event / Entry 与历史完整性，届时实现）

依据 PRODUCT_SPEC §7、DATA_MODEL §10、API_SPEC §5。§5.1 是 M2 时期定义的 M3-1 – M3-11，全部保留（按定稿模型补充的断言以"定稿："标出）；§5.2 起为定稿新增矩阵。凡标注"双环境"的用例由 `describe.each([libsql, d1])` 在本地 libSQL 与本地 D1（workerd，`persist: false`、`remoteBindings: false`）各执行一次，**不连接远程 D1**。

### 5.1 M3-1 – M3-11（M2 时期定义，保留）

| ID | 场景 | 断言 |
|---|---|---|
| M3-1 | 快照写入 | Event 保存 `event_currency`、`event_amount`、`card_id`、`payment_channel_id`、`home_region`（保存时用户设置的值，无记录时为 `CN`）；Entry 保存 `funding_account_id`、`funding_currency`、`amount`、`funding_account_country`。定稿：另保存 `home_region_source = 'preference_at_save'`、`country_source = 'account_at_save'`、`currency_status_at_save`；补录声明的本国地区见 HRD |
| M3-2 | 修改账户国家 | 之后历史流水的 `funding_account_country` 与统计结果不变 |
| M3-3 | 修改 `home_region` | 修改后已有 Event 的 `home_region` 快照逐行不变；历史流水的境外判断与统计不变（只读快照，不用当前 `home_region` 重新解释）；修改后新建的流水使用新值 |
| M3-4 | 结束/删除关联 | 历史流水的资金账户、银行卡、渠道与统计不变 |
| M3-5 | 不重算 | 默认来源查找结果变化后，历史流水不变 |
| M3-6 | 删除保护 | 被流水引用的账户、银行卡、支付渠道删除 → 409 `IN_USE`；原始 SQL 删除 → 外键失败 |
| M3-7 | 不重复统计 | PayPal 余额付款与 PayPal 绑卡付款分别只计入一个资金账户；Event 金额不另行计入统计 |
| M3-8 | 跨币种扣款 | Wise 卡 10 USD、从 HKD 扣款：Event = 10.00 USD；Entry = Wise 账户 · HKD · 用户填写的 HKD 金额；按币种统计时只在 HKD 下计入该金额，USD 下不计入 |
| M3-9 | 不自动换算 | 跨币种 Entry 不填金额时为 `pending`，系统不估算、不保存汇率或手续费，不计入金额统计并出现在待补录列表；补录后计入 |
| M3-10 | 扣款币种必须选择 | 推荐为 `conversion_required` 时，未选择 `funding_currency` 不能保存；所选币种不是该账户的 active 币种 → 400。定稿（P7 例外）：本断言适用于 `recordMode = 'current'` 的新 Entry；历史补录经逐条确认、或更正时沿用原有 Entry 的已关闭币种允许，见 BF |
| M3-11 | 同币种预填 | 推荐为 `exact_currency` 时扣款金额预填为原始金额，可修改，两者分别保存 |

### 5.2 金额与币种小数位（AMT）

| ID | 场景 | 断言 |
|---|---|---|
| AMT-1 | 最小单位表 | `@xui/ledger-shared` 的 ISO 4217 小数位表覆盖 `CURRENCY_CODES` 全部 155 个代码，来源与计数固定（同 `iso.ts` 的 SIX List One）；代表值 JPY / KRW / VND / CLP / ISK = 0，USD / HKD / EUR = 2，BHD / KWD / JOD / OMR / TND = 3 |
| AMT-2 | 解析 | `"78.30"` HKD → 7830；`"1000"` JPY → 1000；`"1.234"` BHD → 1234；小数位多于规定（`"1.5"` JPY、`"1.001"` USD）、负数、`0`、科学计数法、空白、千分位、全角数字 → 拒绝；全程字符串 / BigInt，与浮点无关（属性测试：随机整数格式化后再解析得到原值） |
| AMT-3 | 格式化 | 按小数位格式化最小单位整数与十进制字符串（含超过 2^53 的汇总值） |
| AMT-4 | API 边界 | `amount` / `eventAmount` 为 1 与 999 999 999 999 999 → 成功；0、−1、1e15、`78.3`、`"100"`（字符串）→ 400 `VALIDATION` |
| AMT-5 | 数据库边界（双环境） | 原始 SQL 写入 `0`、负数、`78.3`、超上限 → CHECK 失败；`7830.0` 存为 integer；`typeof` 检查确实生效 |
| AMT-6 | 小数位快照 | Entry 与 Event 保存 `currency_exponent` / `event_currency_exponent`，等于写入时表中的值；客户端提交小数位 → 400 |
| AMT-7 | Event 金额含义与可空（P8） | 消费、退款、本人调拨、第三方汇出缺少 `eventAmount` → 400 `ENTRY_SHAPE`；第三方汇入（唯一 Entry 为 `in`）可为 `null`（币种可单独填写）；原始 SQL：Event 金额为空却有 `out` Entry 的版本发布 → `LEDGER_EVENT_AMOUNT` |
| AMT-8 | 跨币种不推算 | 汇出 USD、扣款 HKD、到账 USD 的本人调拨三个金额分别保存；响应、数据库与页面中没有汇率、手续费或差额字段 |

### 5.3 Event / Entry 形状（SHP，API 与双环境原始 SQL）

| ID | 场景 | 断言 |
|---|---|---|
| SHP-1 | 消费 | 1 条 `out` 成功；0 条、2 条、`in` → 400 `ENTRY_SHAPE`；原始 SQL 第二条 Entry → 唯一索引失败，`in` → CHECK 失败 |
| SHP-2 | 退款 | 1 条 `in` 成功；`out` → 400 / CHECK 失败 |
| SHP-3 | 第三方 | 1 条 `out` 或 `in` 成功；2 条 → 400 / 唯一索引失败；`counterparty_kind = 'third_party'` |
| SHP-4 | 本人调拨两侧已登记 | 一出一入、不同账户成功；带 `counterparty` → 400 / 发布 `LEDGER_OWN_TRANSFER_SHAPE`；同一账户既出又入 → 400 / 唯一索引失败（不做同一账户内换币）；两条同方向 → 唯一索引失败；第三条 → 唯一索引失败（第三条必与已有方向重复）；C2 的上限另在会回滚的 batch 内移除方向唯一索引后验证为 `LEDGER_ENTRY_COUNT` |
| SHP-5 | 本人调拨一侧未登记 | 1 条 + `counterparty.country` 成功；缺 `counterparty.country` → 400 / `LEDGER_OWN_TRANSFER_SHAPE` |
| SHP-6 | 类型专属字段 | 转账带 `cardId` / 商户字段、消费带 `transferMethod` / `counterparty` → 400 / CHECK 失败；`counterparty_kind` 与类型不符 → CHECK 失败 |
| SHP-7 | 零 Entry 发布 | 原始 SQL 发布没有 Entry 的版本 → `LEDGER_ENTRY_COUNT` |
| SHP-8 | 跨币种本人调拨（Q3） | HKD 账户 → USD 账户成功，两侧各自金额，不要求相等 |

### 5.4 地域三态（REG）

| ID | 场景 | 断言 |
|---|---|---|
| REG-1 | 三态真值表 | `classify` v1 对消费（账户 = / ≠ H × 商户 = H / ≠ H / 未知）与转账（F、T 各为 = H / ≠ H / 未知，且 F = T / F ≠ T）的全部组合给出 DATA_MODEL §10.8 的 `merchant_scope`、`transfer_scope`、`foreign_status`；HK、MO、TW 独立 |
| REG-2 | TS 与 SQL 一致（双环境） | 对 REG-1 的每个组合构造已保存版本，发布触发器（SQL）接受 TS 计算的值、拒绝任何其他值（`LEDGER_CLASSIFICATION`）；含 NULL 的组合逐一覆盖 |
| REG-3 | 未知 ≠ 境内 | 境内账户 + 未知商户、本国账户 → 法域未知的第三方 → `undetermined`，保存成功；列表 `foreignStatus=domestic` 不含它们；统计中只出现在 `undetermined` 块 |
| REG-4 | 纯境内拒绝（P2） | 境内账户 + 境内商户、两侧均为 H 的本人调拨 → 400 `CONFIRMED_DOMESTIC`，无任何写入；原始 SQL 发布 → `LEDGER_CONFIRMED_DOMESTIC` |
| REG-5 | 更正后纯境内 | 事实更正或快照更正使新版本成为已确认纯境内 → 400 `CONFIRMED_DOMESTIC`，`details.suggestion = 'void'`，原版本不变 |
| REG-6 | 法律法域而非收款路径 | Wise（`account_country = BE`）HKD 余额经 FPS 从香港账户转入 → `foreign_cross_border`（HK → BE）；请求中出现 IBAN、BIC、收款信息国家等字段 → 400 `VALIDATION`；`transfer_method`、发卡国家、机构总部变化不影响分类 |
| REG-7 | 不重分类 | 修改 `home_region`、账户 `account_country` 后，已有版本的快照、分类与统计逐行不变（M3-2、M3-3）；之后新建的交易使用新值 |
| REG-8 | 筛选 | `foreignStatus` 筛选与统计三块互不重叠；不存在"非境外"筛选参数（→ 400） |

### 5.5 用户隔离（ISO）

| ID | 场景 | 断言 |
|---|---|---|
| ISO-1 | 读取他人 | 用户 B 对 A 的交易 GET / 版本 / 更正 / 作废 / 备注 → 404，A 不变 |
| ISO-2 | 引用他人 | B 新建或更正时使用 A 的账户、卡、渠道 → 404（不是 400 / 409）；原始 SQL → 被拒绝，且引用他人父行与引用不存在父行的错误相同（双环境，数据库错误矩阵）：卡、渠道、键行的引用为复合外键失败；交易头、Event 以及 Entry 的账户 / 币种 / 被沿用 Entry 引用由 `ev_insert_order` / `en_insert_open` / `en_snapshot_source` 先拒绝（`LEDGER_*`，BEFORE 触发器先于外键）；这些复合外键本身由 U-5 结构检查与 NO ACTION 删除用例覆盖 |
| ISO-3 | 错误不泄露 | 引用 A 的已关闭币种账户、A 的已作废交易、A 正在使用的幂等键 → B 都只得到 404 或与 A 无关的结果；`details` 中不出现 A 的任何 id |
| ISO-4 | 列表与统计 | B 的列表、统计、筛选（以 A 的 `accountId` 筛选）不含 A 的数据 |
| ISO-5 | 幂等键命名空间 | A、B 使用相同的 `Idempotency-Key` 各自新建 → 两笔独立交易，互不重放、互不冲突 |
| ISO-6 | 数据库错误与 HTTP 错误的边界（M3-B2 实现的 HTTP 回归契约，B1 未实现） | 数据库错误分类（`LEDGER_*`、外键、CHECK、键行 NOT NULL）只在服务端内部使用，不直接决定 HTTP 结果（细化 DATA_MODEL §10.10「batch 之后的路由处理」）：写入前按当前用户确认交易、账户、卡、渠道的归属，他人或不存在的资源一律 404 `NOT_FOUND`、无 `details`、响应体相同；batch 失败后按当前用户可见的资源状态重新判定（已作废 → `TRANSACTION_VOIDED`，版本已变 → `REVISION_CONFLICT`，确认归属后的业务错误 → §5.1 / API_SPEC §5.1 的对应错误码）；不得把所有外键失败统一转为 404，也不得把所有 `LEDGER_CLASSIFICATION` / `LEDGER_SNAPSHOT_SOURCE` 统一转为 `CONCURRENT_CHANGE`——只有能确认是预读后快照被并发修改的情形才受控重试一次，重试沿用同一 `Idempotency-Key` 与请求哈希；无法识别的内部错误 → 500 通用消息，不回显数据库消息。用例：对账户、币种、卡、渠道、被沿用 Entry、交易（更正 / 作废）分别以他人 id 与不存在 id 请求 → 状态码与响应体相同，无写入、无审计、无键行，响应不含他人任何 id。数据库层的对应性质（经写入链时他人与不存在的引用结果相同、不写入）已由 M3-B1 双环境测试验证 |
| ISO-7 | 错误映射的边界（M3-B2.0，双环境，DATA_MODEL §10.10） | ① 归属检查之后、batch 之前删除所引用的卡 / 渠道（外键失败）或账户、移除币种（键行 NOT NULL 失败）→ 重新读取后 404 / 400 `CURRENCY_NOT_ON_ACCOUNT`（`status = null`），与写入前检查的响应体相同；② 以测试替身使 batch 抛出外键失败或键行 NOT NULL 失败、而重新读取时全部引用可见且可登记 → 500，不是 404；③ 以测试触发器在写入链中分别抛出 `LEDGER_SNAPSHOT_SOURCE` 与每个按构造不可达的守卫错误码（DATA_MODEL §10.10 表中所列）、CHECK 失败、键表主键以外的 UNIQUE 失败 → 500，响应体恰为 `{ error: 'internal error', code: 'INTERNAL' }`；④ 以上全部：无交易、无审计、无键行，同键修正后重试正常执行一次；任何 4xx / 5xx 响应中都不出现 `LEDGER_`、`constraint`、`FOREIGN KEY`、`UNIQUE`、`NOT NULL`、表名或列名、任何他人 id |

### 5.6 幂等（IDEM）

| ID | 场景 | 断言 |
|---|---|---|
| IDEM-1 | 键必填 | 新建、更正、作废缺少键 → 400 `IDEMPOTENCY_KEY_REQUIRED`；长度 15 / 65、含空格或 `.` → 400 `IDEMPOTENCY_KEY_INVALID`；均无写入 |
| IDEM-2 | 备注不用键 | `PATCH /notes` 不带键成功；带任意键也不被读取，键表不变 |
| IDEM-3 | 重放确定 | 新建后重复同一请求 → 201、`Idempotency-Replayed: true`，响应体与首次逐字节相同；之后经过更正、作废、备注修改、账户改名再重放，仍逐字节相同（`revision = 1`，`statusAfter = 'active'`），不是当前状态 |
| IDEM-4 | 更正与作废的重放 | 同上，对更正（201、`revision = r+1`）与作废（200、`statusAfter = 'voided'`） |
| IDEM-5 | 键冲突 | 同一键、请求内容不同（任一字段、Entry 顺序以外的差异）→ 409 `IDEMPOTENCY_CONFLICT`，`details` 只含本人的 `operation`、`transactionId`，无写入；仅 JSON 键顺序或 Entry 顺序不同 → 视为相同（规范化） |
| IDEM-6 | 失败不占用键 | 400 / 404 / 409 `REVISION_CONFLICT` / 注入失败后，用同一键修正请求重试 → 正常执行一次 |
| IDEM-7 | 完成态键行（双环境） | 每条成功写入恰有一条键行，结果列全部非空且指向已发布版本与已存在的审计记录；任何时刻不存在指向未发布版本的键行；原始 SQL `UPDATE` 键行 → `LEDGER_KEY_IMMUTABLE` |
| IDEM-8 | 保留期 | 测试时钟推进 31 天：新建键仍在并重放；更正、作废键被下一次写入的 S0 删除；之后用原键重试更正 → 409 `REVISION_CONFLICT`、作废 → 409 `TRANSACTION_VOIDED`，无写入；S0 只删除当前用户已过期的更正 / 作废键；原始 SQL 删除新建键 → `LEDGER_NO_DELETE` |
| IDEM-9 | 哈希版本 | 键行 `hash_version` 与当前算法不同时按键行版本比较（以测试替身注入 v2 验证），不误判冲突 |
| IDEM-10 | 规范化 | 哈希 v1 对键顺序、Entry 顺序稳定；任一值变化即变化；固定向量测试 |
| IDEM-11 | 判定顺序（Q1） | 键 K 已成功用于新建后：同一 K 提交 `ENTRY_SHAPE` 违规的请求 → 400 `ENTRY_SHAPE`（不是 409）；`occurredOn` 晚于服务器 UTC 次日 → 400 `VALIDATION`；未知字段 → 400 `VALIDATION`；请求体合法但内容不同（含引用他人账户）→ 409 `IDEMPOTENCY_CONFLICT`，`details` 只含本人键行的 `operation`、`transactionId`。新键：`ENTRY_SHAPE` 违规且引用他人账户 → 400 `ENTRY_SHAPE`（只依赖请求体的错误先于 404）；形状合法但引用他人账户 → 404。以上均无写入 |
| IDEM-12 | 未知哈希版本（Q9） | 原始 SQL 写入 `hash_version = 99` 的键行（`CHECK(hash_version >= 1)` 允许）后，同一用户以该键提交 → 500 通用消息，既不重放也不 409；数据库不变 |

### 5.7 响应丢失后重试（RTY）

| ID | 场景 | 断言 |
|---|---|---|
| RTY-1 | 新建已提交、响应丢失 | 服务端提交后丢弃响应，同键重试 → 重放首次结果；数据库只有一笔交易、一条审计、一条键行 |
| RTY-2 | 更正已提交、响应丢失 | 同键重试 → 重放；只有一个新版本 |
| RTY-3 | 作废已提交、响应丢失 | 同键重试 → 重放 200；只有一条 `transaction.void` 审计 |
| RTY-4 | 未提交 | 写入前失败（注入）后同键重试 → 正常执行一次 |

### 5.8 不可变版本与发布原子性（IMM，双环境）

| ID | 场景 | 断言 |
|---|---|---|
| IMM-1 | Event / Entry 不可修改 | 原始 SQL `UPDATE` 任一列 → `LEDGER_IMMUTABLE` |
| IMM-2 | 交易头更新守卫 | 改 `txn_type` / `user_id` / `created_at` → `LEDGER_HEADER_IMMUTABLE`；版本号跳号或回退 → `LEDGER_REVISION_ORDER`；作废后改状态、版本号、作废字段 → `LEDGER_VOIDED`；作废后改备注 → 成功 |
| IMM-3 | 版本插入顺序 | 插入 `revision ≠ current + 1` 或向已作废交易插入版本 → `LEDGER_REVISION_ORDER` |
| IMM-4 | 已发布版本不能追加 Entry | 向 `revision ≤ current` 的版本插入 Entry → `LEDGER_IMMUTABLE` |
| IMM-5 | 快照来源真实性 | `preference_at_save` / `account_at_save` / `carried` 与实际值不符、`currency_status_at_save` 伪造、`carried_from_entry_id` 指向其他交易 / 非上一版本 / 不同账户、上一版本有同账户的 Entry 却未沿用（事实更正中以 `account_at_save` 重新取快照，包括只改方向的情形）→ `LEDGER_SNAPSHOT_SOURCE`；合法组合（快照更正中 `carried` 或 `user_corrected` 且 `carried_from_entry_id` 非空；事实更正中换账户的 Entry 为 `account_at_save` 且为空）→ 成功；沿用的 Entry 标为 `account_at_save` → CHECK 失败；未沿用却标为 `carried` / `user_corrected` → `LEDGER_SNAPSHOT_SOURCE`（触发器先于 CHECK；CHECK 本身另在会回滚的 batch 内移除触发器后验证） |
| IMM-6 | 版本种类守卫 | `settlement` 改动金额以外的事实、`snapshot_correction` 改动快照以外的事实 → `LEDGER_REVISION_KIND` |
| IMM-7 | 发布原子性 | 写入链（DATA_MODEL §10.10）每一步缺失（不发布、少一条 Entry、无审计）→ 键行 NOT NULL 失败，整体回滚，交易头、Event、Entry、审计、键行均为 0 行 |
| IMM-8 | 只读当前版本 | 列表、详情、统计只读取当前版本；被取代版本的 Entry 不计入（M3-7 扩展） |
| IMM-9 | 未发布残留 | 不变式检查：已提交数据中不存在 `revision > current_revision` 的 Event 或 `current_revision = 0` 的交易头 |
| IMM-10 | 交易头 INSERT 守卫 | 原始 SQL 插入 `current_revision = 1`、`status = 'voided'`（配齐作废字段）、`voided_at` / `voided_op_id` / `void_reason` 任一非空的交易头 → `LEDGER_HEADER_INSERT`（BEFORE 触发器先于 CHECK），无行写入；`current_revision = 0`、`active`、作废字段为空 → 成功（只是未发布，不可见） |
| IMM-11 | 发布与 UPDATE 守卫的触发条件 | ① 版本号不变、只改 `notes` → 成功且不执行发布检查（验证方法：测试中临时移除发布触发器，构造一个不满足 C2–C7 的已发布版本后按迁移原文恢复触发器；之后改备注不报 C2–C7 错误）；② 版本号不变、改 `txn_type` / `created_at` → `LEDGER_HEADER_IMMUTABLE`，改 `status` 或作废字段（不符合形态 ③）→ `LEDGER_REVISION_ORDER`；③ r → r+2、r → r−1、r → r（同时改其他受保护列）→ `LEDGER_REVISION_ORDER`；④ 已作废交易 r → r+1 或改回 `active` → `LEDGER_VOIDED`；⑤ 同一 UPDATE 同时发布与作废 → `LEDGER_REVISION_ORDER`；⑥ 合法 r → r+1 → C2–C7 全部执行（各构造一个违规版本得到对应错误码）；以上被拒绝时整行不变 |

### 5.9 历史补录与已关闭币种（BF）

| ID | 场景 | 断言 |
|---|---|---|
| BF-1 | 当前交易用已关闭币种 | → 400 `CURRENCY_NOT_ON_ACCOUNT`（`details = { direction, currency, status: 'closed' }`），无写入（M3-10） |
| BF-2 | 补录未确认 | `recordMode = 'backfill'`、未带 `closedCurrencyAck` → 400 `CLOSED_CURRENCY_ACK_REQUIRED` |
| BF-3 | 补录并确认 | 成功；`currency_status_at_save = 'closed'`、`closed_currency_ack = 1`；原始 SQL 写入不满足 R3 的 Entry → `LEDGER_CLOSED_CURRENCY`（双环境） |
| BF-4 | 沿用 | 币种关闭后对交易做事实更正或补录金额：同账户同币种的 Entry 沿用成功；改为另一已关闭币种（当前模式）→ 400 |
| BF-5 | 未登记币种 | 账户上没有的币种 → 400 `CURRENCY_NOT_ON_ACCOUNT`（`details.status = null`，Q4）；经 `PUT /currencies` 以 `closed` 状态添加后可补录 |
| BF-6 | 保存时状态 | `currency_status_at_save` 由 SQL 读取；关闭币种后重新开启，已有 Entry 的值不变；DTO 与页面标为"保存时状态" |
| BF-7 | 不推断历史状态 | 已关闭 / 冻结账户、已过期 / 停用的卡、已归档渠道均可用于补录与当前交易；不要求卡与账户存在关联；补录模式下前端不自动套用推荐 |
| BF-8 | 用户声明 | `record_mode` 原样保存；不影响分类与统计；可经事实更正修改 |
| BF-9 | 确认是许可（Q3，双环境） | 币种为 `active` 时带 `closedCurrencyAck: true`（当前与补录两种模式）→ 201，数据库 `closed_currency_ack = 0`、`currency_status_at_save = 'active'`，响应 `closedCurrencyAck: false`；键行 `request_hash` 等于按请求体（含 `true`）计算的哈希；同键重发相同请求 → 重放（逐字节相同），同键改为 `false` → 409 `IDEMPOTENCY_CONFLICT`。币种为 `closed` 时：补录 + `true` → 保存 1；补录 + `false` → BF-2；当前模式 + `true` → BF-1。`currency_status_at_save` 仍为写入语句读取的保存时状态 |

### 5.10 用户自述历史本国地区（HRD，P4）

| ID | 场景 | 断言 |
|---|---|---|
| HRD-1 | 声明 | 补录带 `declaredHomeRegion = HK`（当前设置 CN）→ `home_region = HK`、来源 `user_declared`，按 HK 分类 |
| HRD-2 | 与设置独立 | 声明前后 `user_preferences` 与 `preferences.home_region` 审计不变；之后修改设置，已声明的快照不变 |
| HRD-3 | 仅限补录 | `recordMode = 'current'` 带 `declaredHomeRegion` → 400 `VALIDATION`；原始 SQL `user_declared` 用于非补录或 `revision > 1` → CHECK 失败 |
| HRD-4 | 沿用 | 对声明过的交易做事实更正 → 新版本 `home_region` 相同、来源 `carried` |

### 5.11 版本更正与快照更正（COR）

| ID | 场景 | 断言 |
|---|---|---|
| COR-1 | 补录金额 | pending → confirmed 成功，新版本 `settlement`，其余逐字段沿用；对 confirmed Entry 或改动其他字段 → 400 |
| COR-2 | 事实更正 | 必须有 `reason`；换账户的 Entry 取新账户保存时法域（`account_at_save`）、未换账户的沿用（`carried`，只改方向也沿用）；`home_region` 沿用；与上一版本完全相同 → 400；不能修改 `type` |
| COR-3 | 快照更正（P5） | 只改 `homeRegion` 和 / 或某方向的 `fundingAccountCountry`，必须有 `reason`；来源 `user_corrected`；分类重新推导；旧版本保留；值与上一版本相同 → 400；不能夹带事实修改；没有批量接口 |
| COR-4 | 不自动重分类 | 设置、账户法域、关联、推荐变化都不生成新版本（M3-2 – M3-5） |
| COR-5 | 乐观并发 | `baseRevision` 过时 → 409 `REVISION_CONFLICT`（`details.currentRevision`）；已作废 → 409 `TRANSACTION_VOIDED` |
| COR-6 | 作废 | 作废后不计入统计，全部版本可读；不能再更正或作废；备注仍可修改 |
| COR-7 | 备注 | `PATCH /notes` 不生成版本，只修改交易头的 `notes` 与 `updated_at`，不改统计；不出现在 `TransactionWriteResult` 与重放中；不记审计；更正请求带 `notes` → 400 |
| COR-8 | 版本历史 | `GET /revisions/:n` 返回各版本原样内容；未发布或不存在的版本 → 404 |

### 5.12 删除保护与用户级联（DEL，双环境）

| ID | 场景 | 断言 |
|---|---|---|
| DEL-1 | 主数据删除保护 | 被当前版本、被取代版本或已作废交易引用的账户、卡、渠道 → 409 `IN_USE`（`details.references.transactions`）；被引用的币种移除 → 409 `CURRENCY_IN_USE`；原始 SQL 删除 → 外键失败（M3-6、D-5）。M3-B2.0 细化：`details` 完整断言——账户 `{ references: { balanceOfChannels, transactions }, channels }`，卡与渠道 `{ references: { transactions } }`；`transactions` 为不同交易数，同一交易的多个版本只计一次，只被被取代版本引用（原始 SQL 构造）或只被已作废交易引用的对象同样计入；`CURRENCY_IN_USE` 的 `currencies` 为关联与 Entry 引用的并集；被拒绝时对象、其币种 / 关联 / 来源与审计均不变 |
| DEL-2 | 业务层无删除 | 静态测试：`apps/ledger-api/src` 中对四张 M3 表的删除只出现在 S0 过期键清理；没有删除交易的路由 |
| DEL-3 | 数据库删除守卫 | 用户存在时原始 SQL 删除交易头、Event、Entry、新建键 → `LEDGER_NO_DELETE`；`PRAGMA foreign_keys = OFF` 时同样拒绝（libSQL） |
| DEL-4 | 用户级联 | 扩展 D-3：用户 A、B 各有含多个版本、已作废交易与幂等键的完整 M3 数据；删除 A 成功，A 在四张 M3 表中行数为 0，B 不变，`foreign_key_check` 为空，`audit_log` 中 A 的 `transaction.*` 记录保留且只含 id |
| DEL-5 | 级联与 NO ACTION 共存 | 删除用户时 Entry → 账户 / 币种的 NO ACTION 与 Event → 交易头的 CASCADE 在同一语句中完成 |
| DEL-6 | 账户删除与审计同事务（Q8） | 成功删除 → 200 `{ ok: true }`（与 M2 相同），恰有一条 `account.delete` 审计，`detail = { id }`；被余额渠道或流水引用（409）、不存在 / 他人（404）、检查之后被并发删除（404）→ 没有新增的 `account.delete` 审计；检查之后新增的流水引用（外键拒绝）→ 409 且无审计、账户及其币种 / 关联 / 来源不变；注入审计写入失败 → 500，账户仍在；注入删除失败 → 审计不存在。审计存在当且仅当删除已提交 |

### 5.13 精确统计（SUM，双环境）

| ID | 场景 | 断言 |
|---|---|---|
| SUM-1 | 溢出基准 | 同组 9300 条上限金额：直接 `SUM(amount)` 报 integer overflow（证明需要分段） |
| SUM-2 | 分段求和 | 同一数据经 `/summary` 得到与 BigInt 参考值完全相同的十进制字符串（大于 2^53） |
| SUM-3 | 无浮点 | 静态测试：服务端源码不使用 `TOTAL(`、`AVG(`；汇总值以字符串返回 |
| SUM-4 | 范围 | 只计 `active` 交易当前版本的 `confirmed` Entry；作废、被取代、pending 不计入；pending 只在 `pending` 中计数 |
| SUM-5 | 不跨币种 / 小数位 | 不同币种、同币种不同 `currency_exponent`（原始 SQL 构造）分组分开；没有任何合计字段 |
| SUM-6 | 三块分离 | `foreign`、`undetermined`、`domestic` 互不重叠；消费与退款、汇出与到账分开；Event 金额不参与（M3-7、M3-8） |
| SUM-7 | 多个本国地区 | 期间内含不同 `home_region` 快照的交易 → `homeRegions` 列出全部，每笔按自身快照归类 |

### 5.14 libSQL 与本地 D1 一致性（DB-M3）

| ID | 用例 | 断言 |
|---|---|---|
| DB-M3-0 | 探针（B1 必做，DATA_MODEL §10.13） | 在本地 D1 上逐项确认：`typeof` 整数 CHECK、交易头 INSERT / UPDATE 守卫与发布触发器 `WHEN` 条件（IMM-10、IMM-11）、部分唯一索引、含子查询的发布触发器、删除守卫与用户级联、最后一步 NOT NULL 断言、`CAST(SUM(...) AS TEXT)`、上述写法能以 drizzle 查询构造器在 D1 batch 中表达、Event 插入 ≤ 100 个绑定参数。任何一项不成立 → B1 停止并报告 |
| DB-M3-1 | 结构一致 | 两个环境的 M3 表、索引（含部分索引条件）、外键、触发器定义一致（`sqlite_master`、`PRAGMA foreign_key_list`）；U-5 矩阵完整性包含 M3 表 |
| DB-M3-2 | 迁移 | `0002_m3_transactions` 只新建四张表及其索引、触发器；`0000`、`0001` 字节不变；M2 数据库启动后只应用 0002，再次启动应用 0；`migrations-guard` 通过 |
| DB-M3-3 | 同一用例 | AMT-5、AMT-7（原始 SQL 部分）、SHP、REG-2、REG-4（原始 SQL 部分）、IMM（含 IMM-10、IMM-11）、BF-3、DEL、SUM、IDEM-7、IDEM-8 在两个环境用同一套用例通过；DATA_MODEL §10.7.2 的 21 个触发器每个至少有一条原始 SQL 违规用例在两个环境中执行 |

### 5.15 故障注入（FI，双环境）

沿用 M2 的 `RAISE(ABORT, 'TEST_INJECTED_FAILURE')` 测试触发器。对新建、每种更正与作废，分别在交易头、Event、每条 Entry、发布、审计、键行写入处注入失败：返回 500，整库（含键表与审计）与注入前完全一致；移除注入后用同一键重试只成功一次。

### 5.16 并发（CC，双环境，`interleave` 工具）

| ID | 场景 | 断言 |
|---|---|---|
| CC-1 | 同键并发 | 两个相同请求同时提交 → 一个 201、一个重放；一笔交易、一条审计、一条键行 |
| CC-2 | 同键不同内容并发 | 一个成功、一个 409 `IDEMPOTENCY_CONFLICT` |
| CC-3 | 更正与更正 / 作废竞争 | 同一 `baseRevision` 只有先提交者成功，另一个 409；版本号连续 |
| CC-4 | 快照并发修改 | 预读之后账户 `account_country` 或 `home_region` 被修改：发布检查拒绝不一致版本，服务端重试后按新值保存，或 409 `CONCURRENT_CHANGE`；已发布版本的分类始终等于其已保存快照的推导结果。修改不改变分类时不发生重试，按新快照保存（快照 = 保存时的值）；修改使新值成为已确认纯境内时，重试的预检查给出 400 `CONFIRMED_DOMESTIC` |
| CC-7 | 币种状态并发修改 | 预读之后币种被关闭（当前交易）→ `LEDGER_CLOSED_CURRENCY` → 确认状态已变，重试一次，预检查给出 400 `CURRENCY_NOT_ON_ACCOUNT`（`status = 'closed'`）；补录 + 确认时币种在预读之后被重新开启 → 不失败，201，保存 `closed_currency_ack = 0`、`currency_status_at_save = 'active'`（BF-9）；预读之后币种被移除 → 400 `CURRENCY_NOT_ON_ACCOUNT`（`status = null`，ISO-7）。均无残留行 |
| CC-8 | 受控重试的条件（DATA_MODEL §10.10） | 以测试触发器或替身在来源**未变**时抛出 `LEDGER_CLASSIFICATION` / `LEDGER_CLOSED_CURRENCY` → 500，写入 batch 只执行一次，不返回 `CONCURRENT_CHANGE`；来源变化一次 → 写入 batch 恰好执行两次，第二次成功：只有一笔交易、一条审计、一条键行，第一次尝试的 T / E / Entry / 审计 id 都不存在，键行的 `key` 与 `request_hash` 等于首次计算的值；来源连续变化两次 → 409 `CONCURRENT_CHANGE`，无任何行、无键行，同键重试正常执行；两次尝试之间同键的另一请求已提交 → 第二次尝试前的键查找得到重放（相同请求）或 409 `IDEMPOTENCY_CONFLICT`（不同请求），不再写入；结果未知的错误（以替身模拟连接中断）→ 500 且不重试，同键重试经幂等查找恢复 |
| CC-5 | 与主数据变更竞争 | 新建与删除账户 / 卡 / 渠道、关闭币种竞争：要么交易成功且删除得到 409，要么删除成功且交易得到 404 / 400；不存在悬空引用 |
| CC-6 | 备注与更正竞争 | 两者互不影响：备注不改变版本，更正不改变备注 |

### 5.17 变异测试（MUT）

逐一移除以下内容，确认对应测试失败（M3-B2.0 新增项随 B2 实现：受控重试中"来源值与预读值不同"的比较（移除后 CC-8 中来源未变的情形会错误地得到 `CONCURRENT_CHANGE`）；重试沿用首次哈希（改为重新计算或换新键）；外键失败后的重新读取（改为一律 404）；确认写法中的 `CASE WHEN ac.status = 'closed'`（BF-9）；引用计数中的被取代版本与已作废交易；账户删除审计与删除同一 batch（DEL-6）；`q` 分页以最后一条匹配为 `nextCursor`（改为最后扫描的候选，LST-3）；只依赖请求体的错误先于幂等查找（IDEM-11）；未知 `hash_version` → 500（IDEM-12））：写入语句中的 `user_id` 限定；门控 G；键行结果子查询中的任一条件（`EXISTS (Event E)`、`voided_op_id = O`、`current_revision = r+1`）；发布语句的 Entry 数条件；C1 – C7 每一项；`tx_insert_guard`；发布触发器的 `WHEN` 条件（改为无条件或仅 `OF current_revision`）；`tx_update_guard` 的错误码顺序；Entry 按账户（而非方向 + 账户）沿用的匹配条件；`ev_snapshot_source` / `en_snapshot_source` / `en_closed_currency` / `ev_kind_guard` / `en_kind_guard`；删除守卫；分段求和（改为直接 `SUM`）与 `CAST AS TEXT`；三态中 `IS NOT NULL` 条件（改为只写 `c <> H`）；`TransactionWriteResult` 只含不可变数据的限制；新建键永久保留；S0 的 `user_id` 与 `expires_at` 条件。

### 5.18 浏览器测试（E2E，独立测试用户，临时数据库）

1. 消费：选卡后三种推荐结果的预填（`exact_currency` 预填金额；`conversion_required` 必须选择扣款币种；`no_match` 手选）。
2. 跨币种待补录 → 待补录列表 → 补录金额 → 统计计入。
3. 本人调拨（两侧已登记、跨币种；一侧未登记，必须选择对手方法域且无预填）；第三方汇出与汇入（对方金额未知）。
4. 信息不足：商户国家未知 → 列表与总览显示"信息不足"，不在境内或境外中。
5. 纯境内：提交被拒，提示不属于境外金融活动；更正为纯境内时提示作废。
6. 事实更正、快照更正（展示旧值 → 新值及分类变化后确认）、作废；版本历史可查看。
7. 补录：已关闭币种需逐条确认；"保存时状态"标签；声明当时本国地区。
8. 响应丢失：拦截路由，在服务端提交后丢弃响应，界面自动以同一键重试 → 只有一笔交易，显示首次结果。
9. 删除被引用的账户、卡、渠道时提示"被 N 笔流水引用"。
10. 全页断言：不出现余额、汇率、换算金额或由差额推算的手续费；控制台无错误（除匿名 `/auth/me` 401）。

### 5.19 回归与准入

- 沿用 §0：v1 测试、旧版测试（`npm test`）、旧版与 v1 的 typecheck / lint / build 全部通过；R-1 鉴权遍历自动包含 `/transactions`；旧版数据库与 `.env` 指纹不变；不连接远程 D1。
- M2 全部既有用例保持通过；A-5、C-5 的"无金额列"扫描仍只针对 M2 表与 M2 DTO（交易金额属于 M3 交易 DTO，API_SPEC §1）。

### 5.20 列表与规范化搜索（LST，M3-B2，双环境，API_SPEC §5.3）

| ID | 场景 | 断言 |
|---|---|---|
| LST-1 | 排序与全序 | 同一天、同一时间（含 `occurredTime` 为空）、同一毫秒 `createdAt` 的多笔交易按 `id` 降序确定排列；`occurredTime` 为空的排在同日有时间的之后；多次请求顺序相同 |
| LST-2 | 无 `q` 的跨页 | `limit` 取 1、2、50、100：逐页取完后所有交易恰好出现一次、顺序与一次取全相同；除最后一页外每页恰好 `limit` 条；最后一页 `nextCursor = null`；排序值相同的交易恰好落在页边界时不重复、不遗漏 |
| LST-3 | `q` 的过滤后分页（Q6） | 匹配稀疏（例如每 300 笔候选中 1 笔匹配、跨越多批扫描）、匹配密集、匹配恰好 `limit` 条、`limit + 1` 条：每页恰好 `limit` 条匹配（最后一页除外），`nextCursor` 是本页最后一条**匹配**的排序键；逐页结果等于对全部交易做规范化过滤后的结果；没有匹配 → `{ items: [], nextCursor: null }`；最后一条匹配之后还有大量不匹配的候选 → 该页 `nextCursor = null`（不返回空的下一页） |
| LST-4 | 规范化匹配 | 全角（`ＷＩＳＥ`）、大小写、首尾与连续空白、NFKC 等价字符在商户名、对手方名称、备注中均能匹配；`%`、`_`、`\` 按字面；`q` 只匹配这三个字段，不匹配账户名、金额或 id |
| LST-5 | 筛选组合 | `q` 与 `type`、`accountId`、`currency`、`amountStatus`、`foreignStatus`、`recordMode`、`status`、`from` / `to` 组合时，结果等于各条件的交集；只依据当前版本（被取代版本的商户名不匹配，IMM-8） |
| LST-6 | 隔离 | 另一用户的交易即使匹配 `q` 也不出现；以他人的 `accountId` / `cardId` / `channelId` 筛选 → 200 空列表（ISO-4）；用另一用户分页得到的 `cursor` 只影响排序位置，结果仍只含本人数据 |
| LST-7 | 翻页期间数据变化 | 取得第一页后：新建一笔排序键在 `cursor` 之前的交易 → 后续页不出现它；新建一笔排序键在 `cursor` 之后的交易 → 在后续页中恰好出现一次；翻页期间排序键与匹配不变的交易全部恰好出现一次；修改备注使某交易不再匹配 `q` → 后续页不出现它，且其他交易不重复、不遗漏 |
| LST-8 | 参数校验 | `cursor` 无法解码或格式不合法（截断、非法编码、字段缺失、类型或日期格式错误）→ 400 `VALIDATION`；格式合法的任意 `cursor` 只决定排序位置（不要求签名），结果仍只含本人数据（LST-6）；`limit` 为 0、101、非整数 → 400；`from > to` → 400；未知参数（含"非境外"类参数）→ 400（REG-8） |
