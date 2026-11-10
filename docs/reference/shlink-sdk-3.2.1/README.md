# shlink 客户端契约存档（@shlinkio/shlink-js-sdk 3.2.1）

这四个文件是 npm 包 `@shlinkio/shlink-js-sdk@3.2.1` 的**逐字节副本**，不是我们改写的。

| 文件 | 原路径 | 作用 |
|---|---|---|
| `ShlinkApiClient.d.ts` | `dist/api/ShlinkApiClient.d.ts` | 23 个方法的签名（`grep -c` 数出 24 行，其中一行是 `constructor`） |
| `types.d.ts` | `dist/api-contract/types.d.ts` | 40 个请求/响应类型，209 行 |
| `errors.d.ts` | `dist/api-contract/errors.d.ts` | 12 个 `ErrorType` 常量 + `ProblemDetailsError` |
| `index.js` | `dist/index.js` | 实现：URL 拼接、query 序列化、请求头（5 KB minified） |

来源与校验：

- tarball：`https://registry.npmjs.org/@shlinkio/shlink-js-sdk/-/shlink-js-sdk-3.2.1.tgz`
- integrity：`sha512-XtgiOsJfpGhGN2MyZJ4gy2zqgzHS70z/36M+ceKpVgNzhevHXU0QVIcpE7JGixnqHBqRVn8dI5O3L1DMgSnIIQ==`
- 许可证：MIT
- 取数方式：`shlink-web-client/package-lock.json` 里 lock 到 3.2.1，`npm ci` 后从 `shlink-web-client/node_modules/` 复制（2026-11-09）。

为什么要存档：`node_modules` 不进版本库、上游随时会发新版。兼容层实现和评审以此目录为准；升级 SDK 时先换这四个文件，再跑一遍 `docs/shlink-api-contract.md` 的验收清单。

字段级说明见 `docs/shlink-api-contract.md`。
