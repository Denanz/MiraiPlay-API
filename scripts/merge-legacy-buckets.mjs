#!/usr/bin/env node
// Разовое слияние осиротевших bucket'ов в новый адрес аккаунта.
//
// Ленивая миграция в services/identity.ts переносит данные ТОЛЬКО с текущего
// токена пользователя и только если новый адрес ещё свободен. Всё, что осталось
// от прежних токенов того же человека, она намеренно не трогает, чтобы не
// затереть данные одним устройством. Этот скрипт сливает такие остатки — но
// лишь те, чья принадлежность доказана, а не угадана.
//
// Запуск:
//   node scripts/merge-legacy-buckets.mjs <userId> <bucket> [bucket ...]          # вхолостую
//   node scripts/merge-legacy-buckets.mjs <userId> <bucket> [bucket ...] --apply  # с записью
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STATE_DIR = process.env.STATE_DIR || '/app/.state'
const SECRET = process.env.GATEWAY_KEY || 'miraihub'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const [userId, ...buckets] = args.filter((a) => a !== '--apply')

if (!userId || buckets.length === 0) {
  console.error('Usage: merge-legacy-buckets.mjs <userId> <bucket> [bucket ...] [--apply]')
  process.exit(1)
}

const target = createHmac('sha256', SECRET).update(`user:${userId}`).digest('hex').slice(0, 32)
console.log(`аккаунт ${userId} -> bucket ${target}`)
console.log(apply ? '=== РЕЖИМ ЗАПИСИ ===' : '=== вхолостую (добавьте --apply для записи) ===\n')

const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}

/** Объединяет плоские объекты вида { ключ: запись }. Побеждает более свежая запись. */
function mergeObjects(dir, suffix, from, to) {
  const src = join(STATE_DIR, dir, from + suffix)
  if (!existsSync(src)) return null
  const dst = join(STATE_DIR, dir, to + suffix)
  const a = readJson(dst, {})
  const b = readJson(src, {})
  let added = 0, kept = 0
  for (const [k, v] of Object.entries(b)) {
    const cur = a[k]
    // Конфликт по одному и тому же ключу разрешаем по времени обновления:
    // затирать более свежий прогресс старым нельзя.
    if (!cur) { a[k] = v; added++ }
    else if ((v?.updatedAt ?? 0) > (cur?.updatedAt ?? 0)) { a[k] = v; added++ }
    else kept++
  }
  if (apply) writeFileSync(dst, JSON.stringify(a, null, 2))
  return { added, kept, total: Object.keys(b).length }
}

/** Скриншоты: каталог с файлами + index.json. Файлы переносим, индексы склеиваем. */
function mergeScreenshots(from, to) {
  const src = join(STATE_DIR, 'screenshots', from)
  if (!existsSync(src)) return null
  const dst = join(STATE_DIR, 'screenshots', to)
  if (apply) mkdirSync(dst, { recursive: true })
  const idxSrc = readJson(join(src, 'index.json'), [])
  const idxDst = readJson(join(dst, 'index.json'), [])
  const have = new Set(idxDst.map((m) => m.id))
  let moved = 0
  for (const name of readdirSync(src)) {
    if (name === 'index.json') continue
    if (apply && !existsSync(join(dst, name))) renameSync(join(src, name), join(dst, name))
    moved++
  }
  const merged = [...idxDst, ...idxSrc.filter((m) => !have.has(m.id))]
  merged.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  if (apply) writeFileSync(join(dst, 'index.json'), JSON.stringify(merged, null, 2))
  return { moved, indexBefore: idxDst.length, indexAfter: merged.length }
}

for (const b of buckets) {
  if (b === target) { console.log(`${b}: это и есть целевой bucket, пропуск`); continue }
  console.log(`--- ${b} ---`)
  for (const [dir, suffix] of [['progress', '.json'], ['ratings', '.json'], ['diary', '.json']]) {
    const r = mergeObjects(dir, suffix, b, target)
    if (r) console.log(`  ${dir}: записей ${r.total}, перенесено ${r.added}, оставлено своё ${r.kept}`)
  }
  const s = mergeScreenshots(b, target)
  if (s) console.log(`  screenshots: файлов ${s.moved}, индекс ${s.indexBefore} -> ${s.indexAfter}`)
}

console.log(apply ? '\nготово' : '\nничего не изменено')
