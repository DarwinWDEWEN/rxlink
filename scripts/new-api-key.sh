#!/usr/bin/env bash
# 生成一条控制台用的 API key：明文只打印这一次，库里只存 sha256。
# 用法：scripts/new-api-key.sh <name> [--expires-at <ISO8601>]
# 依赖：supabase CLI（走 --db-url）、openssl、shasum；凭据从 supabase/functions/.env 读。
set -euo pipefail

name=''
expires=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expires-at)
      expires=${2:-}
      shift 2
      ;;
    --expires-at=*)
      expires=${1#*=}
      shift
      ;;
    *)
      name=${1:-}
      shift
      ;;
  esac
done

if [[ ! "$name" =~ ^[A-Za-z0-9_-]{1,40}$ ]]; then
  echo "usage: $0 <name> [--expires-at <ISO8601>]   (name: 字母/数字/下划线/连字符，1-40 字)" >&2
  exit 2
fi
if [[ -n "$expires" && ! "$expires" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}([T\ ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$ ]]; then
  echo "invalid --expires-at: $expires（期望 ISO8601，例如 2027-01-01T00:00:00Z）" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/.." && pwd)
set -a
# shellcheck disable=SC1091
source "$root/supabase/functions/.env"
set +a
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL missing in supabase/functions/.env}"

key="rxl_$(openssl rand -hex 24)"
hash=$(printf '%s' "$key" | shasum -a 256 | awk '{print $1}')

if [[ -n "$expires" ]]; then
  # 再让 PG 校验一次时间语义（比如 2 月 30 日）；非法输入在这里就报错，不会拼进 insert
  supabase db query --db-url "$SUPABASE_DB_URL" --agent=no -o csv \
    "select '$expires'::timestamptz is not null" >/dev/null
  sql="insert into api_key (key_hash, name, expires_at) values (decode('$hash','hex'), '$name', '$expires'::timestamptz) returning id::text as id"
else
  sql="insert into api_key (key_hash, name) values (decode('$hash','hex'), '$name') returning id::text as id"
fi

supabase db query --db-url "$SUPABASE_DB_URL" --agent=no -o csv "$sql"

if [[ -n "$expires" ]]; then
  printf '\nAPI key（只显示这一次，请立即保存；过期时间 %s）:\n%s\n' "$expires" "$key"
else
  printf '\nAPI key（只显示这一次，请立即保存）:\n%s\n' "$key"
fi
