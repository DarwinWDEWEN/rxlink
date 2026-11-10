#!/usr/bin/env bash
# 生成一条控制台用的 API key：明文只打印这一次，库里只存 sha256。
# 用法：scripts/new-api-key.sh <name>
# 依赖：supabase CLI（走 --db-url）、openssl、shasum；凭据从 supabase/functions/.env 读。
set -euo pipefail

name=${1:-}
if [[ ! "$name" =~ ^[A-Za-z0-9_-]{1,40}$ ]]; then
  echo "usage: $0 <name>   (name: 字母/数字/下划线/连字符，1-40 字)" >&2
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

supabase db query --db-url "$SUPABASE_DB_URL" --agent=no -o csv \
  "insert into api_key (key_hash, name) values (decode('$hash','hex'), '$name') returning id::text as id"

printf '\nAPI key（只显示这一次，请立即保存）:\n%s\n' "$key"
