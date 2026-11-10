# 【通知】AnalyticDB PostgreSQL 版 Supabase 商业化

> 来源：https://help.aliyun.com/zh/analyticdb/analyticdb-for-postgresql/product-overview/notice-analyticdb-postgresql-supabase-is-commercialized
> 存档日期：2026-10-28

自 **2025 年 12 月 11 日**起，云原生数据仓库 AnalyticDB PostgreSQL 版 Supabase 正式上线并进入商业化阶段。

## 商业化时间

2025 年 12 月 11 日

## 商业化影响

提供付费版项目，支持多种计算资源和存储资源规格。收费明细见[控制台订购页](https://common-buy.aliyun.com/?commodityCode=gpdb_supabase_public_cn&regionId=cn-hangzhou)。

## 免费版与付费版对比

| 功能 | 免费版 | 付费版 |
|---|---|---|
| **产品规格** | 1C2G<br>**重要**：免费项目仅用于开发测试，请勿在生产环境下使用。 | 按需选择 |
| **文件存储** | 存储在云盘（免费版 1 GB 大小） | 存储在阿里云对象存储（OSS）私有 Bucket 中，按量付费 |
| **升配/降配** | 不支持 | 支持计算资源规格升降配 |
| **imgproxy** | 不支持 | 2C4G 规格以上实例支持 |
| **磁盘扩容** | 不支持 | 支持按需扩容 |

## 相关文档

创建 Supabase 项目见 [Supabase 章节主页](https://help.aliyun.com/zh/analyticdb/analyticdb-for-postgresql/supabase/)。

## 对本项目的含义（分析，非文档原文）

1. **P0 验证阶段用 1C2G 免费版足够**：跑 probe 函数、pg_cron、UNLOGGED 表这几项都不吃规格。但免费版云盘只有 1 GB 且不可扩容，**别在免费版上做压测或灌访问日志数据**，量一大就顶到磁盘上限。
2. **上线必须切付费版**，文档明确禁止生产使用免费项目。付费版才支持计算规格升降配、OSS 存储、按需磁盘扩容——短链平台的访问明细表会长得很快，磁盘扩容与 OSS 是刚需，成本要按付费版口径估算。
3. 订购页带 `regionId=cn-hangzhou`，说明是按地域购买的；地域选择要和短链域名的备案/加速区域决策联动（内地需备案、港澳海外免备案但影响内地延迟），见 `custom-domain.md`。
