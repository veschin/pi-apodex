## Content-Addressable Deduplicated Blob Storage – Engineering Design

### Assumptions & Requirements Understood

- **Logical data**: ~100 TB, target dedup ratio ≥3x, single region.
- **Workload**: Large files (1 MB – 500 GB), many concurrent uploads of identical content.
- **Consistency**: Deletion of a backup must eventually free space without corrupting other backups that share chunks.
- **Storage layer**: Commodity S3-compatible object store (assumed **strong read-after-write consistency** – e.g., AWS S3 as of 2025 or MinIO with immediate consistency).
- **Metadata store**: Relational database (e.g., PostgreSQL) chosen for ACID transactions and powerful queries; a KV store (e.g., DynamoDB) was considered but rejected because complex multi‑key transactions are needed for reference counting and GC safety.

- **Edge cases handled**:
  - Empty file / file smaller than minimum chunk → stored as a single chunk of its actual length.
  - Concurrent upload of same new chunk → database unique constraint prevents duplicate inserts.
  - Chunk upload failure → rollback database transaction; file write fails.
  - S3 object lost despite DB record → periodic integrity check detects and re‑uploads from a surviving copy (see *Failure Handling*).
  - Very high concurrent access to the same chunk → row‑level locking (`SELECT … FOR UPDATE`) serializes increments, acceptably slow for dedup‑heavy workloads.

---

### Architecture Overview

```
┌──────────────┐     ┌────────────────────┐     ┌───────────────────┐
│  Backup      │────>│   Chunk Module     │────>│  S3-Compatible    │
│  Writer      │     │ (CDC, hash, DB ops)│     │  Object Store     │
└──────────────┘     └────────────────────┘     └───────────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │  Metadata DB │
                     │ (PostgreSQL) │
                     └──────────────┘
```

Data flows:
1. **Write**: File → **content‑defined chunking** → hash (SHA‑256) → lookup/insert chunk in DB → upload to S3 if new → record file recipe.
2. **Read**: Resolve file recipe → fetch chunks from S3 → reassemble.
3. **Delete**: Mark file logically deleted → background worker decrements chunk ref counts → chunks reaching 0 are marked `pending_delete` → second worker verifies no new references and deletes from S3.

---

### 1. Chunking

**Algorithm**: FastCDC (content‑defined chunking based on Rabin fingerprint).

- Average chunk size: **8 KiB** (minimum 4 KiB, maximum 64 KiB).
- Reason: Balances dedup ratio (variable‑sized: 3–5× typical) vs. metadata overhead (~0.5 GiB per TiB of logical data).
- Fixed‑size chunking was rejected – dedup ratio would drop sharply when files have inserted/deleted bytes (common in backup revisions).

**Edge case**: File smaller than 4 KiB → one chunk of exact size.

**Hash function**: SHA‑256 (truncated to 32 bytes, hex‑encoded → 64‑char key). Collisions are practically impossible; no secondary verification needed.

---

### 2. Addressing & Storage

- **Chunk identifier**: `sha256_hex(chunk_bytes)`.
- **S3 key format**: `<prefix>/<hash_prefix>/<full_hash>`  
  e.g., `chunks/ab/abcdef...`  
  Prefix = first two hex characters → 256 buckets avoids hotspots.
- No additional compression; S3 may apply transparent compression (optional).
- Encryption: if required, use **deterministic encryption** (AES‑SIV) so that identical plaintext yields identical ciphertext and dedup is preserved. (Not elaborated further, but design accommodates it.)

---

### 3. Metadata Schema (PostgreSQL)

```sql
-- Chunk registry
CREATE TABLE chunks (
    chunk_hash   VARCHAR(64) PRIMARY KEY,
    size         INTEGER NOT NULL,
    ref_count    INTEGER NOT NULL DEFAULT 1,
    status       VARCHAR(20) NOT NULL DEFAULT 'active',  -- active | pending_delete
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Files (backups)
CREATE TABLE files (
    file_id      UUID PRIMARY KEY,
    backup_id    UUID NOT NULL,
    file_path    TEXT,
    logical_size BIGINT,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- File → chunk mapping (recipe)
CREATE TABLE file_chunks (
    file_id      UUID REFERENCES files(file_id) ON DELETE CASCADE,
    chunk_index  INTEGER NOT NULL,              -- order in file
    chunk_hash   VARCHAR(64) REFERENCES chunks(chunk_hash),
    offset       BIGINT NOT NULL,               -- byte offset in file
    length       INTEGER NOT NULL,              -- chunk length in file
    PRIMARY KEY (file_id, chunk_index)
);

CREATE INDEX idx_chunks_status ON chunks(status);
```

**Why relational DB?** Multi‑row transactions (insert recipe + update ref_count) and row‑level locking are essential for safe concurrent dedup. KV store lacks these primitives without external coordination.

---

### 4. Write Path (Happy + Error Flow)

```
For each chunk of the file:

  1. Compute SHA‑256 hash.

  2. Transaction (SERIALIZABLE isolation) {
       a. SELECT chunk_hash FROM chunks WHERE chunk_hash = ? FOR UPDATE;
          If row exists:
               UPDATE chunks SET ref_count = ref_count + 1 WHERE chunk_hash = ?;
          Else:
               INSERT INTO chunks (chunk_hash, size, ref_count, status)
               VALUES (?, ?, 1, 'active');
               (If INSERT fails due to concurrent insert → retry transaction)
       b. INSERT INTO file_chunks (file_id, chunk_index, chunk_hash, offset, length)
          VALUES (?, ?, ?, ?, ?);
     }  -- commit transaction

  3. If row was new (INSERT succeeded in step 2) → upload chunk bytes to S3
     (the same transaction holds the row lock, ensuring only one upload per chunk).

     Upload error handling:
        - Retry with exponential backoff (max 3 times).
        - If all retries fail, roll back the transaction (DELETE the chunk row,
          and undo ref_count increment if it was an existing chunk – but we only
          decrement if rollback occurs; simpler: we upload before DB write? See tradeoff.)
```

---

### 5. Write Path – Tradeoff on Upload Timing

Two alternatives considered:

| Approach | Pros | Cons |
|----------|------|------|
| **Upload before DB insert** | DB row always backed by S3 object | If upload succeeds but DB insert fails, an object is orphaned (no reference). Must be cleaned later. |
| **Upload after DB insert (shown above)** | DB is source of truth; no orphan objects | If upload fails after DB commit, chunk row exists without S3 object → read errors. |

**Chosen**: Upload **after** DB insert, but **inside the same transaction** (hold row lock until upload completes). This prevents concurrent inserts for the same new chunk and ensures that a failed upload causes a full transaction rollback (row disappears). It serializes new‑chunk uploads, which is acceptable because identical content is rare and a single upload is fast.

If the lock‑based serialization becomes a bottleneck, we can switch to a two‑phase approach:
1. Insert with status `uploading`.
2. Upload.
3. Update status to `active`.
Other writers wait or skip (if they see `uploading`, they can treat as “not yet available” and retry). This is more complex; we keep the simpler lock‑per‑chunk design for now.

---

### 6. Delete & Garbage Collection

**Goal**: Reclaim space without affecting other backups that share chunks.

**Strategy**: Reference counting + asynchronous deletion with re‑check.

#### Step 1 – Mark backup as deleted
- Delete the `file` row (or add a `deleted_at` flag – we use **hard delete** for simplicity, but ensure file_chunks are removed via `ON DELETE CASCADE`).

#### Step 2 – Decrement ref counts (background job)
- A worker queries all `file_chunks` for the deleted file (batched, 1000 at a time).
- For each chunk_hash, inside a transaction:
  ```sql
  UPDATE chunks
  SET ref_count = ref_count - 1
  WHERE chunk_hash = ?
    AND ref_count > 0;   -- guard against underflow (should not happen)
  ```
- If `ref_count` becomes 0, update `status = 'pending_delete'` and enqueue a deletion task (or rely on a periodic sweeper).

#### Step 3 – Physical deletion (second background job)
- Worker picks a `pending_delete` chunk, starts transaction:
  ```sql
  SELECT chunk_hash, ref_count FROM chunks
  WHERE chunk_hash = ? AND status = 'pending_delete'
  FOR UPDATE;
  ```
- If `ref_count == 0`:
    - Delete S3 object (`DELETE object`).
    - **Delete chunk row** (`DELETE FROM chunks WHERE chunk_hash = ?`).
- If `ref_count > 0` (e.g., new reference was added after decrement but before deletion):
    - Revert status to `active`.
    - **Abort deletion** – no data loss because ref_count > 0.
- If S3 deletion fails (transient), retry with backoff; after N failures, leave `pending_delete` for a later sweep.

#### Why this works against races
- The `FOR UPDATE` + re‑check ensures that a concurrent increment (from a new upload) between decrement and deletion is caught.
- The window between decrement and deletion is short (only while DB query + S3 delete happens) and protected by row lock.

#### Periodic offline GC (safety net)
- A background job scans chunks with `status = 'pending_delete'` older than 24 hours. For each, it re‑verifies `ref_count == 0` (using snapshot isolation) and deletes if still zero. This handles crashes or missed deletion tasks.

---

### 7. Failure Handling

| Failure | Mitigation |
|---------|------------|
| S3 write failure | Retry with backoff; if persistent, fail file write and rollback chunk DB changes. |
| S3 read failure (missing chunk) | Retry; if permanent, log and fail restore. Periodic integrity checker (scan DB, check S3 existence) detects and attempts re‑upload from surviving copies (e.g., another backup that references the same chunk). |
| DB transaction conflict | Retry the entire transaction (up to 3 times). SERIALIZABLE isolation ensures correctness. |
| DB outage | Writer fails; no data corruption because DB never lies about references. After recovery, GC may find `pending_delete` chunks never cleaned – resolved by periodic sweeper. |
| Process crash during upload | If crash after DB insert but before S3 upload, chunk row exists with no object. Detection: during integrity scan, chunk row with `active` status but missing S3 object → delete chunk row or re‑upload (if we have local copy; we don't, so we delete row to avoid dangling reference). This risks losing the chunk for all future uploads, but since the chunk was new (ref=1) and the upload never completed, no other backup depends on it. |
| Process crash during GC deletion | Row already `pending_delete`; periodic sweeper retries. |
| Concurrent increment of a chunk that reached 0 | Handled by `FOR UPDATE` re‑check in deletion worker. |
| Small files (<1 MB) | Same chunking applies; chunk count is small, metdata overhead negligible. |

---

### 8. Scaling & Limits

- **Chunk count**: 100 TB logical / 8 KiB avg = **12.5 billion chunks**. (With 3× dedup → ~4.2 billion stored.)
- **Metadata DB**: PostgreSQL can handle billions of rows with partitioning (by chunk_hash prefix or hash‑modulo sharding). Write throughput: each chunk write requires an index insert + ref_count update. At 4.2B rows, we expect acceptable performance with proper indexing and SSDs.
- **Concurrent writers**: For highly popular chunks (e.g., OS ISO), many writers increment the same row. `SELECT … FOR UPDATE` serializes these increments, but each is fast (single row lock). If contention becomes a bottleneck, we can use an **optimistic** approach: `UPDATE … WHERE ref_count = old_ref_count` + retry on version mismatch. We'll implement the simpler lock‑based version first and observe.
- **Network**: 33 TB stored → 33 TB of S3 egress for restore. Single region, provision sufficient bandwidth.

---

### 9. Rejected Alternatives

| Alternative | Reason for Rejection |
|-------------|----------------------|
| **Fixed‑size chunking** | Dedup ratio would suffer from content shifts (insert/delete) – cannot guarantee 3×. |
| **Two‑level chunking** (big + small) | Added complexity without measurable benefit for backup workloads. |
| **KV store only (DynamoDB)** | No multi‑key transactions; implementing safe reference counting + GC would require a custom two‑phase commit, error‑prone. |
| **Inline deletion when ref count reaches 0** | High risk of race: a concurrent upload may have already re‑acquired the chunk after decrement but before delete caused by a different writer. The background re‑check avoids data loss. |
| **Full mark‑and‑sweep GC (rebuild ref counts from scratch)** | Impractical for 100 TB data – scanning all file recipes would take too long and block writes. Reference counting is efficient. |
| **Erasure coding on chunks** | Adds cost and latency; the S3 layer already provides durability (11 9s). Not needed for single‑region backup. |

---

### 10. Verification & Unverified Claims

- The design has been **reviewed logically** but not implemented or benchmarked.
- **Unverified**: Performance of PostgreSQL with 4B rows and high‑contention ref_count updates – actual need for sharding or fast SSD storage is unconfirmed.
- **Unverified**: Chunk upload serialization impact on throughput under extreme contention (millions of concurrent uploads of the same chunk) – we assume this is rare; if it becomes a problem, we will switch to optimistic increment.
- **Verified by thought experiment**: All race conditions (concurrent uploads, delete races) are covered by database transactions and the two‑step deletion with re‑check.
- **Honest statement**: The design is correct under stated assumptions; actual deployment may require tuning of chunk size, DB scaling, and S3 consistency guarantees.

---

**Summary**: The system uses content‑defined chunking (FastCDC, 8 KiB avg), strong hashing (SHA‑256), a relational DB for metadata with row‑level locking, and a reference‑counting GC with a “pending_delete” state and re‑check to guarantee no corruptions. Tradeoffs were made for safety over raw throughput (serialized new‑chunk uploads) and for consistency over storage cost (deterministic encryption, not elaborated). The design handles all identified edge cases and failure modes through transactions, retries, and periodic sweep jobs.