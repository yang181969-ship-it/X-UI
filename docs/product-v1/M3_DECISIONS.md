# X-UI Product v1 — M3 设计决定记录（M3_DECISIONS）

> 状态：M3 设计已写入四份正式规格（2026-11-04），等待规格落盘复审；**尚未授权**编写 M3 业务代码、数据库迁移或提交。（定稿时的状态；当前实施状态：M3-B1 – B4 已完成并提交，M3-B5 已实现并验收、等待复审与提交，见各规格的状态行与 §8、§9。）
> 正式规格：[PRODUCT_SPEC.md](PRODUCT_SPEC.md) §2（D20–D28）、§7 · [DATA_MODEL.md](DATA_MODEL.md) §10 · [API_SPEC.md](API_SPEC.md) §5 · [TEST_PLAN.md](TEST_PLAN.md) §5。本文件只记录决定与来源，不重复规格内容；两者不一致时以正式规格为准。

## 1. 来源与优先级

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | M3-A.2 最终修订报告 | 最新设计基础：完成态幂等键行与 create / correct / void 写入链、三态地域分类、删除守卫与用户级联、备注与补录语义 |
| 2 | M3-A.1 补强报告 | M3-A.2 未覆盖的细节：确定性重放、分段求和、发布时分类验证、Entry 不变式、补录与已关闭币种、四类修改、转账 Event 金额含义 |
| 3 | M3-A 原始设计报告 | 以上均未覆盖的细节：交易头 / Event / Entry 三层、表与索引骨架、API 路径、转账方式枚举 |
| — | ChatGPT 对三轮设计的独立复审及边界澄清 | 批准核心架构 |
| — | 用户批准 | P1–P9 全部采用推荐方案 |

## 2. 用户批准的产品决策（P1–P9）

| # | 决定 | 落盘位置 |
|---|---|---|
| P1 | 定稿 Q1–Q7（见 §3）与 K1–K8（见 §4） | PRODUCT_SPEC D20–D24、§7.2–§7.5；DATA_MODEL §10.3、§10.4、§10.7.1；API_SPEC §1、§5 |
| P2 | **拒绝已确认的纯境内交易**（包括更正、快照更正后的新版本）；信息不足（`undetermined`）可以保存，不视为境内 | PRODUCT_SPEC D23、§7.4；DATA_MODEL §10.7.3 C7、§10.8.2；API_SPEC §5.1 `CONFIRMED_DOMESTIC`、§5.4、§5.7；TEST_PLAN REG-4、REG-5 |
| P3 | 第三方汇款的对方法域允许未知，按三态规则归入 `foreign` 或 `undetermined` | PRODUCT_SPEC §7.4；DATA_MODEL §10.7.1、§10.8；TEST_PLAN REG-1、REG-3 |
| P4 | 历史补录可声明当时的本国地区（`user_declared`），与当前设置无关 | PRODUCT_SPEC D25、§7.6；DATA_MODEL §3.0（例外标注）、§10.3.2；API_SPEC §5.4 `declaredHomeRegion`；TEST_PLAN HRD |
| P5 | 允许逐笔、显式、必须填写原因的快照更正（`home_region`、账户法域快照）；不提供批量 | PRODUCT_SPEC D24、§7.5；DATA_MODEL §3.0（例外标注）、§10.9.2；API_SPEC §5.7；TEST_PLAN COR-3 |
| P6 | "当前 / 补录"由用户声明，不按日期强制判定 | PRODUCT_SPEC §7.6；DATA_MODEL §10.9.4 R1；TEST_PLAN BF-8 |
| P7 | 已关闭币种只在"补录 + 逐条确认"或"更正时沿用同账户同币种 Entry"时可用 | PRODUCT_SPEC §6.1 第 5 条（例外标注）、D25、§7.6；DATA_MODEL §8（说明）、§10.9.4 R3、`en_closed_currency`；API_SPEC §5.1、§5.4；TEST_PLAN M3-10（标注）、BF |
| P8 | 第三方汇入且对方金额未知时，Event 金额可以为空 | PRODUCT_SPEC D26、§7.3；DATA_MODEL §10.3.1、C5；API_SPEC §5.4；TEST_PLAN AMT-7 |
| P9 | 备注不属于交易事实，不进入版本体系，不保留修改历史 | PRODUCT_SPEC D28、§7.5；DATA_MODEL §10.2；API_SPEC §5.9；TEST_PLAN COR-7 |

## 3. 已定稿的 Q1–Q7

| # | 决定 | 规格 |
|---|---|---|
| Q1 | 未登记的本人账户可以作为转账的一侧（以其法域描述，不生成 Entry） | D21 |
| Q2 | 第三方汇款同时支持汇出与汇入 | D20 |
| Q3 | 允许不同账户之间的跨币种调拨；禁止同一账户内换币 | D22 |
| Q4 | 商户国家允许未知 | D23 |
| Q5 | 已关闭币种受控使用（细化为 P7） | D25 |
| Q6 | 纳入商户退款 | D20 |
| Q7 | 不提供作废交易的永久删除 | D24 |

## 4. 对 M2 冻结条文的解释与例外（K1–K8）

| # | 冻结条文 | 定稿处理 |
|---|---|---|
| K1 | D5"流水金额只记入一个真实资金来源账户" | 解释为每条 Entry 只对应一个账户；本人调拨可有一出一入两条 Entry |
| K2 | DATA_MODEL §8.2 `funding_*` 字段名 | 保留字段名，另加 `direction`；`in` 方向时指入账账户与币种 |
| K3 | PRODUCT_SPEC §6.1 第 5 条"有效币种" | 按 P7 受控例外；当前交易仍须有效币种 |
| K4 | API_SPEC §1"所有 DTO 不含金额" | 限定为 M1 / M2 DTO；M3 交易 DTO 含交易金额，仍不含余额、汇率、换算金额 |
| K5 | DATA_MODEL §8 两层结构与"暂称" | 增加交易头 `transactions`；Event 按版本保存、不可修改；表名沿用 |
| K6 | DATA_MODEL §3.0"保存时"的 `home_region` | 指首次录入；更正沿用；只有 P4 声明与 P5 快照更正例外 |
| K7 | D2 不做手工换汇 | 同一账户内换币由唯一索引禁止；跨账户跨币种允许，不保存汇率 |
| K8 | D6"四种地区" | 新增转账对手方法域 `counterparty_country`，定义与 D7 相同，同样独立 |

## 5. 已被取代、不得作为实施依据的早期设计

| 早期设计（出处） | 定稿 |
|---|---|
| 二态 `is_foreign`（M3-A、M3-A.1） | 三态 `foreign_status`：`foreign` / `domestic` / `undetermined` |
| 允许保存纯境内交易（M3-A N14） | 拒绝已确认纯境内（P2） |
| 先插入认领行（`claim_token`、`ON CONFLICT DO NOTHING`）、最后再更新（M3-A、M3-A.1） | 键行只在最后一步插入一次，插入时即为完成态，之后不可修改（M3-A.2） |
| 所有幂等键保留 30 天（M3-A） | 新建键永久保留；更正、作废键 30 天 |
| 重放交易的当前状态（M3-A） | 重放首次成功操作的不可变结果 `TransactionWriteResult`（M3-A.1） |
| 预读值守卫（M3-A） | 快照只由 SQL 写入并由来源触发器校验，分类由发布检查 C6 验证（M3-A.1） |
| 直接 `CAST(SUM(amount) AS TEXT)`（M3-A） | 分段求和 + `CAST AS TEXT` + BigInt 合并（M3-A.1） |
| 备注在 Event 上（M3-A） | 备注在交易头，不进入版本体系（M3-A.1、P9） |
| `event_amount` 一律必填（M3-A） | P8 边界内可空 |
| `transfer_scope` 5 个值 / 加 `counterparty_unknown`（M3-A、M3-A.1） | 9 个值（M3-A.2） |
| 写操作响应带 `warnings`（M3-A §6） | 前端提交前计算提示；写入结果不含提示（保证重放确定） |
| 可选的 `replaces_transaction_id`（M3-A.1） | 未采用；类型录错时作废后新建 |

## 6. 落盘时的细化（供规格复审核对）

以下内容不是新的产品决定，而是为使已批准的设计在规格中自洽而写明的实施细节：

1. 发布检查改称 **C1–C7**（M3-A.1 / M3-A.2 中称 P1–P7），避免与产品决策 P1–P9 混淆；内容不变，原 P4 记为 C4（插入时已保证）。
2. 新增触发器 `ev_kind_guard`、`en_kind_guard`：在数据库层保证"补录金额只改金额、快照更正只改快照"（M3-A.2 已定义这两类修改的语义）。
3. `home_region_source` 的行级 CHECK（各来源允许出现的版本与模式），以及 `country_source = 'carried'` 必须有 `carried_from_entry_id`。
4. 新建交易的 `recordMode` 缺省为 `current`；`declaredHomeRegion` 只在补录时可填。
5. 错误码名称：`CLOSED_CURRENCY_ACK_REQUIRED`、`CONFIRMED_DOMESTIC`（`details.suggestion = 'void'`）；列表响应为 `{ items, nextCursor }`。
6. 文本长度沿用 M2 约定（名称类 1–80、原因类 ≤ 200、备注 ≤ 1000）。
7. 分类版本升级：v1 不提供升级操作；将来引入新版本时只能经单笔显式快照更正，请求形式届时另行设计。
8. Entry 沿用的一致性（提交前最终核对时补充）：`(carried_from_entry_id IS NULL) = (country_source = 'account_at_save')` 行级 CHECK，以及 `en_snapshot_source` 拒绝"上一版本有同账户的 Entry 却未沿用"（M3-Freeze 最终补强时把对应关系由"同方向、同账户"改为"同账户"：否则只改方向的事实更正仍会重新读取当前法域；每个版本一个账户至多一条 Entry，对应关系唯一）。原因：否则事实更正可以对账户未变的 Entry 以当前账户法域重新取快照，构成未经快照更正的重分类，违反 D24 / K6。同时在 §10.7.3 写明补录金额与快照更正的 Entry 条数如何由既有约束保证。
9. warnings 的边界（API_SPEC §5.13）：提示只用于录入时参考，不保存、不重放、不作校验依据；业务约束全部由服务端与数据库执行。
10. 交易头守卫（M3-Freeze 最终补强）：新增 `tx_insert_guard`（只能以 `current_revision = 0`、`active`、无作废信息插入，`LEDGER_HEADER_INSERT`）；`tx_update_guard` 明确为不带 `OF` / `WHEN`、每条 UPDATE 都执行，并规定错误码顺序；五个发布触发器加上与形态 ② 相同的 `WHEN`，只在合法的 r → r+1 发布时执行（DATA_MODEL §10.7.2、§10.7.3；TEST_PLAN IMM-10、IMM-11）。
11. 未发布残留（M3-Freeze 最终补强）：正常 API 的原子 batch 不会留下残留；原始 SQL 造成的残留属于异常数据库状态，普通 API 不提供删除或修复入口，只能经离线维护流程（备份、核对引用、审核后修复、完整性检查）恢复；不放宽不可变与删除守卫，v1 不开发恢复工具（DATA_MODEL §10.11）。

## 7. 验证状态

- 已在**内存 libSQL** 上做过探针：`SUM` 溢出与分段求和、`typeof` 整数 CHECK、部分唯一索引、键字符集 GLOB、发布分类触发器、NOT NULL 断言回滚、删除守卫与用户级联共存。
- **本地 D1 尚未验证任何一项**；M3-B1 必须完成 DATA_MODEL §10.13 / TEST_PLAN DB-M3-0 的全部探针，任一项不成立即停止并报告。

## 8. M3-B3 决定索引（Q-B3-1 – Q-B3-12）

M3-B3-A 只读分析提出的 12 个实施问题，经复审**全部按推荐方案批准**，并在 M3-B3-B.0 写入三份正式规格（2026-11-04）；B3-B、B3-C 据此实施，B3-D 完成验收（2026-11-05）。本节只是索引：规范性依据仍是 API_SPEC、DATA_MODEL、TEST_PLAN 中所列条文，二者不一致时以正式规格为准；它们不改变 P1–P9 或任何产品规则。§7 与文首状态行记录的是定稿时的状态，当前实施状态见三份规格的状态行。

| # | 最终批准的决定 | 规范性条文 |
|---|---|---|
| Q-B3-1 | 更正请求不含 `type`：事实更正的 `ENTRY_SHAPE` 按已保存的交易类型判定，位于幂等查找与 404 → `TRANSACTION_VOIDED` → `REVISION_CONFLICT` 之后；同一键已成功使用后再提交形状违规的事实更正 → 409 `IDEMPOTENCY_CONFLICT` | API_SPEC §5.0.3、§5.1、§5.7.1；TEST_PLAN IDEM-13 |
| Q-B3-2 | 更正 / 作废键在 `expires_at <= now` 时逻辑过期：查找视为不存在（不重放、不冲突）；每个财务写请求只读一次 `now`，键查找、S0、新键行时间与受控重试共用；物理删除只由该用户下一次写入的 S0 执行，键能否重新使用由 S0、门控 G 与主键决定；batch 后仍读到过期旧行 → 500 | API_SPEC §5.0.3、§5.8；DATA_MODEL §10.5、§10.10；TEST_PLAN IDEM-8、IDEM-14 |
| Q-B3-3 | 补录金额与快照更正沿用上一版本的 `closedCurrencyAck`，并按保存时币种状态规范化（`active` → 0）；同账户同币种的沿用在任何 `recordMode` 下都不要求确认；同账户换为另一已关闭币种按新建规则处理 | API_SPEC §5.7.2；DATA_MODEL §10.4、§10.9.2、§10.9.4 R3；TEST_PLAN COR-1、COR-9、BF-4 |
| Q-B3-4 | `TRANSACTION_VOIDED` 优先于 `REVISION_CONFLICT`，写入前检查与 batch 后的重新判定相同 | API_SPEC §5.1、§5.7.1、§5.8；DATA_MODEL §10.10；TEST_PLAN COR-5 |
| Q-B3-5 | 事实更正的 `recordMode` 必填，不使用新建时的缺省值 | API_SPEC §5.7；TEST_PLAN COR-2 |
| Q-B3-6 | 事实更正"无变化"的冻结定义：Event 事实字段与 Entry `(direction, accountId, currency, amountStatus, amount)` 的集合；`reason`、`closedCurrencyAck`、快照、小数位、分类与当前名称不参与 → 400 `VALIDATION`（单条 zod issue，`path: []`） | API_SPEC §5.7.1、§5.7.3；TEST_PLAN COR-2 |
| Q-B3-7 | `GET /transactions/:id/revisions/:revision` 的参数须为规范十进制正整数，否则 400（只依赖请求，先于 404，他人交易同样）；格式合法但不可见 → 404 | API_SPEC §5.6；TEST_PLAN COR-8 |
| Q-B3-8 | 受控重试只适用于事实更正：`LEDGER_CLASSIFICATION` 比较新账户（`account_at_save`）的法域，`LEDGER_CLOSED_CURRENCY` 比较不属于同账户同币种沿用的 Entry 的币种状态；来源未变 → 500；补录金额、快照更正与作废不重试 | API_SPEC §5.7.4；DATA_MODEL §10.10；TEST_PLAN CC-8、CC-9 |
| Q-B3-9 | 依赖上一版本的补录金额 / 快照更正错误为 400 `VALIDATION`，沿用 zod issue 结构，`path` 指向请求字段 | API_SPEC §5.7.1；TEST_PLAN IDEM-13、COR-3 |
| Q-B3-10 | 备注提交相同值仍写入并更新 `updatedAt`；`""` 原样保存，`null` 清除；未发布交易头 → 404 | API_SPEC §5.9；TEST_PLAN COR-7 |
| Q-B3-11 | 补录金额与快照更正复制上一版本的小数位；事实更正按当前 ISO 4217 表写入 | API_SPEC §5.7.2；DATA_MODEL §10.9.2；TEST_PLAN COR-1、COR-10 |
| Q-B3-12 | B3 分 B3-B（作废、备注、版本查看与公共幂等流程）、B3-C（三种更正）、B3-D（横向加固与文档）三个关卡，各自复审；任何一步都不修改 `0000` – `0002`、不新增 `0003` | TEST_PLAN §5.21 |

## 9. M3-B5 决定（统计与总览，2026-11-05）

M3-B5-A 只读分析提出的问题经复审与用户批准，在 M3-B5-B 实施。规范性条文见 API_SPEC §5.10；不改变 P1–P9、D1–D28 或 PRODUCT_SPEC §7.7 的统计口径，不修改 `0000` – `0002`、不新增 `0003`。

| # | 最终批准的决定 | 规范性条文 |
|---|---|---|
| Q2 | `TransactionSummaryDto` 增加 `transactionCount` 与 `pendingTransactionCount`：服务端 `COUNT(DISTINCT 交易)`，范围同统计（`active`、当前版本、日期 / `type` / `currency` 筛选）；前者为至少有一条符合条件 Entry 的交易，后者为至少有一条符合条件 `pending` Entry 的交易；不得由各组 `count` 相加得出 | API_SPEC §5.10 |
| — | `from` / `to` 包含当天；`currency` 只筛选该币种的 Entry；`homeRegions` 包含只有待补录 Entry 的交易 | API_SPEC §5.10 |
| — | 总览：默认期间为本年；不显示每账户统计、趋势图、净消费或任何跨币种合计；已确认境内块只显示一行说明；同一块 × 类型 × 方向 × 币种 × 小数位内的细分组在页面上用 BigInt 合并显示，展开可见明细 | PRODUCT_SPEC §7.7、§7.10（不变） |
