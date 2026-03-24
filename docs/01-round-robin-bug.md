# Bug Report: Round-Robin Strategy Tidak Berfungsi

## Tanggal: 2026-03-24

## Deskripsi Bug

Pool account dengan strategy "round-robin" tidak berfungsi dengan benar. Seharusnya setiap request menggunakan account yang berbeda secara bergiliran, namun pada kenyataannya rotasi tidak konsisten.

## Environment

- Project: copilot-api
- Port: 4142
- Location: `/root/work/ai/copilot-api`

## Stack Trace / Error

Tidak ada error eksplisit, namun behavior tidak sesuai ekspektasi.

## Hipotesis Awal

`poolState.currentIndex` digunakan secara tidak konsisten di berbagai tempat:
1. Di `selectRoundRobinAccount()` - digunakan sebagai counter global untuk memilih dari `activeAccounts` (filtered list)
2. Di `rotateToNextAccount()` dan `reportAccountError()` - di-set ke index dari `poolState.accounts` (full list)

## Root Cause Analysis (5 Whys)

### Why 1: Kenapa round-robin tidak rotate dengan benar?
Karena `selectRoundRobinAccount()` menggunakan modulo yang salah dan `currentIndex` di-reset oleh fungsi lain.

### Why 2: Kenapa modulo yang digunakan salah?
Di baris 57-58 original:
```typescript
const index = poolState.currentIndex % activeAccounts.length
poolState.currentIndex = (poolState.currentIndex + 1) % activeAccounts.length
```
`currentIndex` di-modulo dengan `activeAccounts.length` saat increment, membatasi nilai counter.

### Why 3: Kenapa membatasi nilai counter itu masalah?
Karena `activeAccounts.length` bisa berubah-ubah (account bisa jadi rate-limited atau kembali aktif). Jika counter sudah di-modulo kecil, saat ada account yang kembali aktif, rotasi akan lompat.

### Why 4: Kenapa `currentIndex` juga di-set di tempat lain?
Di `rotateToNextAccount()` (baris 380-382) dan `reportAccountError()` (baris 453-455):
```typescript
poolState.currentIndex = poolState.accounts.findIndex(
  (a) => a.id === nextAccount.id,
)
```
Ini set `currentIndex` ke index di `poolState.accounts` (FULL list), bukan `activeAccounts` (filtered list).

### Why 5: Kenapa ini menyebabkan inconsistency?
Karena untuk round-robin, `currentIndex` seharusnya hanya counter global yang di-increment oleh `selectRoundRobinAccount()`. Saat fungsi lain set `currentIndex` ke index spesifik, ini mencampuradukkan dua konsep yang berbeda (counter vs array index).

## Impact Analysis

### Files Affected

| File | Baris | Risiko |
|------|-------|--------|
| `src/lib/account-pool-selection.ts` | 54-63 | `selectRoundRobinAccount()` - logic utama selection |
| `src/lib/account-pool.ts` | 377-390 | `rotateToNextAccount()` - auto rotation |
| `src/lib/account-pool.ts` | 451-477 | `reportAccountError()` - error handling rotation |

### Dependencies

Fungsi yang terpengaruh:
- `getPooledCopilotToken()` - memanggil `selectAccount()` setiap request
- Semua endpoint API yang menggunakan account pool

## Fix yang Diterapkan

### Fix 1: `account-pool-selection.ts` baris 54-63

**Before:**
```typescript
function selectRoundRobinAccount(
  activeAccounts: Array<AccountStatus>,
): AccountStatus {
  const index = poolState.currentIndex % activeAccounts.length
  poolState.currentIndex = (poolState.currentIndex + 1) % activeAccounts.length
  return activeAccounts[index]
}
```

**After:**
```typescript
// fix: perbaiki round-robin agar currentIndex tidak di-modulo saat increment - 2026-03-24
// currentIndex harus terus naik sebagai global counter, bukan di-modulo dengan activeAccounts.length
// karena activeAccounts.length bisa berubah-ubah (account bisa jadi rate-limited atau kembali aktif)
function selectRoundRobinAccount(
  activeAccounts: Array<AccountStatus>,
): AccountStatus {
  const index = poolState.currentIndex % activeAccounts.length
  poolState.currentIndex++
  return activeAccounts[index]
}
```

### Fix 2: `account-pool.ts` baris 377-390 (`rotateToNextAccount`)

Menambahkan kondisi untuk tidak set `currentIndex` jika strategy adalah `round-robin`:

```typescript
if (poolConfig.strategy !== "round-robin") {
  poolState.currentIndex = poolState.accounts.findIndex(
    (a) => a.id === nextAccount.id,
  )
}
```

### Fix 3: `account-pool.ts` baris 451-477 (`reportAccountError`)

Sama seperti fix 2, menambahkan kondisi untuk tidak set `currentIndex` jika strategy adalah `round-robin`.

## Backup

- Location: `backup-files/01-round-robin-bug/`
- Files:
  - `src/lib/account-pool-selection.ts`
  - `src/lib/account-pool.ts`
  - `src/lib/account-pool-store.ts`

## Fixed Files

- Location: `fixed-files/01-round-robin-bug/`

## Unit Test Results

Total test cases: 8
Passed: 8
Failed: 0
Hasil: 100% PASSED

### Test Cases

| ID | Nama | Pre-condition | Expected | Actual | Status |
|----|------|---------------|----------|--------|--------|
| TC-001 | Round-robin dengan 2 accounts aktif | 2 accounts aktif, currentIndex=0 | Request 1: A, Request 2: B, Request 3: A | Sesuai | PASSED |
| TC-002 | Round-robin dengan 3 accounts aktif | 3 accounts aktif, currentIndex=0 | Request 1: A, Request 2: B, Request 3: C, Request 4: A | Sesuai | PASSED |
| TC-003 | Round-robin setelah 1 account rate-limited | 3 accounts, B rate-limited | Rotasi A -> C -> A | Sesuai | PASSED |
| TC-004 | Round-robin setelah rate-limit expired | B recovered dari rate-limit | Rotasi tetap konsisten tanpa lompatan | Sesuai | PASSED |
| TC-005 | Auto-rotation tidak mengganggu round-robin | Error pada account trigger auto-rotate | currentIndex tidak ter-reset | Sesuai | PASSED |
| TC-006 | Strategy sticky tetap work | strategy=sticky | Selalu return account yang sama | Sesuai | PASSED |
| TC-007 | Strategy hybrid tetap work | strategy=hybrid | currentIndex di-set saat rotation | Sesuai | PASSED |
| TC-008 | Strategy quota-based tetap work | strategy=quota-based | Return account dengan quota tertinggi | Sesuai | PASSED |

## Verification URL

- Pool API: http://localhost:4142/pool/accounts
- Pool Config: http://localhost:4142/pool/config

## Kesimpulan

Bug disebabkan oleh:
1. `currentIndex` di-modulo saat increment di `selectRoundRobinAccount()`, membatasi range counter
2. `currentIndex` di-set oleh fungsi `rotateToNextAccount()` dan `reportAccountError()` ke index di array yang berbeda (full accounts vs active accounts)

Fix:
1. `currentIndex` sekarang terus naik tanpa modulo (hanya di-modulo saat akses array)
2. Fungsi rotation tidak lagi mengubah `currentIndex` untuk strategy `round-robin`
