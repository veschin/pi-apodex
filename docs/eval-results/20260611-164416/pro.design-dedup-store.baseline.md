# Content-Addressable Deduplicated Blob Storage Design

## 1. Overview

We design a deduplication storage layer for an internal backup product that must
handle ~100 TB of logical data with a target dedup ratio ≥ 3×.  The underlying
object store is S3‑compatible; a relational database is available for metadata.
The system stores **content‑defined chunks**, addresses them by their
cryptographic hash, and maintains reference counts to enable safe garbage
collection.  Identical concurrent uploads are deduplicated before writing to S3
by coordinating through the metadata database.

## 2. Chunking & Content Addressing

### Algorithm
**Variable‑size content‑defined chunking (CDC)** using a rolling hash
(e.g. FastCDC with Rabin fingerprints).  Parameters are tuned for the backup
workload:

| Parameter          | Value      |
|--------------------|------------|
| Target average     | 1 MiB      |
| Minimum chunk size | 256 KiB    |
| Maximum chunk size | 4 MiB      |

- The average is chosen to balance dedup potential (large enough that similar
  large files still share many chunks after small insertions/deletions) versus
  the number of chunks (and therefore S3 objects and metadata rows).
- With 33 TB of unique data and 1 MiB average, the system will hold
  ≤ 33 million distinct chunk objects – a manageable number for per‑object S3
  operations and database indexing.

### Content addressing
Each chunk’s identity is its **SHA‑256** digest.  The key in the object store
is `chunks/<hex-encoded sha256>`, optionally sharded by prefix:
`chunks/ab/cdef0123…`.  This yields a flat, deterministic namespace with
no collisions (practical collision probability negligible at this scale).

*Rejected whole‑file dedup*: would miss partial file matches;  
*Rejected fixed‑size blocks*: content‑defined boundaries are essential for
high dedup under insertions and deletions.

## 3. Metadata Model (Relational Database)

The schema uses a few tightly normalised tables.  All operations that modify
reference counts or chunk status happen inside serialisable‑grade transactions.

```sql
-- Tracks every content‑addressable chunk known to the system.
CREATE TABLE chunks (
    hash        TEXT PRIMARY KEY,
    size        BIGINT  NOT NULL,
    refcount    INT     NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL CHECK (status IN ('uploading','ready','orphan')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON chunks (status, last_updated);   -- for GC scans

-- Logical backup entity.
CREATE TABLE backups (
    backup_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT,
    state       TEXT NOT NULL CHECK (state IN ('uploading','active','deleting','deleted')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);

-- One row per file in the backup (or per “segment” for very large files).
CREATE TABLE backup_files (
    file_id     BIGSERIAL PRIMARY KEY,
    backup_id   UUID NOT NULL REFERENCES backups(backup_id),
    path        TEXT NOT NULL,
    file_size   BIGINT,
    chunk_count INT,               -- total chunks in this file
    state       TEXT NOT NULL CHECK (state IN ('pending','committed')) DEFAULT 'pending'
);

-- Ordered chunk references for each file.
CREATE TABLE file_chunks (
    file_id     BIGINT NOT NULL REFERENCES backup_files(file_id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    chunk_hash  TEXT NOT NULL REFERENCES chunks(hash),
    PRIMARY KEY (file_id, chunk_index)
);
CREATE INDEX ON file_chunks (chunk_hash);   -- needed for GC reverse lookup
```

- `backup_files.state` is used to handle crash‑safe incremental commit of
  large files (see §4).
- `chunks.refcount` is always ≥ 0 and guarded by `status` to prevent
  resurrection of chunks already scheduled for deletion.

## 4. Upload Flow & Concurrent Dedup

A client (backup agent) writes a file by computing chunk hashes, ensuring each
chunk is stored in S3, then registering the chunk references for that file with
the database.

### 4.1 Chunk existence & upload coordination

For each chunk (processed in batches of up to 1000):

1. **Query** `chunks` for `hash`.  
   - If `status = 'ready'` → chunk already available, skip to referencing.
   - If `status = 'uploading'` (another agent is uploading) → poll until ready
     (short back‑off, max 30 s).  On timeout, abort the backup.
   - Otherwise (`'orphan'` or row missing) → start the upload procedure.

2. **Atomic claim** (becoming the uploader) – a single DB statement decides
   who uploads:
   ```sql
   INSERT INTO chunks (hash, size, status)
   VALUES ($1, $2, 'uploading')
   ON CONFLICT (hash) DO UPDATE
     SET status = 'uploading', size = $2, refcount = 0, last_updated = now()
     WHERE chunks.status IN ('orphan')
   RETURNING (xmax = 0) AS inserted, status;
   ```
   - If the row was *inserted* or *updated from 'orphan'*, this agent owns the
     upload.
   - If the row already existed with `status = 'ready'` or `'uploading'`,
     the `ON CONFLICT … DO UPDATE` predicate blocks the change, so the
     statement has no effect.  The agent then goes back to polling or sees
     `ready`.

3. **Upload to S3** (only the winning agent):
   - `PUT /chunks/<hash>` with the chunk blob.  S3 is strongly consistent, so
     concurrent identical puts are harmless but waste bandwidth; our
     coordination avoids most duplicates.
   - On success, `UPDATE chunks SET status = 'ready', last_updated = now()
     WHERE hash = $1`.
   - On transient failure, retry with back‑off.  On permanent failure,
     `DELETE FROM chunks WHERE hash = $1 AND status = 'uploading'` and signal
     the client to abort.

### 4.2 Referencing chunks in a backup

A single file may be too large to commit all chunk references in one
transaction (a 500 GB file with 1 MiB average chunks yields ~500 k chunks;
with 256 KiB minimum it could be millions).  Therefore a file is committed
**incrementally** using a state machine on `backup_files`:

1. Insert a row in `backup_files` with `state = 'pending'`.
2. For each batch of `file_chunks` rows (e.g. 1000 chunks):
   - Open a transaction.
   - `INSERT` the batch into `file_chunks` (using `chunk_index` order).
   - For every distinct `chunk_hash` in the batch:
     ```sql
     UPDATE chunks
     SET refcount = refcount + 1, last_updated = now()
     WHERE hash = any($batch_hashes) AND status = 'ready';
     ```
     The `WHERE status = 'ready'` ensures we never resurrect a chunk that has
     already been marked `'orphan'` by GC.
   - If the update affected fewer rows than expected, the transaction is rolled
     back and the client must re‑upload the missing chunk(s) (they became
     orphaned between the initial check and now – extremely rare).
   - Commit.
3. After the last batch, `UPDATE backup_files SET state = 'committed'`.
4. When all files of a backup are `committed`, the backup’s top‑level `state`
   is promoted from `'uploading'` to `'active'`.

### 4.3 Crash recovery during upload

- A `backup_files` row stuck in `'pending'` for > X hours (configurable,
  e.g. 6 h) is assumed abandoned.  A periodic sweeper marks it `aborted` and
  **decrements** the refcounts of its already‑committed batches (using a
  process symmetric to deletion, §5).  The backup itself stays `'uploading'`
  until all files are either committed or rolled back, then becomes `'active'`
  or is deleted completely.
- Orphan `chunks` rows with `status = 'uploading'` and `last_updated` older
  than a timeout (e.g. 1 h) are cleaned by GC (§5): the S3 object, if it
  exists, is deleted, and the metadata row removed.

## 5. Backup Deletion & Garbage Collection

### 5.1 Logical deletion
When a backup is deleted, the API atomically sets its `state = 'deleting'` and
commits.  A background worker then reclaims space:

For each `backup_files` row belonging to the backup:
- Select all `chunk_hash` entries from `file_chunks` in order.
- Process in batches (e.g. 1000 hashes), each in its own transaction:
  ```sql
  WITH decremented AS (
    UPDATE chunks
    SET refcount = refcount - 1, last_updated = now()
    WHERE hash IN (…) AND refcount > 0
    RETURNING hash, refcount
  )
  UPDATE chunks
  SET status = 'orphan', last_updated = now()
  WHERE hash IN (SELECT hash FROM decremented WHERE refcount = 0);
  ```
  This two‑step (or a `CASE`) guarantees that only chunks whose refcount drops
  to zero become orphans.
- After all chunk hashes of a file are processed, `DELETE FROM backup_files`
  (cascades to `file_chunks`).
- Once no `backup_files` rows remain, set the backup’s `state = 'deleted'`.

The worker is idempotent: re‑executing a batch will decrement only if
`refcount > 0`.

### 5.2 Physical garbage collection (GC)
A separate periodic job scans for chunks eligible for physical deletion:

```sql
-- With an index on (status, last_updated)
SELECT hash
FROM chunks
WHERE status = 'orphan'
  AND last_updated < now() - interval '5 minutes'  -- safety margin
LIMIT 1000;
```

For each such hash:
- `DELETE FROM S3 /chunks/<hash>` (ignore 404).
- `DELETE FROM chunks WHERE hash = $1 AND status = 'orphan'`.

The 5‑minute margin gives enough time for any in‑flight backup creation
transaction that might have already read the chunk as `'ready'` to finish its
`UPDATE … WHERE status = 'ready'` and notice failure (the update would match
zero rows).  That transaction would have failed before the margin, forcing the
backup to re‑upload the chunk – a safe outcome.

`uploading` chunks that have timed out are handled similarly: `status =
'uploading'` with `last_updated < now() - interval '1 hour'` → delete S3
object (if any) and DB row.

### 5.3 Safety guarantees
- A chunk with `refcount > 0` is **never** physically removed, because its
  status remains `'ready'`.
- No new backup can increase the refcount of a chunk while it is `'orphan'`
  (the `UPDATE … WHERE status = 'ready'` would skip it).
- The design does **not** require a global “mark and sweep” pause; refcount
  updates and GC work concurrently with row‑level locking.

## 6. Failure Handling

| Failure Scenario              | Handling                                                                                                                                                               |
|-------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Client crash mid‑upload       | Stranded `uploading` chunk → GC after timeout.  Partially‑committed file batches → backup sweeper rolls back refcounts.                                                |
| S3 PUT failure (transient)    | Retry with exponential back‑off (≥ 3 attempts).                                                                                                                       |
| S3 PUT failure (permanent)    | Uploader deletes `chunks` row (status `uploading`).  Client aborts the backup.                                                                                         |
| DB transaction failure        | Standard ACID retry.  Batched operations limit blast radius.                                                                                                           |
| DB connection loss            | Client reconnects; idempotent chunk status checks allow resumption from the last known good batch.                                                                     |
| Concurrent deletions & uploads| Row‑level locks on `chunks` during refcount updates prevent negative refcount.  Increment uses strict `status = 'ready'` guard.                                        |

All background jobs (deletion worker, GC, sweeper) use **idempotent logic** so
they can be safely restarted after a failure.

## 7. Scaling Limits & Tuning

- **Chunk object count**: 100 TB logical → ~33 TB unique (3× dedup).  
  With 1 MiB average → ~33 M objects.  S3 can comfortably handle ≥ 100 M
  objects if keys are randomly distributed (SHA‑256 ensures this).  Raising the
  average chunk size to 4 MiB would drop this to ~8 M, at a slight cost in
  dedup ratio; the CDC parameters can be tuned per workload.
- **Metadata database**: 33 M rows in `chunks` is ~3‑4 GB of data plus
  indexes.  A modern PostgreSQL instance with enough memory easily handles this.
  Hash‑partitioning by the first few bytes of `hash` can be added later if the
  table grows beyond a single node.
- **Transaction batch size**: Batching `file_chunks` inserts and refcount
  updates in groups of 500–1000 keeps transactions short and avoids lock
  escalation.  The backup coordinator can stream batches as chunks are produced.
- **Concurrent uploads**: The `INSERT … ON CONFLICT` pattern serialises upload
  of the same chunk to a single writer; contention is limited because different
  chunks have different hashes.  Chunk hashing and S3 uploads are parallelised
  across many chunks, keeping throughput high.

## 8. Rejected Alternatives

| Alternative                        | Why rejected |
|------------------------------------|--------------|
| Fixed‑size block chunking (e.g. 1 MiB blocks) | Very poor dedup when data is inserted or deleted – a single byte shift changes every subsequent block boundary. |
| Deduplication entirely inside the DB (storing blobs) | DB BLOB storage is expensive and not scalable to 33 TB; S3 is cheaper and purpose‑built. |
| Refcounting using S3 object tags or S3 Inventory | Tags are eventually consistent; constructing a globally consistent refcount across millions of objects is impractical. |
| Using a KV store as the primary metadata store | No multi‑row transactions or efficient join semantics, making it much harder to atomically update refcounts across thousands of related keys. |
| Single‑transaction manifest commit for an entire multi‑TB file | A single transaction spanning millions of rows would likely exceed database timeouts and lock resources for too long. |
| Chunk packing (many small chunks in one S3 object) | Reduces S3 object count but adds complexity to GC (must rewrite packs on deletion) and requires a separate index.  With 1 MiB average chunks, object count is acceptable; packing can be added later if observation proves a cost issue. |
| Immediate physical deletion when refcount hits 0 | Unsafe because a pending backup creation may have already read the chunk and is about to increment refcount.  The short grace period + `status` guard avoids races without long data retention. |

## 9. Verification & Open Items

The design is based on well‑known distributed storage patterns (content‑defined
chunking, CAS with reference counting, atomic DB coordination).  No prototype
was built for this answer, so the following carry **unverified** status and
should be validated in a realistic test environment:

- Exact throughput numbers for CDC hashing and S3 upload pipelining (expected
  to be network‑bound, not CPU‑bound).
- The safety of the 5‑minute GC grace window under worst‑case transaction
  latency (can be increased to minutes/hours if observation shows rare failures).
- Database index effectiveness on 33 M+ rows – `EXPLAIN` plans and actual
  vacuum behaviour should be measured.
- Recovery of a partially‑uploaded backup with millions of committed chunks
  (the sweeper rollback path) – its runtime and idempotency must be tested.

Nevertheless, the architecture provides a concrete, implementable foundation
that meets the stated constraints and handles the common failure and concurrency
scenarios explicitly.