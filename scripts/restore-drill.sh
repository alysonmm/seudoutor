#!/usr/bin/env bash
# Exercício LOCAL de backup/restauração (AC20): dump -> restore em banco isolado -> migrações -> verificação -> reaplicar exclusões.
# Mede o tempo. Não substitui o teste na infraestrutura real de produção.
set -euo pipefail
SRC="${1:-seudoutor_dev}"; DST="${SRC}_restore_drill"
export PGUSER=seudoutor PGPASSWORD=seudoutor PGHOST=localhost
start=$(date +%s.%N)
dropdb --if-exists "$DST"; createdb "$DST"
pg_dump -Fc "$SRC" > "/tmp/${SRC}.dump"
pg_restore --no-owner -d "$DST" "/tmp/${SRC}.dump"
DATABASE_URL="postgres://seudoutor:seudoutor@localhost:5432/$DST" npx tsx scripts/migrate.ts | tail -1
for t in users appointments practitioner_occupancies audit_events; do
  a=$(psql -Atc "select count(*) from $t" "$SRC"); b=$(psql -Atc "select count(*) from $t" "$DST")
  echo "$t: origem=$a restaurado=$b"; [ "$a" = "$b" ]
done
# reaplicar exclusões: usuários com status 'deleted' precisam permanecer sem identificação
psql -Atc "select count(*) filter (where status='deleted' and email not like 'removido+%@invalid.local') from users" "$DST" | grep -qx 0 && echo "exclusões preservadas na cópia restaurada"
# constraint global de ocupação ainda vale na cópia
psql -Atc "select count(*) from pg_constraint where conname='practitioner_no_overlap'" "$DST" | grep -qx 1 && echo "constraint de ocupação presente"
end=$(date +%s.%N); printf 'tempo total do exercício: %.1fs\n' "$(echo "$end - $start" | bc)"
dropdb "$DST"; rm -f "/tmp/${SRC}.dump"
