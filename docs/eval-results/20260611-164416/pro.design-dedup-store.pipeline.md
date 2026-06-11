# Content-Addressable Deduplicated Blob Storage

## 1. System Overview

This design provides a deduplication layer for an internal backup product.

**Logical data:** ~100 TB, target dedup ratio ≥ 3× (≤ 33 TB unique).  
**File sizes:** 1 MB – 500 GB; concurrent uploads of identical files are common.  
**Underlay:** commodity S3‑compatible object storage.  
**Metadata:** PostgreSQL with `SERIALIZABLE` transactions.

**Core principles:**
- Content‑defined chunking (FastCDC) with SHA‑256 content addressing.
- Immutable chunks stored in S3; **server‑side verification of every new chunk** before it becomes permanent – no blind trust in client‑supplied hashes or uploaded bytes.
- All metadata mutations inside serializable transactions.
- **Unverified:** Garbage collection (GC) that never corrupts shared chunks, and is aware of in‑progress registrations.
- **Unverified:** Permanent chunk objects cannot be overwritten (S3 permissions restrict writes).

**Safety guarantees:**
- Only verified chunks enter the permanent object store.
- A backup can only be created after all its chunks have been verified and moved to the permanent prefix.
- **Unverified:** Permanent chunk objects cannot be overwritten (S3 permissions restrict writes).
- Idempotent recovery from crashes during verification prevents chunks from becoming stuck.

> **Honest note:** This design is not yet implemented. A prototype plan is provided in §11.

## 2. Chunking and Addressing

### Chunking algorithm
- **FastCDC** with a rolling‑hash gear table.
- Target chunk size **4 MB**, minimum 2 MB, maximum 8 MB.
- Yields ~25 M chunks over 100 TB logical, well within S3 and DB limits.

### Chunk addressing
- Chunk bytes → **SHA‑256** → 64‑char lowercase hex string = `chunk_hash`.
- File manifest: ordered list of chunk hashes.
- File **content hash** = SHA‑256(concatenation of hex strings in order).
- **Empty files** (0 bytes): chunk list empty → content hash = SHA‑256(empty byte string).

Identical files produce identical content hashes, enabling whole‑file dedup.

## 3. Object Storage Layout and Permissions

**Bucket:** `backup-storage-{account-id}`, same region as the application server.

**Permanent chunk prefix:**  
`chunks/{first2}/{next2}/{full_64_chunk_hash}`  
(e.g., `chunks/ab/cd/abcd…`).  
These objects are **immutable** once created; they are written only by the server *after* integrity verification.

**Staging prefix:**  
`staging/{upload_token}/{chunk_hash}`  
where `upload_token` is a unique identifier (UUID) provided by the client for each upload session.  
Objects here are temporary; the client uploads chunks to staging, then the server copies verified chunks to permanent storage.

**S3 permissions:**
- Client role: `s3:PutObject` only on `staging/*`.
- Server role: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` on both prefixes.
This enforces the trust boundary: clients cannot write directly to permanent chunk keys; all permanent chunk content has been verified by the server.

## 4. Metadata Schema (PostgreSQL)

```sql
CREATE TABLE chunks (
    chunk_hash  TEXT PRIMARY KEY,
    size        BIGINT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',   -- 'pending' | 'active' | 'corrupt'
    created_at  TIMESTAMPTZ DEFAULT now()
);
-- A chunk is inserted as 'pending' while verification is in‑flight; 
-- only 'active' rows are considered valid for reads.

CREATE TABLE file_contents (
    content_hash TEXT PRIMARY KEY,
    file_size    BIGINT NOT NULL,
    chunk_count  INT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE file_content_chunks (
    content_hash TEXT REFERENCES file_contents ON DELETE CASCADE,
    chunk_order  INT NOT NULL,
    chunk_hash   TEXT REFERENCES chunks,
    PRIMARY KEY (content_hash, chunk_order)
);
CREATE INDEX idx_fcc_chunk_hash ON file_content_chunks(chunk_hash);

CREATE TABLE backups (
    backup_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at  TIMESTAMPTZ DEFAULT now(),
    status      TEXT DEFAULT 'active'   -- 'active' | 'deleted'
);

CREATE TABLE backup_files (
    backup_id    UUID REFERENCES backups,
    file_path    TEXT NOT NULL,
    content_hash TEXT REFERENCES file_contents,
    file_size    BIGINT,
    PRIMARY KEY (backup_id, file_path)
);

-- Supports garbage collection after backup deletion
CREATE TABLE gc_candidates (
    content_hash TEXT PRIMARY KEY,
    added_at     TIMESTAMPTZ DEFAULT now()
);

-- S3 keys queued for deletion after chunk becomes unreferenced
CREATE TABLE s3_deletion_queue (
    s3_key    TEXT PRIMARY KEY,
    added_at  TIMESTAMPTZ DEFAULT now()
);

-- Health status for restores
CREATE TABLE backup_health_status (
    backup_id UUID REFERENCES backups,
    status    TEXT NOT NULL,            -- 'healthy' | 'degraded'
    detail    JSONB,
    PRIMARY KEY (backup_id)
);
```

**No stored reference counts** – liveness is derived from relational structure, avoiding counter‑drift bugs.

### Additional tables for large‑file asynchronous registration

```sql
-- Track ongoing chunk verification jobs for files with many chunks
CREATE TABLE registration_jobs (
    job_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    upload_token      TEXT NOT NULL,
    backup_id         UUID NOT NULL,
    file_path         TEXT NOT NULL,
    file_size         BIGINT NOT NULL,
    content_hash      TEXT NOT NULL,
    chunk_hashes      TEXT[] NOT NULL,       -- sorted by hash
    status            TEXT NOT NULL DEFAULT 'queued',  -- 'queued','processing','completed','failed'
    processed_count   INT DEFAULT 0,
    last_error        TEXT,
    created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX idx_registration_jobs_file
    ON registration_jobs (backup_id, file_path)
    WHERE status IN ('queued','processing'); -- prevent duplicate live jobs
```

## 5. Client–Server Protocol with Integrity Verification

All chunk data flows through a **staging area** so the server can verify its integrity before it becomes permanent.  
The server intelligently chooses a **synchronous** or **asynchronous** registration path based on the number of chunks.

### 5.1 Uploading a File

#### Step 1 – Chunking and Staging
a) Client runs FastCDC on the file, computes chunk SHA‑256 hashes and the file content hash.  
b) Client generates an `upload_token` (UUID).  
c) Client calls `POST /chunks/stage` with the list of chunk hashes (and sizes).  
   Server creates a staging session record (in a short‑lived table, omitted for brevity) and returns pre‑signed S3 PUT URLs for each chunk, keyed as `staging/{upload_token}/{chunk_hash}`.  
d) Client uploads all chunks to S3 staging (parallel).  

#### Step 2 – Registration
Client calls the **unified registration endpoint**: `POST /files/register` with:
```json
{
  "upload_token": "<uuid>",
  "backup_id": "<uuid>",
  "file_path": "relative/path",
  "file_size": 123456,
  "content_hash": "<hex>",
  "chunks": [ {"hash":"<hex>","size":4567}, … ]
}
```

The server **validates the manifest**:
- Re‑compute `content_hash` from the submitted chunk list (concatenation of hex strings). Reject on mismatch.
- Check sum of chunk sizes equals `file_size` (except empty file).
- Sort the chunk list by `chunk_hash` ascending (deterministic lock order).

If the number of chunks is **≤ 1000** (configurable threshold), the server processes the registration **synchronously** in a single serialisable transaction (§6). The HTTP response returns success/failure immediately.

If the number of chunks is **> 1000**, the server creates a `registration_jobs` record, returns `202 Accepted` with a `job_id`, and processes the file asynchronously (§7). The client can poll `GET /jobs/{job_id}` for completion status.

**Empty files** (0 chunks) always take the synchronous path.

### 5.2 Restoring a File

`GET /backups/{id}/files/{path}` returns the ordered list of active chunk hashes (empty for 0‑byte files).  
Client downloads from `chunks/…` in parallel and reassembles.  
If a chunk object returns 404, the restore fails with an error listing the missing chunk; the backup is marked **degraded** (§8).

## 6. Synchronous Registration (≤ 1000 chunks)

All steps inside a single `SERIALIZABLE` PostgreSQL transaction. This path guarantees atomicity and short latency for typical file sizes.

### 6.1 Pre‑transaction consistency checks (outside DB)
- `content_hash` match, size sum, chunk list sorted.

### 6.2 Transaction logic (pseudocode with idempotent recovery)

```
BEGIN;

-- 1. Lock or create the file_contents row
INSERT INTO file_contents (content_hash, file_size, chunk_count)
VALUES (content_hash, file_size, len(chunk_list))
ON CONFLICT (content_hash) DO NOTHING;
-- Obtain appropriate lock to prevent GC while we add a reference
SELECT content_hash FROM file_contents
  WHERE content_hash = content_hash FOR UPDATE;

-- 2. Process each chunk in sorted order
FOR each chunk IN chunk_list LOOP
    -- Insert a pending row if none exists (idempotent)
    INSERT INTO chunks (chunk_hash, size, status)
    VALUES (chunk.hash, chunk.size, 'pending')
    ON CONFLICT (chunk_hash) DO NOTHING;

    -- Acquire exclusive lock to serialise verification
    SELECT status FROM chunks WHERE chunk_hash = chunk.hash FOR UPDATE
      INTO current_status;

    IF current_status = 'active' THEN
        CONTINUE;          -- already verified and permanent

    ELSIF current_status = 'pending' THEN
        perm_key = 'chunks/' || prefix(chunk.hash) || '/' || chunk.hash;
        stage_key = 'staging/' || upload_token || '/' || chunk.hash;

        -- Idempotent recovery: check if permanent object already exists
        s3_head = S3_HEAD(perm_key);
        IF s3_head EXISTS THEN
            IF s3_head.content_length = chunk.size THEN
                -- Correct size → content must match the hash
                -- (only the server could have written this object)
                UPDATE chunks SET status = 'active'
                  WHERE chunk_hash = chunk.hash;
            ELSE
                -- Corrupted permanent object; raise alarm, abort
                UPDATE chunks SET status = 'corrupt'
                  WHERE chunk_hash = chunk.hash;
                RAISE EXCEPTION 'Chunk % permanent object size mismatch', chunk.hash;
            END IF;
        ELSE
            -- No permanent object; download staging for verification
            stage_obj = S3_GET(stage_key);
            computed_hash = SHA256(stage_obj.body);
            computed_size = LENGTH(stage_obj.body);
            IF computed_hash != chunk.hash OR computed_size != chunk.size THEN
                RAISE EXCEPTION 'Chunk % integrity failure', chunk.hash;
            END IF;
            -- Move to permanent storage (idempotent, harmless if already present)
            S3_COPY(stage_key, perm_key);
            S3_DELETE(stage_key);
            UPDATE chunks SET status = 'active'
              WHERE chunk_hash = chunk.hash;
        END IF;

    ELSIF current_status = 'corrupt' THEN
        RAISE EXCEPTION 'Chunk % is marked corrupt', chunk.hash;
    END IF;

    -- Insert chunk reference for new file_content (only if this content row is new)
    IF content_is_new THEN
        INSERT INTO file_content_chunks (content_hash, chunk_order, chunk_hash)
        VALUES (content_hash, chunk.order, chunk.hash);
    END IF;
END LOOP;

-- 3. Link file into backup (idempotent)
INSERT INTO backup_files (backup_id, file_path, content_hash, file_size)
VALUES (backup_id, file_path, content_hash, file_size)
ON CONFLICT (backup_id, file_path) DO NOTHING;

COMMIT;
```

**Key behaviours:**
- **Crashes after S3 copy but before commit:** the transaction rolls back; the permanent object is left behind. On retry, the row is still `'pending'`; the `HEAD` check sees the permanent object with correct size and simply moves status to `'active'`. No stuck chunk.
- **Concurrent identical chunk verification:** lock ordering forces serialisation; the second verifier sees `'active'` after the first commits and skips.
- **Corrupt chunk detection:** permanent object size mismatch is an anomaly; we abort, mark the chunk corrupt, and rely on operator intervention.
- **Lock ordering:** all transactions lock chunks by sorted hash; no deadlocks.

## 7. Asynchronous Registration for Large Files (> 1000 chunks)

When the file is huge (up to 125 000 chunks for a 500 GB file), a single transaction is impractical. We use a two‑phase asynchronous state machine with a `registration_jobs` row that shields in‑progress chunks from GC.

### 7.1 Registration Job Creation
`POST /files/register` → if chunk count > threshold:
- Insert a `registration_jobs` row with `status = 'queued'` and the full sorted `chunk_hashes` array.
- Return `202` with `job_id`.

A background worker picks up the job. The worker processes the job in **small batches** (e.g., 100 chunks) inside independent transactions.

### 7.2 Batch Verification (Phase 1)
For each batch (processed in order of the sorted list):

```
BEGIN;
-- Verify each chunk in the batch; same idempotent logic as §6 (HEAD, then staging)
-- On any failure, mark job failed and abort batch.
UPDATE registration_jobs SET processed_count = processed_count + batch_size
  WHERE job_id = :job_id;
COMMIT;
```

After all chunks are verified and `chunks.status = 'active'` for every hash, the job enters the linking phase.

### 7.3 Linking and Cleanup (Phase 2)
A final transaction (still short, no S3 operations):

```
BEGIN;
-- Re‑check that all required chunks are still active (they should be)
-- (Optional: verify existence via a SELECT with FOR SHARE, but not necessary
--  because GC skips chunks in an active registration job.)
INSERT INTO file_contents ... ON CONFLICT DO NOTHING;
INSERT INTO file_content_chunks ...
INSERT INTO backup_files ... ON CONFLICT DO NOTHING;

UPDATE registration_jobs SET status = 'completed'
  WHERE job_id = :job_id;
COMMIT;
```

During the period between Phase 1 and Phase 2, the chunks are active but not yet referenced by `file_content_chunks`. GC must **not delete** such chunks. We achieve this by querying GC with:

```sql
-- When determining orphan chunks, skip any chunk that appears in a live registration job:
NOT EXISTS (
  SELECT 1 FROM registration_jobs rj
  WHERE c.chunk_hash = ANY(rj.chunk_hashes)
    AND rj.status IN ('queued','processing')
)
```

This eliminates the need for long locks or reference counts, while keeping GC safe.

**Idempotency:** If a worker crashes and the job is retried (e.g., by picking it up again), the chunk verification logic is fully idempotent – existing active chunks are skipped, and pending ones are recovered via the HEAD‑then‑staging procedure.

**Stale jobs:** A periodic sweeper removes `queued`/`processing` jobs older than a time‑out (e.g., 2 hours) and marks them `failed`. The client must re‑upload.

## 8. Deletion & Garbage Collection

### 8.1 Soft delete a backup

```sql
DELETE FROM backup_files WHERE backup_id = :bid
RETURNING DISTINCT content_hash;

INSERT INTO gc_candidates (content_hash) VALUES (:each_hash)
ON CONFLICT DO NOTHING;

UPDATE backups SET status = 'deleted' WHERE backup_id = :bid;
```

The backup disappears instantly from user view.

### 8.2 File‑content GC (periodic, e.g., every 5 min)

Processes candidates in small batches. Uses lock‑ordered access and `SKIP LOCKED` to avoid deadlocks and contention.

```
FOR each content_hash IN (SELECT content_hash FROM gc_candidates LIMIT 500)
LOOP
  BEGIN;
    -- Lock candidate to prevent concurrent registration
    SELECT content_hash FROM file_contents
      WHERE content_hash = content_hash FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;

    -- Still referenced by a backup? → not an orphan
    IF EXISTS (SELECT 1 FROM backup_files WHERE content_hash = content_hash) THEN
        DELETE FROM gc_candidates WHERE content_hash = content_hash;
        COMMIT;
        CONTINUE;
    END IF;

    -- Collect candidate chunks (sorted by hash)
    CREATE TEMP TABLE orphan_chunks AS
      SELECT fcc.chunk_hash, c.s3_key
      FROM file_content_chunks fcc
      JOIN chunks c ON c.chunk_hash = fcc.chunk_hash
      WHERE fcc.content_hash = content_hash
      ORDER BY fcc.chunk_hash;

    -- Delete the content identity (cascades to file_content_chunks)
    DELETE FROM file_contents WHERE content_hash = content_hash;

    -- For each chunk, lock and delete if no more references
    FOR each row IN (SELECT * FROM orphan_chunks ORDER BY chunk_hash) LOOP
        SELECT chunk_hash FROM chunks
          WHERE chunk_hash = row.chunk_hash
          FOR UPDATE SKIP LOCKED;
        IF FOUND AND NOT EXISTS (
            SELECT 1 FROM file_content_chunks WHERE chunk_hash = row.chunk_hash
        ) AND NOT EXISTS (
            -- Ensure not part of any in‑progress registration job
            SELECT 1 FROM registration_jobs rj
            WHERE row.chunk_hash = ANY(rj.chunk_hashes)
              AND rj.status IN ('queued','processing')
        ) THEN
            DELETE FROM chunks WHERE chunk_hash = row.chunk_hash;
            INSERT INTO s3_deletion_queue (s3_key) VALUES (row.s3_key)
            ON CONFLICT DO NOTHING;
        END IF;
    END LOOP;

    DELETE FROM gc_candidates WHERE content_hash = content_hash;
  COMMIT;
END LOOP;
```

### 8.3 S3 permanent chunk deletion worker

Reads `s3_deletion_queue`, issues S3 `DeleteObject` for the permanent key, removes the queue entry on success. Retries with exponential back‑off.

### 8.4 Cleanup of abandoned staging objects

A daily sweep lists objects under `staging/` older than a generous session TTL (e.g., 2 hours). An object older than `registration_job` timeout is safe to delete.

## 9. Integrity and Missing Chunk Detection

New chunks are verified server‑side, so a backup will never contain a chunk whose permanent object has incorrect bytes. However, permanent objects may become unavailable later (S3 data loss, accidental deletion). Detection is covered by:

**Restore‑time detection:**  
If `GET /chunks/{hash}` returns 404, the restore fails with an explicit error; the server marks the backup **degraded** in `backup_health_status`.

**Proactive background health check (optional, recommended):**  
A periodic job samples backup files and issues `HEAD` requests against the permanent chunk keys. Missing objects trigger `degraded` status.

**Empty‑file restore:** always succeeds; no chunks to fetch.

## 10. Failure Handling

| Scenario | Behaviour |
|----------|-----------|
| Client dies before staging uploads complete | Staging objects expire and are swept. |
| Client uploads to staging but crashes before registration | Same; staging cleanup handles. |
| Synchronous registration transaction fails (integrity, serialization, crash) | DB rolls back. If the crash left a permanent object behind, the next attempt (or a retry) executes the HEAD‑first idempotent recovery and completes cleanly. |
| Large‑file async worker crashes mid‑Phase 1 | The job remains `queued`/`processing`; the worker recovers by re‑processing from the beginning. All chunk verification is idempotent. If chunks were made active, they persist; GC won't delete them because the job is still active. |
| GC crash / restart | `SKIP LOCKED` prevents double work; remaining candidates re‑processed. |
| Missing permanent chunk detected during restore | Restore fails + `degraded` status; other backups unaffected. |
| S3 copy transient failure | The chunk’s row remains `'pending'`. The job (sync or async) retries; if staging object still exists, verification re‑attempts. If staging object is gone, the chunk cannot be verified and the registration fails; the client must re‑upload the file. |
| Concurrent identical new chunk verification | Lock ordering ensures only one verifier; second sees `'active'` and skips. |
| Permanent object size mismatch (corruption) | Chunk is marked `'corrupt'`; the transaction aborts and an alert is raised. Manual intervention required to clean up. |
| Registration job left in `queued`/`processing` indefinitely | Timeout sweep moves to `failed` and notifies client. |

## 11. Trade‑offs & Rejected Alternatives

- **Trusting client‑supplied hashes without server verification** – Rejected: a client could upload wrong bytes under a valid hash, corrupting shared chunks. Server‑side staging+verification eliminates this trust boundary.
- **Explicit reference counts** – Rejected: prone to drift; relational GC with locks is more robust.
- **Fixed‑size chunking** – Rejected: byte‑shift destroys dedup benefits.
- **Pure S3 metadata (no RDBMS)** – Rejected: no transactional reference management; fragile.
- **Two‑phase reservation protocols (without staging)** – Rejected: added session state and timeouts; staging with an upload token is lighter weight.
- **Storing S3 ETags for verification** – Rejected: ETags are not content‑hash‑equivalent and do not replace hash verification.
- **Always synchronous single‑transaction registration** – Rejected for files > 1000 chunks because of transaction timeouts and lock contention. The asynchronous two‑phase approach scales gracefully.

## 12. Scaling Limits & Assumptions (Unverified)

**Scale estimates (3× dedup, 100 TB logical):**
- Unique data: ~33 TB → ~8.25 M chunks (4 MB average).
- `chunks`: ~8.25 M; `file_contents`: 1–2 M; `file_content_chunks`: ~25 M rows.
- PostgreSQL handles this comfortably with indexing.

**S3 costs:** Each new chunk incurs a GET (staging download for verification), a PUT (permanent copy), and a DELETE. The verification bandwidth (~33 TB total) is a one‑time cost; acceptable for an internal product.

**Concurrency:** Lock‑ordering by chunk hash prevents deadlocks. GC and registration interleave correctly. The maximum chunk verification latency is the S3 download time; parallelism and caching can mitigate it.

**Assumptions:**
- SHA‑256 collisions are astronomically unlikely; content hashes are unique.
- S3 bucket is in the same region; read‑after‑write consistency within a reasonable window (S3 is eventually consistent for overwrites, but here we only write new objects and never overwrite). We assume a copy immediately followed by a HEAD will return the object.
- The server has sufficient bandwidth to download and hash all unique chunk data.
- Clients can be trusted not to intentionally submit garbage staging data after correct hashing; a malicious client could waste resources but not corrupt permanent data.

## 13. Validation Plan (Unverified)

This design has not been implemented. The following critical aspects must be tested:

1. **Deduplication ratio** with FastCDC on representative backup datasets.
2. **Idempotent recovery correctness**: crash tests during synchronous registration (kill server after S3 copy, then retry) – chunk must end up active.
3. **Large‑file asynchronous flow**: concurrent registrations, worker crashes, correct finalisation and GC protection via `registration_jobs`.
4. **GC correctness under load**: run GC while new registrations are in progress; assert no shared chunk is ever deleted prematurely.
5. **Edge cases:** empty files, 1 MB and 500 GB extremes, minimum/maximum chunk sizes, staging cleanup timing, concurrent identical file uploads.
6. **Performance:** throughput of verification, impact of HEAD check on latency, transaction contention.

A prototype should be built with synthetic workloads and fault injection before production use.

## 14. Critique Rebuttals

*An earlier draft of this design was critiqued for missing idempotent recovery during verification and for lacking a strategy for large files. This revision fully addresses both points.*

- **Missing idempotent recovery:** The synchronous registration loop now includes an explicit `HEAD` of the permanent object before attempting to download staging. If the permanent object exists with the correct size, the chunk is marked active without re‑verification, avoiding a permanent stuck state when a staging object has been deleted.  
- **Large‑file single‑transaction risk:** The design now introduces a separate asynchronous path for files with more than 1000 chunks, using batched verification and a final linking transaction, complemented by GC awareness of `registration_jobs` to protect in‑progress chunks.
- **Corrupt permanent object handling:** Added a path for permanent object size mismatch, which marks the chunk as `corrupt` and aborts with an alert.

All remaining design elements are unchanged from the earlier version, which already included server‑side verification, lock‑ordering, relational GC, and staging cleanup.

## 15. Verification Status

- **Observed/verified:** The design documents content‑defined chunking with SHA‑256, server‑side chunk verification via staging, serializable transactional metadata, idempotent synchronous registration with HEAD‑based recovery, batched asynchronous large‑file processing, GC with candidate tracking and SKIP LOCKED, lock ordering to prevent deadlocks, use of relational structure instead of reference counts, and explicit rejection of alternative approaches.
- **Unverified:** 
  - Garbage collection never corrupting shared chunks and being aware of in‑progress registrations has not been demonstrated through execution or formal verification; the mechanism is described but not tested.
  - The claim that permanent chunk objects cannot be overwritten due to S3 permissions is plausible, but no concrete S3 policy or permission configuration has been provided as evidence.

These items remain assumptions that must be validated with a prototype and possibly formal verification of the GC logic.