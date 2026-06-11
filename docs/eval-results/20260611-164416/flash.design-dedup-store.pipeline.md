## Content-Addressable Deduplicated Blob Storage – Engineering Design

### 1. Overview
We design a single‑region, S3‑backed blob store that deduplicates backup data at the chunk level.  
**Assumptions**  
- Writers can hold a connection open for the duration of an upload (typical for backup agents).  
- The metadata store is a strongly consistent relational database (e.g., PostgreSQL with synchronous replication) or a consistent KV store that supports atomic counters and secondary indexes. We assume a relational database for the clarity of ACID and joins.  
- Object storage is S3‑compatible. We assume read‑after‑write consistency for new objects (GCS, AWS S3 in some regions) – we design to handle eventual consistency for deletions and list operations. **If the store provides only eventual consistency for new objects, we would need to buffer chunk metadata until the object is visible (this remains unverified).**  
- Network is reliable enough that retries succeed within a few seconds.  

**Approach**  
- **Variable‑sized chunks** (content‑defined chunking) to preserve high dedup when files are modified.  
- **SHA‑256 hash** as the content address – stored as a 32‑byte binary key.  
- **Reference counting** with a soft‑delete grace period to handle races between uploads and deletions.  
- Periodic **audit** to correct reference counts and collect orphaned chunks.

---

### 2. Chunking
- **Algorithm**: FastCDC (or Gear‑based CDC). **We plan to use an average chunk size of 16 KB with min 8 KB, max 64 KB. This is a design choice expected to balance dedup ratio against metadata count; the exact tuning requires benchmarking with representative data and remains unverified.**  
- **Why variable**: Fixed‑size chunks suffer from boundary‑shift when files are inserted/deleted, drastically lowering dedup on backup workloads. CDC adapts to content changes.  
- **Implementation**: Compute the chunk hash (SHA‑256) on the client or server. To offload compute, the server can re‑hash after receiving raw data; **we choose client‑driven chunking (unverified assumption: client pre‑computes hash and sends payload; server verifies the hash before storing). This is intended to minimize network round‑trips – the client sends a stream of chunk payloads, each prefixed with its length and pre‑computed hash.**

---

### 3. Addressing
- **Address** = `SHA‑256(chunk_data)`, represented as 32 bytes.  
- **S3 key**: `chunks/xx/xxx...` where `xx` is the first byte (hex) of the hash, forming a two‑level prefix tree.  
  - Example: hash `a1b2c3d4…` → key `chunks/a1/a1b2c3d4…`.  
  - This spreads objects across S3 partitions, avoiding hot keys and staying within S3 request rate limits.  
- **No versioning** – content addressing means each hash maps to exactly one immutable object.  

---

### 4. Metadata Store (Relational Database)

#### 4.1 Tables

```sql
-- One row per logical backup (e.g., a full VM backup)
CREATE TABLE backups (
    backup_id      BIGSERIAL PRIMARY KEY,
    tenant_id      INT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status         VARCHAR(16) NOT NULL DEFAULT 'active', -- 'active', 'deleted'
    deleted_at     TIMESTAMPTZ
);
-- Partition by tenant or keep small (backup count is ~100K–1M)

-- One row per file within a backup
CREATE TABLE files (
    file_id        BIGSERIAL PRIMARY KEY,
    backup_id      BIGINT NOT NULL REFERENCES backups(backup_id),
    path           TEXT NOT NULL,
    size           BIGINT NOT NULL,
    chunk_count    INT NOT NULL
);
-- Index: (backup_id) for listing files

-- Mapping from file to ordered list of chunks
-- Chunk_hash is BINARY(32) for size and comparison speed
CREATE TABLE file_chunks (
    file_id        BIGINT NOT NULL REFERENCES files(file_id),
    chunk_hash     BYTEA NOT NULL, -- 32 bytes
    offset_in_file BIGINT NOT NULL,
    length         INT NOT NULL,
    PRIMARY KEY (file_id, offset_in_file)
);
-- Partition file_chunks by file_id (or by chunk_hash for GC scanning)
CREATE INDEX idx_fc_chunk_hash ON file_chunks(chunk_hash);

-- Deduplicated chunk registry
CREATE TABLE chunks (
    chunk_hash     BYTEA PRIMARY KEY, -- 32 bytes
    size           INT NOT NULL,
    ref_count      BIGINT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pending_delete TIMESTAMPTZ   -- non‑NULL if marked for deletion
);
```

#### 4.2 Partitioning
To handle billions of rows:
- `chunks` partitioned by `chunk_hash` prefix (first byte) into 256 tables (using PostgreSQL declarative partitioning).  
- `file_chunks` partitioned similarly or by file_id range; we choose range partitioning on `file_id` to keep restore queries local to a few partitions.  
- Use BRIN indexes on `chunks` and `file_chunks` for space‑efficient scanning of large tables.

#### 4.3 Scaling alternative
If the relational database cannot sustain the write/scan throughput, we would migrate to a distributed KV store (e.g., FoundationDB) with the same logical schema, sacrificing some query convenience for scale. Our design remains consistent with both.

---

### 5. Upload Workflow

#### 5.1 Happy Path
1. **Client opens backup** (creates a `backups` row).  
2. **Client chunks the file**, computes SHA‑256 for each chunk.  
3. For each chunk, the client sends `<hash, length, payload>` to the server.  
4. **Server verifies** the hash of the received payload.  
5. **Server dedup check**:  
   - `BEGIN` transaction (serializable isolation).  
   - `SELECT chunk_hash FROM chunks WHERE chunk_hash = ?`  
   - If **not found**:  
     - Upload chunk to S3 (key derived from hash).  
     - `INSERT INTO chunks (chunk_hash, size, ref_count) VALUES (?, ?, 1)`.  
   - If **found**:  
     - `UPDATE chunks SET ref_count = ref_count + 1, pending_delete = NULL WHERE chunk_hash = ?`.  
     - (Cancel any pending deletion.)  
   - Also `INSERT INTO file_chunks (file_id, chunk_hash, offset, length)`.  
   - `COMMIT`.  
6. After all chunks, update `files.size` and `files.chunk_count`.  
7. Client finalizes backup.

#### 5.2 Race Conditions
- **Concurrent upload of same chunk**: The second writer’s `INSERT INTO chunks` will see the first writer’s row (due to serializable isolation). **We assume the following pattern works correctly (unverified)**:  
  ```sql
  INSERT INTO chunks (chunk_hash, size, ref_count) 
  VALUES (?, ?, 1) 
  ON CONFLICT (chunk_hash) DO UPDATE SET ref_count = chunks.ref_count + 1, 
                                         pending_delete = NULL;
  ```
  This avoids duplicates and correctly increments `ref_count`.  
- **Deletion concurrent with upload**: If a chunk’s `ref_count` is decremented to 0 *before* the upload’s increment is applied, the upload finds the row and increments, preventing premature deletion. The `pending_delete` is cleared.  
- **Upload failure after S3 put**: If the server crashes after writing to S3 but before the DB transaction, the chunk object is orphaned. The audit GC will clean it up (see §7). No data loss.

---

### 6. Deletion Workflow

1. Mark `backups.status = 'deleted'`, `deleted_at = NOW()`.  
2. For each file in the backup, fetch its chunk hashes.  
3. In batches (1000 chunks per batch):  
   - `BEGIN`  
   - `UPDATE chunks SET ref_count = ref_count - 1 WHERE chunk_hash = ? AND ref_count > 0`  
   - If `ref_count` becomes 0, set `pending_delete = NOW() + INTERVAL '7 days'`.  
   - `DELETE FROM file_chunks WHERE file_id IN (...))`  
   - `COMMIT`  
4. Delete `files` and `backups` rows after all chunks processed.  

**Why soft‑delete & grace period**:  
- Prevents deleting a chunk that is being read or uploaded by a concurrent operation.  
- Provides time for audit to detect errors.  
- Allows simple recovery if a deletion was accidental (re‑increment ref count).  
**Note: The soft‑delete mechanism with a 7‑day grace period is a design choice; its implementation details and effectiveness remain unverified.**

---

### 7. Garbage Collection

GC runs as a background process every few hours.

#### 7.1 Reference‑count driven GC
1. **Query chunks** with `pending_delete IS NOT NULL AND pending_delete < NOW()`.  
2. For each such chunk:  
   - `BEGIN`  
   - Re‑read `chunks` row with `SELECT ... FOR UPDATE`.  
   - If `ref_count` is still 0 and `pending_delete` is in the past:  
     - Delete S3 object (key = `chunks/xx/hash`).  
     - `DELETE FROM chunks WHERE chunk_hash = ?`.  
     - `DELETE FROM file_chunks WHERE chunk_hash = ?` (should already be empty).  
   - Else (ref_count > 0): do nothing (a concurrent upload resurrected the chunk).  
   - `COMMIT`  
3. **Handle S3 eventual consistency**: Use a separate listing to verify deletion; if object still exists, retry. This is safe because no active reads should occur after DB removal.

#### 7.2 Audit GC (periodic)
- **We plan to run audit GC every 24 hours (unverified).** It recomputes reference counts from scratch:  
  `SELECT chunk_hash, COUNT(*) AS rc FROM file_chunks GROUP BY chunk_hash`  
- Compare with `chunks.ref_count`. Correct any discrepancies (should be rare) and update `pending_delete` for zeros.  
- Also find chunks that exist in S3 but are absent from `chunks` – these are orphans from partial uploads. Delete them.

#### 7.3 Tradeoff
- **Reference counting** enables incremental GC with low per‑transaction impact, but risk of overflow/corruption.  
- **Full mark‑and‑sweep** (no ref counts) is simpler but requires scanning all `file_chunks` (billions of rows) on each run – too expensive for daily GC.  
- Our hybrid (ref counting + periodic audit) gives fast incremental operations with occasional full reconciliation.

---

### 8. Failure Handling

| Failure                      | Mitigation |
|------------------------------|------------|
| **Upload incomplete** (client crashes) | Orphaned chunks remain in S3 and DB. Audit GC finds them (S3 object exists, chunk row appears with `ref_count=0` after grace period). |
| **S3 write error**           | Retry with exponential backoff. After 3 failures, abort the upload transaction; no metadata committed. |
| **DB transaction deadlock**  | Retry whole transaction (up to 3 times). Use `pg_advisory_xact_lock` for chunk‑level serialization. |
| **Metadata store outage**    | Reject new uploads; serve reads from read replicas (eventually consistent). GC pauses. |
| **S3 object corruption**     | On read, verify hash. If mismatch, fetch from another source (if replicated) or error to client. Content addressing ensures integrity. |
| **Reference count overflow** | Use `BIGINT` (2^63, impossibly large). Audit will catch if count ever exceeds reasonable limits. |
| **Concurrent backup deletion and restoration** | Restore reads chunks and verifies hashes. If a chunk is pending deletion but not yet physically deleted, restore works. If physically deleted (race), restore fails – we reduce risk with grace period and re‑extend before deletion. |

---

### 9. Tradeoffs and Rejected Alternatives

| Alternative | Reason for Rejection |
|-------------|----------------------|
| **Fixed‑size chunks** | Lower dedup ratio when files are modified; backup workloads see many small changes (mail stores, logs). |
| **Server‑side chunking only** | Network overhead – client must buffer entire file or send raw data, increasing latency and server memory. Client‑side chunking with pre‑computed hashes reduces server work. |
| **No reference counting; full scan GC** | Scanning 10+ billion `file_chunks` rows daily is prohibitive even with partitioning. GC would take hours and impact concurrent operations. |
| **Immediate chunk deletion on ref_count=0** | Race with in‑flight uploads can cause data loss. Soft‑delete + grace period is safe. |
| **Single S3 bucket with flat keys** | S3 performance degrades with many objects in one prefix. Two‑level prefix avoids throttling. |
| **Storing chunk locations in S3 metadata** | S3 object metadata is limited (2 KB). We need strong consistency for ref counts and file mapping – rely on DB. |
| **Using only a KV store (e.g., DynamoDB)** | Equivalent design is possible with DynamoDB transactions and GSIs, but GC scans become more expensive; we choose relational for easier querying during development. For production scale beyond 100 TB, we would switch to a distributed KV. |

---

### 10. Verification Status

**What was observed/verified from the design text (without external execution evidence):**  
- SHA‑256 content addressing with 32‑byte binary keys.  
- S3 key format using two‑level prefix (`chunks/xx/...`).  
- Metadata tables: `backups`, `files`, `file_chunks`, `chunks`.  
- Periodic garbage collection includes both reference‑count driven and daily audit components.  
- Rejection of fixed‑size chunks, immediate deletion, full mark‑and‑sweep GC, server‑side chunking only, and single S3 bucket with flat keys.

**What remains unverified (design assumptions or intended behaviors not backed by execution evidence):**  
- The specific chunk size configuration (16 KB average, 8 KB min, 64 KB max) achieving the target dedup ratio ≥3×. Benchmarking is required.  
- Client‑driven chunking as described (client pre‑computes hash, server verifies) – the design asserts this but provides no test or prototype.  
- The `INSERT ... ON CONFLICT DO UPDATE` pattern for concurrent uploads – its correctness under serializable isolation is assumed.  
- The soft‑delete mechanism with a 7‑day grace period – implementation details are assumed but not demonstrated.  
- The 24‑hour schedule for audit GC – this is a planning target, not yet executed.  
- S3 read‑after‑write consistency for new objects – if the underlying store provides only eventual consistency, a different metadata approach (e.g., delayed referencing) would be needed; this is not yet designed in detail.  
- Overall storage efficiency (dedup ratio ≥3×) – the design targets it, but no measurements exist.

**Open items (issues that cannot be fixed from available materials):**  
- We cannot provide execution evidence for any of the above unverified items. They remain design choices to be validated during implementation.  
- No concrete fallback for eventual consistency of new objects is designed; this is flagged as an open risk.

**Summary**  
The design provides a concrete architecture for a deduplicated backup blob store meeting the given constraints, with clear tradeoffs and rejected alternatives. All load‑bearing claims that are unsupported have been explicitly marked as unverified. The solution is ready for implementation, but the unverified aspects must be validated through prototyping, benchmarking, and operational experience.