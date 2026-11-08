# Qwen 输入阶梯及思考模式计费（2026-11-07）

本轮补齐[公开成本核对](provider-cost-review.md)发现的计价表达缺口。源码支持按请求输入长度选择档位，并区分思考/非思考输出价格；没有向正式业务库发布供应商价格，没有变更运营账户或启用收费服务。

## 配置与计量

共享定义位于 `src/platform/pricingDefinition.ts`，云端成本目录与原生客户端共用校验。原固定价格和 DeepSeek 峰谷价格继续使用原结构；新增 `tariff.kind=qwen-input-tiers`。

- `tariff.defaultThinking` 是未提供 `enable_thinking` 时的明确默认值，必须为布尔值。实际派发时写入该开关，显式传入的布尔值优先；不接受字符串 `"false"` 等隐式转换。
- `tariff.maxThinkingTokens` 填所选部署中模型公开的最大思考长度，用于授权预算，不能凭其他型号推断。不会据此注入新的思考长度参数、缩短现有模型思考或关闭思考；调用方显式提供的 `thinking_budget` 保留，但须为不超过已核定上限的非负整数。
- 三个计量项必须完整存在：未缓存输入、缓存输入、输出。各项分别有 `unitQuantity` 和 `tiers`；每档包含整数 `upToInputTokens` 与原币种 `price`，输出档另有必填 `thinkingPrice`，两种输出模式共用该项计价单位。零价必须明确填写。
- 三项使用相同、严格递增的边界；上限包含本数，下一档不重复包含上一档上限。最后一档必须覆盖路由完整输入上下文，不能为套用低价而缩短上下文。发布时还核对 Qwen / DashScope 供应商、Chat 协议及服务类型。
- 按上游实际输入总数（未缓存 + 缓存）选择整次请求的一档，而非将不同输入段累进计价。缓存折扣只影响缓存部分成本，不改变档位判断。输出用量使用供应商提供的完整输出计数，不重复追加已包含的思维链 Token。

该策略用于已核对 `enable_thinking` 语义的 Qwen Chat 部署，不能由价格策略名称推断所有 Qwen 型号、第三方部署或其他思考控制参数均已联调。实际账户、模式语义、缓存统计和模型上限仍须逐项核对。[百炼思考模式说明](https://help.aliyun.com/zh/model-studio/deep-thinking)

## 授权、结算和快照

Qwen 的 `max_tokens` 通常只限制回答，思维链另计；不能仅用回答上限冻结全部输出费用。思考模式的预算因此额外纳入已核定的最大思考长度；若调用方给出更小的思考预算，仍按核定上限保守授权。实际结算只使用供应商可核实用量。[百炼参数说明](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)

预算对所有可能到达的输入档取各计量项最大单价，不假定后续档位单价一定递增。缓存/未缓存的输入预算分别预留完整输入的可能性，选择档位时把它们视为同一输入上界，避免误将两个预算相加后跨档。原有整数微元、1.3 倍率、美元汇率及授权上限外成本由平台承担的规则保留。

调用固定保存整份价格定义、版本、汇率及本次实际派发的思考模式；结算用量追加 `priceTier`，记录实际输入总数、所选档位上限和模式。调用期间新增成本版本不改变已接受请求的快照。流式、一级备用及管理员平台承担的检测共用这一规则，备用仅按实际成功路由结算。

缺少缓存统计、用量不一致或实际输入超过最后一档时，不选择较便宜的档位或当作免费成功；按既有异常流程保留待核验状态。重放沿用原记录，不再次派发收费请求。

## 界面与客户端

后台成本表单增加“Qwen 输入阶梯与思考模式”，按档输入边界、三类单价及思考输出价，可增加/移除档位，保存完整成本版本并重载。默认模式、最大思考长度和各计价单位单独填写；错误边界在提交前给出提示，服务端仍独立校验。

Web / 桌面费用区域与 CLI 备用价格确认展示全部档位、思考输出价及思考长度预算，不将新定义压缩成第一档固定价格。原生目录校验保留完整结构；管理员检测说明区分回答上限与思考预算，完成结果可显示实际档位及模式。

## 验证记录与边界

- `output/checks/qwen-tiers-pure-final.log`：8 项通过。覆盖缓存跨档、边界包含关系、思考价、非单调价格预算、缺失/超界用量、美元换算、无效定义、原生目录及表单往返，包含显式零价。
- `output/checks/qwen-tiers-database-first.log`：执行结果为 9 项通过，但事后发现表定义在创建隔离 Schema 前已导入，实际写入开发库，**不能作为隔离测试通过的证据**。`ccagent_test_ec8ae0645fc77a3f` 曾被创建并删除，不能仅凭这个事实证明业务查询使用了它。修正后的独立测试文件及写入保护已按下节重新验证。
- `output/checks/qwen-tiers-regression-first.log`：原成本目录、业务网关、管理员检测三个相关文件共 40 项通过。这不是完整云端测试集，也不能与旧金融专项简单相加。
- `output/checks/qwen-tiers-native-final.log`：28 项原生客户端检查通过，包含新增 CLI 全档价格/思考预算确认；使用真实 HTTP、DPAPI 和引擎路径，供应商为合成响应。
- `output/checks/qwen-tiers-web-ui-first.log`：离线 Web DOM 检查通过，新增完整档位、思考价、预算及无 `undefined` 单价断言。
- 根项目及云端类型检查、`qwen-tiers-build-accessible.log` 的最终 Next 生产构建通过。React 检查覆盖控件标签/说明关联、必填/禁用状态、稳定行标识、受控输入及明确保存反馈；没有声称运行未配置的 ESLint。
- `output/checks/qwen-tiers-ui-ccagent_test_024ab00546f54b99-1209421d/report.json`：标签修正版真实 Chrome / Next / 数据库单轮 5 组通过，包括供应商变更暂停、重复边界提交前拒绝、完整版本保存/重载、模式改变后旧确认失效、窄屏及普通账户拒绝。追加 2 个测试价格版本，供应商请求为 0；停止回执确认资金流水、调用预留、订单、文件和检测开始/结果均为零，钱包余额/冻结为零。
- `output/checks/qwen-tiers-ui-ccagent_test_6bb9faefa295fb3c-bc1d4f4f/report.json`：加入表绑定保护及 cloud 独立 Zod 解析后的最新同源码单轮 5 组再次通过，供应商请求为 0。此轮没有沿用旧页面/构建；其 Schema、Next/TLS 进程、私有临时目录及启动日志按 `qwen-tiers-cloud-zod-ui-cleanup.json` 清理。重复五组不累加成十个不同场景。
- 浏览器前两次失败分别保留于 `qwen-tiers-ui-ccagent_test_9160b10e07e8498b-66da2b55`、`qwen-tiers-ui-ccagent_test_9160b10e07e8498b-60a78e44`。首轮验证器误将 datalist 控件当作 textbox；第二轮核实策略控件名称混入选项文字，新控件帮助文字也混入名称。现已修正选择器、明确可访问名称并用独立说明关联，在新的隔离环境完成上述最终五组。失败记录不算通过。
- `qwen-tiers-cleanup-final.json` 确认三组明确列出的测试 Schema 均已删除，活动查询/未结束事务为零，开发库仍为四个迁移。两次本机夹具均正常退出；`qwen-tiers-first-ui-cleanup.json`、`qwen-tiers-final-ui-cleanup.json` 确认私有临时目录、证书/密钥和启动日志已移除。检查器另报告 2 个 idle 后端，不把它们当作活动事务，也未终止其他连接。

测试价格与 Token 边界均为合成数据，不是供应商正式价。当前 Qwen 采购账户的权限/余额、部署地域、缓存/思考语义、商业约定和供应商账单仍待真实联调；本轮不认定正式可购买目录已就绪。受保护 Preview 已按下节更新，没有生成最终安装包；OpenAI 生图仍等待既有凭据选择。

桌面测试载荷已在核对 staging 目录位于工作区内且没有在运行的载荷进程后更新，`qwen-tiers-desktop-prepare.log` 确认 44 项资源、内置 Node 24.22.2 及凭据/配置排除。`qwen-tiers-desktop-test.log` 的既有载荷、授权、工作区、MCP、退出重启检查通过；该检查不扩大为新价格分支的全部 Electron 界面或正式安装/升级验收。桌面旧 EXE 未覆盖。

部署输入审查已将 `pricingDefinition.ts` 加入明确允许的第三个共享模块，缺少任一共享模块时拒绝通过。初次输入审查保留于 `qwen-tiers-deployment-inputs.json`；日历修正前 `qwen-tiers-deployment-inputs-final.json` 为 99 文件/461,861 字节，摘要 `a8029ed377a8cf804e529b32853418278bd463cfa29e2b0dc611926f2b6a2f4f`。最新 `tariff-clock-deployment-inputs.json` 为 99 文件/461,951 字节，摘要 `66b95c0b0ef5a9df8ab81dbba869a0cac1dcd1d932a8d0d617b0aed53c90f916`，凭据、本地数据及生成文件排除；该摘要与实际部署元数据一致。

新增共享校验模块依赖 Zod，本机根目录为 4.4.3、cloud 为 4.6.7。`qwen-tiers-cloud-dependency-check.json` 通过隐藏根目录依赖的解析探针复现缺包；现已在 cloud 的 TypeScript 路径与 Turbopack 别名中明确解析到 cloud 自身安装。`qwen-tiers-cloud-dependency-fixed.json` 证明隐藏根依赖后仍解析至 cloud Zod 4.6.7；`qwen-tiers-build-cloud-zod.log` 构建和 `qwen-tiers-cloud-zod-pricing.log` 的 8 项价格检查通过。最新源码随后完成 Vercel 独立无缓存构建与下述访问检查。

## Qwen 阶段受保护开发预览

本节保留 Qwen 与日历修正阶段的部署证据；后续当前最新开发部署见 [调用编号恢复](call-recovery-identifiers.md)。

2026-11-07 15:55（北京时间）部署 `dpl_s9UevhN9mkgsTJS2H5Ns2o9R6Qwv`，地址 <https://ccagent-cloud-7nygatwvm-lvye-1989s-projects.vercel.app>。目标为原 `ccagent-cloud` / `lvye-1989s-projects` 的 Preview，非生产；Next.js、Node 24.x、sin1，无缓存构建耗时 29.705 秒，状态 READY。`qwen-tiers-predeploy-target.json`、`qwen-tiers-deployment-command.json` 和 `qwen-tiers-deployment-final.json` 分别记录目标核对、命令结果和独立部署检查；本地未提交改动由源码摘要标识，没有把 HEAD 当作已提交完整变更。

`qwen-tiers-preview-check.log` / `qwen-tiers-preview-check.json` 的 11 项访问检查通过：未认证访问仍被 Vercel 保护，受信任检查下健康接口可用，账户、模型、后台、默认路由、连接检测和维护接口均拒绝未登录访问；账户页转登录，登录页正常，虚构不存在账户经真实数据库认证路径被拒绝。没有创建账户、发邮件、充值或派发供应商请求。该检查不扩大为正式管理员或已登录远端供应商验收。

刷新检查凭据时本地 Windows 命令引号曾形成无效路径，保留 `qwen-tiers-oidc-refresh-failure.json`；修正后检查通过。完整环境临时文件立即删除，只在子进程内存使用所需访问令牌，`cloud/.env.local` 未被覆盖。`qwen-tiers-oidc-access.json` 记录令牌未输出及本次临时文件已移除。没有改动保护策略、新建项目或发布生产版本。

## 测试表绑定失误与恢复

最终只读复查发现新增测试静态导入 `catalog`，间接将 Drizzle 表绑定到开发 Schema；之后创建临时 Schema 并改变环境变量没有改变已加载的表对象。因此一组合成账户、角色、Key、路由、成本、用量和流水进入开发库。首次 9 项执行结果保留，但隔离结论撤回。

已按唯一测试账户名称、`id@example.invalid`、两条明确路由及凭据配置名、六个请求编号和非现金资金来源逐项核实归属，再执行恢复。`qwen-tiers-quarantine.json` 记录该合成账户已禁用、所有会话和 Key 撤销、合成管理员角色移除、两条测试路由暂停；原有用户行未修改，复查没有其他用户文件、流水或调用被该测试清理路径触及。

没有删除或修改不可变资金流水、价格与审计历史。`qwen-tiers-reconciliation.json` 记录一个测试冻结被释放、剩余 934,495,600 微元非现金额度通过追加调整流水归零；该合成账户余额/冻结均为零，没有活动 Key、管理员、会话或待结算调用。保留的合成历史不能作为正式经营数据。

`qwen-tiers-development-after-recovery.json` 的最新开发库事实为 2 个用户（含上述禁用合成账户）、管理员 0、2 条已暂停的测试路由、5 个测试价格版本、订单 0、流水 14、调用 6，充值关闭。原有 1 个用户保留；首个正式管理员仍待明确指定。正式生产继续要求独立隔离环境，不将这批测试历史迁作经营数据。

修复将纯价格测试与数据库测试分成独立文件；数据库测试在隔离环境创建后才动态导入表和网关，并在首个写入前核对精确表 Schema。运行期 `database()` 也校验导入时表绑定与当前目标 Schema 一致，不一致时直接拒绝数据库访问。另增加故意提前导入的负例，避免仅凭建表/删除回执判定隔离成功。

`qwen-tiers-isolated-verified.log` 的 18 项全部通过：1 项提前导入拦截、9 项真实隔离网关/账本、8 项价格及解析。正例明确记录表绑定与 `ccagent_test_d1934f4b56813e1d` 一致，运行身份为受限角色，并证明开发库 13 张表完整行摘要前后相同；负例 `ccagent_test_ee3b6b6d3b66f434` 未发起应用查询。`qwen-tiers-isolated-cleanup.json` 确认两者已清理，无活动查询或未结束事务。

加入保护后的完整云端测试集已结束：`cloud-full-pricing-guard.log` 为 170 项通过、零失败/取消/跳过，耗时约 37 分钟。覆盖认证、权限、账本、支付模拟、实际私有 Blob、目录、网关、备用、管理员检测及运行维护；模型、搜索和语音供应商为合成响应，没有真实支付或邮件。该轮 Qwen 表绑定与 `ccagent_test_ef4d28f8a31797db` 一致，开发库 13 张表完整行摘要仍未改变；提前导入负例 `ccagent_test_e11f424dc81fb253` 在应用查询前拒绝。`pricing-guard-full-cleanup.json` 确认这两个明确 Schema 已清理，无活动查询、未结束事务或残留 idle 后端，开发库迁移数仍为四。该清理回执只针对列出的两个 Schema。

`qwen-tiers-file-recovery.json` 补充核对误写批次的六个结果文件：仅对已核实归属的路径执行真实 Blob HEAD，六个对象均不存在；随后将这六行元数据标为已清理并追加审计，保留调用引用和历史。没有删除其他用户对象或修改其他用户行。

## 北京时间价格日历修正

完整回归结束前新增的独立年界用例复现 DeepSeek 日历年份按 UTC 判定的问题：北京时间新年已到但 UTC 仍在上一年时，新日历被误拒绝，旧日历又延后八小时失效。现在年份、星期、小时和假日统一使用北京时间，旧年份日历在北京时间 1 月 1 日零点立即失效；并未改变峰谷时段或为过期年份推算假日。

`tariff-clock-before.log` 保留修复前 2 项失败、1 项通过；修复后 `tariff-clock-after.log` 的 16 项通过，包含三项新年界/工作日用例及原价格、协议解析检查。`tariff-clock-database-regression.log` 的目录及备用相关 29 项全部通过，验证真实数据库中跨年失效会在派发前释放授权、不发供应商请求、不计费；`tariff-clock-build.log` 构建通过。三项新用例不在先前已开始的 170 项枚举内，16 项和 29 项也有重叠，不相加成新的全量数量。
