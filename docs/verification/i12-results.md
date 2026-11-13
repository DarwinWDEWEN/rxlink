# I12 —— 控制台中文化 验证记录

> 执行日期：2026-11-13。通道：Node 24（`/Users/wang/.nvm/versions/node/v24.14.0/bin`）、Vite 8、Playwright 1.64.1、Deno 2.9.7。
> 状态：**构建期字面量替换已落地并验收；控制台产物已出中文包**（线上替换见 §6 遗留）。
> 设计：`docs/superpowers/specs/2026-11-13-console-i18n-design.md`；实施计划：`docs/superpowers/plans/2026-11-13-console-i18n.md`。

## 1. 方案与产物

一个 vite 插件（`scripts/i18n/vite-plugin-i18n.mjs`）在 `transform` 阶段把 `@shlinkio/*/dist/**` 与 `shlink-web-client/src/**` 里的英文字面量按 `scripts/i18n/zh-CN.json` 替换成中文；`buildEnd` 按 `expected.json` + `expected.src.json` 校验每条文案的实际替换次数，不符则构建失败。运行时零开销、零 fork。

| 文件 | 内容 |
|---|---|
| `scripts/i18n/zh-CN.json` | **301 条**中英对照（上游 236 + src 新增 65，去重后 301） |
| `scripts/i18n/expected.json` | 上游基准：**236 条 / 305 处** |
| `scripts/i18n/expected.src.json` | src 基准：**72 条 / 82 处** |
| `scripts/i18n/gen-expected.mjs` | 生成/刷新上述两个基准（上游扫描 + src 扫描） |
| `scripts/i18n/replace-literals.mjs` | 替换核心：完整引号字面量（双/单引号），保持原引号风格 |
| `scripts/i18n/vite-plugin-i18n.mjs` | vite 插件 + `buildEnd` 断言 |
| `scripts/i18n/test/replace-literals.test.mjs` | 单测 **12 例** |

> 只翻界面文案；国家名 / 浏览器名 / OS 名等数据值保留英文（`KEEP_EN` 21 条 + `objRe` 识别的大对象值）。逻辑 key（`ASC`/`DESC`/`Card.Body` 等 38 条）不进字典。

## 2. 构建断言

| 构建 | 命令 | 结果 |
|---|---|---|
| 中文（默认） | `npm run build` | **exit 0**；`buildEnd` 断言通过（301 条全部命中预期次数） |
| 英文（回退） | `npm run build:en` | **exit 0**；产物 **0 处中文** |

产物级抽样（中文包 `build/assets/index-*.js`）：

| 断言 | 计数 | 结果 |
|---|---|---|
| `保存` | 13 | ✅ |
| `删除` | 15 | ✅ |
| `欢迎！` | 1 | ✅ |
| `添加服务器` | 3 | ✅ |
| `管理服务器` | 1 | ✅ |
| 301 条字典值是否全部出现在产物 | 301 / 301 | ✅ |

英文包渲染实测（Playwright）：`Settings` / `Servers` / `Welcome!` / `This application will help you manage your Shlink servers.` / `Add a server` / `Learn more about Shlink` —— 与原版一致。

## 3. 浏览器实测（中文包）

`npx vite preview --port 4173` + Playwright 提取 `document.body.innerText`：

| 路由 | 渲染文本（节选） |
|---|---|
| `/` | 设置 / 服务器 / **欢迎！** / 本应用用于管理你的 Shlink 服务器。/ **添加服务器** / 进一步了解 Shlink / 客户端： latest |
| `/manage-servers` | **导入服务器** / **添加服务器** / 名称 / 基础 URL / 选项 / **未找到服务器。** |
| `/server/create` | **添加新服务器** / 名称\* / URL\* / API 密钥\* / **高级选项** / 从文件导入 / **创建服务器** |
| `/server/create`（展开高级选项） | 每次请求都向该服务器转发凭据。/ “凭据”指 cookie、TLS 客户端证书，或包含用户名和密码的认证头。/ **重要！** 如果你不确定这意味着什么，请保持未勾选。启用该选项会导致所有请求对低于 v4.5.0 的 Shlink 失败，因为它要求服务器为 Access-Control-Allow-Origin 设置比 \* 更严格的值。 |
| `/this-route-does-not-exist` | **抱歉！找不到请求的页面。** / 使用浏览器的返回按钮回到之前的页面，或者直接点击下方按钮。/ **首页** |

截图：[i12-home](assets/i12-home.png) / [i12-manage-servers](assets/i12-manage-servers.png) / [i12-create-server](assets/i12-create-server.png) / [i12-not-found](assets/i12-not-found.png)。

> 内联格式保留：`<b>重要！</b>`、`<code>Access-Control-Allow-Origin</code>`、`<b>name</b>`、`<Link>移除它</Link>` 等均按原样渲染，只是文本被替换。

## 4. 单元测试

`node --test scripts/i18n/test/replace-literals.test.mjs` → **12 passed | 0 failed**。

覆盖：完整字面量替换、不替换子串、多处计数、中文含双引号/单引号转义、中文含反斜杠、字典外保留、空字典、尾随空格精确匹配、**单引号字面量替换**（oxfmt 默认单引号）、双/单引号分别计数、保持原引号风格。

> 踩坑：`String.replace` 的字符串模式只替换**第一处**，中文文案含多个引号时会漏转义 → 改用 `split/join`。单测第 4 例抓住了这个 bug。

## 5. 兼容层回归

`/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/compat.test.ts supabase/functions/compat/test/title-resolver.test.ts` → **117 passed | 0 failed**。

中文化只碰控制台构建链，兼容层与跳转函数未动，回归全绿。

## 6. 测试汇总

| 套件 | 用例数 | 结果 |
|---|---|---|
| `scripts/i18n/test/replace-literals.test.mjs` | 12 | ✅ 全绿 |
| 中文构建断言（301 条） | 301 | ✅ 全绿 |
| 英文构建（无中文） | — | ✅ |
| `compat.test.ts` + `title-resolver.test.ts` | 117 | ✅ 全绿 |
| **合计** | **430** | ✅ |

## 7. 遗留与口径

1. **线上控制台仍是英文包**：`console.example.com` 由 FC 函数 `console-prod` 托管，需要把 `shlink-web-client/build/` 重新打包上传才会显示中文。本机构建产物已就绪（`dist/console.zip` 待重打）。
2. **`<html lang="en">` 未改**：这是文档属性，不是界面文案，按「只翻界面」口径未动。
3. **短 key 风险**：` or ` / ` than ` 等 6 键以空格包裹的短文案已确认在 src 与上游各只出现 1 次且都是 UI 文本；`, ` / ` - ` / `?` / `.` / `*` 等更短的 key 一律不进字典（会误伤代码），改用全角标点字面量直接写在源码里。
4. **oxfmt 引号风格**：仓库格式化器强制单引号，插件已同时匹配双/单引号并保持原风格；`<Icon /> {'文本'}`（表达式前加空格）可避免 oxfmt 拆行导致空格丢失。
5. **不做运行时语言切换**：默认构建即中文，`build:en` 出英文原版作回退（YAGNI）。
6. **上游升级**：先跑 `node scripts/i18n/gen-expected.mjs` 刷新基准，再补字典；断言会拦住漏翻。
