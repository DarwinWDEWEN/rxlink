-- 0007：把 short_url 的 link_version 触发器从「语句级」改为「行级」。
--
-- 起因（2026-11-09 线上实测）：语句级 after 触发器即使 UPDATE 命中 0 行也会触发，
-- 于是 prune_dead_links(180, true) 的 dry-run 每天把 seq 白白 +1，逼所有 FC 实例重拉全量快照。
-- 本想用 transition table 判断「是否真有行」，但本平台拒绝：
--   ERROR 0A000: transition tables cannot be specified for triggers with column lists
-- 故按评审稿 §4 的兜底方案退回行级触发器：
--   - UPDATE OF 列清单在行级上只对「真的更新了这些列的行」触发（visits_count/last_visit_at 不在清单里）；
--   - 0 行语句不触发；批量更新 N 行会 +N，seq 只需「不同」，不影响失效判定。
drop trigger if exists link_version_after_write on short_url;

create trigger link_version_after_write
after insert or delete or update of
  short_code, domain_id, long_url, forward_query, enabled, valid_since, valid_until, max_visits
on short_url
for each row
execute function bump_link_version();
