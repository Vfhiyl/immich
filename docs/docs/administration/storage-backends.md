# Storage Backends

By default Immich keeps every file in its media location (`UPLOAD_LOCATION`). Storage backends let it keep files somewhere else instead: in a folder of its own, or in a bucket of any service that speaks the S3 protocol (Tencent Cloud COS, Alibaba Cloud OSS, AWS S3, Backblaze B2, Cloudflare R2, MinIO, …). Files on a backend can be encrypted by Immich before they leave the server.

Without a storage backend configuration nothing changes: Immich works exactly as before.

:::danger
Storage backends, master keys, deletion delays and replicas are configured in a file and in environment variables only, never in the web interface. Read this page completely before you configure them, and test your setup (see [Testing a bucket](#testing-a-bucket)) before you upload photos.
:::

## What goes where

Every backend has a role:

| Role        | Holds                                                                                             | Read                             |
| ----------- | ------------------------------------------------------------------------------------------------- | -------------------------------- |
| `originals` | The uploaded photos and videos, their sidecars, and the videos of motion photos                   | when a photo is opened           |
| `derived`   | Thumbnails, previews, encoded videos, faces of people, profile images: what Immich can make again | constantly, cached on the server |
| `backup`    | The daily database backups, always encrypted                                                      | only to restore                  |
| `replica`   | Copies of the files of other backends, see [Replicas](#replicas)                                  | only when a backend is lost      |

Files get random names (UUIDs) and no metadata on the service: the bucket does not tell whose photos it holds or what they show. The server keeps temporary files, a processing copy of new uploads and a cache of thumbnails in the media location, so it still needs some local disk (a few tens of GiB).

A common setup on a cloud server:

- originals in a bucket, encrypted;
- derived files on the local disk of the server (fast and cheap), or in a second bucket;
- database backups in a third bucket, encrypted;
- a replica in another account, or with another provider, with object lock.

## Buckets

Create one bucket per role, or one bucket with a prefix (folder) per role. Separate buckets let you give each one its own permissions, lifecycle rules and storage class.

- **Private**: no public access, no website hosting.
- **Region**: the region of your server, so that Immich can use the internal endpoint of the service (see your provider's documentation for the endpoint servers in the same region use). Traffic over the internal network is usually free; traffic over the public endpoint is billed as outbound traffic.
- **Storage class**: standard (hot) storage for `originals` and `derived`, since photos are read whenever they are opened. An infrequent access class works for originals if you rarely open old photos, but reads cost more. Archive classes must be restored before anything can be read: use them only for replicas.
- **Lifecycle rule (required)**: abort incomplete multipart uploads after 7 days. Immich aborts the uploads it gives up on itself, but an upload of a process that was killed stays, and is billed, until the service removes it.
- **Versioning**: not needed for the backends Immich writes to. Immich never overwrites a file, and deletes files only after their [deletion delay](#deleting-files).
- **Object lock**: only for replicas, see [Replicas](#replicas).

## Credentials

Secrets are never written into the configuration file. Either give the access key id in the file and the secret in a file of its own (`secretAccessKeyFile`), or use the credential chain of the AWS SDK (`type: chain`: environment variables, shared credentials files, `credential_process`, instance roles).

Use separate credentials for separate jobs:

| Credentials           | Needs                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `credentials`         | read, write and list objects, and multipart uploads (create, upload part, complete, abort, list parts); **no delete** |
| `deletionCredentials` | delete objects                                                                                                        |

With `deletionCredentials`, only the cleanup of deleted files can delete objects: a leaked key of the server cannot erase your photos. In AWS IAM terms the first set is `s3:GetObject`, `s3:PutObject`, `s3:ListBucket`, `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts`, the second `s3:DeleteObject`; other services name the same permissions differently, see their documentation.

## Configuration

Point `IMMICH_STORAGE_BACKENDS` at a YAML (or JSON) file, in the `.env` file next to `docker-compose.yml`, and mount the file, the secret files and the master key file into the `immich-server` container, e.g. with a folder of their own:

```yaml title="docker-compose.yml"
services:
  immich-server:
    volumes:
      # … the volumes that are there already
      - /path/on/the/host/immich-config:/config/immich:ro
```

```bash title=".env"
IMMICH_STORAGE_BACKENDS=/config/immich/storage.yaml
```

Create the master key file (see [Encryption](#encryption)) with the folder mounted writable, then make it read-only.

```yaml title="storage.yaml"
encryption:
  # base64 encoded 256-bit keys, one per line; the first one encrypts new files
  masterKeyFile: /config/immich/master.key

backends:
  - id: originals
    role: originals
    driver: s3
    endpoint: https://cos.ap-shanghai.myqcloud.com # the internal endpoint, if your server is in the same region
    region: ap-shanghai
    bucket: photos-originals-1250000000
    addressing: virtual-host # or path, for services that need it
    credentials:
      type: static
      accessKeyId: AKID...
      secretAccessKeyFile: /config/immich/originals.secret
    deletionCredentials:
      type: static
      accessKeyId: AKID...
      secretAccessKeyFile: /config/immich/originals-deletion.secret
    # encrypted: true is the default for S3 backends

  - id: derived
    role: derived
    driver: local
    root: /data/derived

  - id: backups
    role: backup
    driver: s3
    endpoint: https://cos.ap-shanghai.myqcloud.com
    region: ap-shanghai
    bucket: photos-backups-1250000000
    credentials:
      type: chain
      profile: immich-backups

deletion:
  # how long deleted originals stay recoverable; at least 30
  delayDays: 360

databaseBackups:
  # how many database backups the backend for backups keeps
  keepLast: 14
```

| Field                          | Meaning                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                           | Recorded with every file. **Never change or reuse it** once files are stored: Immich refuses to start while files are recorded on a backend that is not configured.        |
| `role`                         | `originals`, `derived`, `backup` (one backend each) or `replica` (any number)                                                                                              |
| `driver`                       | `s3` or `local`                                                                                                                                                            |
| `root`                         | (`local`) the folder of the backend, inside the container                                                                                                                  |
| `endpoint`, `region`, `bucket` | (`s3`) where the bucket is                                                                                                                                                 |
| `prefix`                       | (`s3`) a folder in the bucket, ending with `/`, so that backends can share a bucket                                                                                        |
| `addressing`                   | (`s3`) `virtual-host` (default) or `path`                                                                                                                                  |
| `encrypted`                    | Whether new files are encrypted; `true` by default for `s3`, `false` for `local`. Files keep how they were written when this changes. The backup role is always encrypted. |

Immich checks the file when it starts, and writes, reads back and deletes a probe on every backend; it does not start when something is wrong, and says why.

Files stored before a backend was configured stay where they are and keep working: only new files go to the backend.

## Encryption

Files are encrypted on the server with AES-256-GCM, in chunks of 64 KiB, each file with a random key that a master key wraps. Every encrypted object also describes itself (its owner, original file name, size and SHA-1, encrypted), so that photos can be recovered with nothing but the bucket and the master key.

Create the master key file before the first start (the image runs its command with `bash -c`, so commands are quoted):

```bash
docker compose run --rm immich-server 'immich-encryption generate-key /config/immich/master.key'
```

:::danger
**Without the master key file, encrypted photos cannot be read, by anyone, ever.** Keep at least two copies offline, in different places, away from the bucket and the server: printed on paper, in a password manager, on a USB stick in a safe. Immich refuses to start if the key file lost a key that encrypted files.
:::

To replace the key, add a new one; the old keys must stay in the file, since the files they encrypted keep using them:

```bash
docker compose run --rm immich-server 'immich-encryption generate-key --rotate /config/immich/master.key'
```

`immich-encryption inspect <object>` shows how a downloaded object is encrypted, and `immich-encryption decrypt --keys <key file> <object> <output>` decrypts it, without Immich.

## Deleting files

When a photo is deleted permanently (or emptied from the trash), its files are not deleted from the backend at once: originals stay for `deletion.delayDays` (360 days by default), derived files for 30 days. Until then an administrator can look at deleted originals, recover them as new photos, or delete one at once after entering their password (`/api/admin/storage/deletions/originals`).

A longer delay applies to originals deleted before too; a shorter one only to originals deleted after the change. If more than 2% of all originals (and at least 100) would be deleted at once, the cleanup pauses and notifies the administrator, who has to resume it (`POST /api/admin/storage/deletions/resume`): deleting that much at once is more likely a mistake or an attack than intended.

## Replicas

A replica holds copies of the files of other backends, made by Immich: new originals are copied within minutes, database backups when they are stored. Copies are checked by size, and failed copies are tried again with growing pauses; an administrator is notified when copies keep failing. Every 14 days Immich lists each replica and compares it with what it should hold: missing copies are made again, and objects that should not be there are reported, never deleted.

```yaml
backends:
  # … originals and backups as above
  - id: replica-1
    role: replica
    replicaOf: [originals, backup]
    driver: s3
    endpoint: https://oss-cn-hangzhou.aliyuncs.com
    region: cn-hangzhou
    bucket: photos-replica
    credentials: { type: static, accessKeyId: ..., secretAccessKeyFile: /config/immich/replica.secret }
    deletionCredentials: { type: static, accessKeyId: ..., secretAccessKeyFile: /config/immich/replica-deletion.secret }
```

- Put a replica **in another account, or with another provider**, so that losing one account (a mistake, a suspension, an attack) does not lose both copies.
- Turn on versioning and object lock (compliance mode) on the replica bucket, with a retention **no longer than `deletion.delayDays`**: a locked copy cannot be deleted by anyone, and Immich deletes copies after the deletion delay, retrying until the lock has expired.
- A replica can use an archive storage class, set by a lifecycle rule: it is only read when a backend is lost.
- A replica holds the files exactly as stored, still encrypted. A replica with `encrypted: true` (the default for `s3`) refuses to copy a backend that is not encrypted.

A replica keeps the files of each backend in a folder named after its id, under their own keys. **If a backend is lost**, configure the backend with that folder of the replica, e.g. for the backend `originals` the replica bucket with `prefix: <replica prefix>originals/`, and restart Immich: nothing else changes. Restoring from an archive class has to be done first, in the console of the provider.

`GET /api/admin/storage/replicas` shows each replica: copied, waiting, failing, and since when the oldest copy waits (what losing the backend now would lose). `POST /api/admin/storage/replicas/<id>/retry` tries failed copies again.

## Database backups

The daily database backups (see [Backup and Restore](./backup-and-restore.md)) are also stored on the backend for backups, encrypted, and on its replicas; `databaseBackups.keepLast` of them are kept, with the same "only extend" rule as the deletion delay. Each one describes itself, so they can be listed with nothing but the bucket and the master key.

`GET /api/admin/storage/database-backups` lists them, `POST /api/admin/storage/database-backups/<key>/fetch` copies one back into the backups folder, from where it is restored like any backup.

## Disaster recovery

**The server is lost, the buckets and the master key file are not**:

1. Install Immich on a new server with the same `.env`, the same storage configuration, the secret files and the master key file.
2. Start it with an empty database and create an admin user.
3. Fetch the latest database backup: `POST /api/admin/storage/database-backups/<key>/fetch` (list them first).
4. Restore it from the backups in maintenance mode, as described in [Backup and Restore](./backup-and-restore.md). Every phone then syncs its library anew.

**A bucket is lost**: point the backend at its replica, see [Replicas](#replicas).

**Immich itself cannot run**: export every photo with `immich-export`, which needs no running Immich, only a PostgreSQL with a database backup:

1. Download the objects of the backend for backups (there are only `keepLast` of them) with the tools of your provider, and decrypt them. Each one tells which backup it is:

   ```bash
   docker run --rm -v /restore:/restore -v /config/immich:/config/immich ghcr.io/immich-app/immich-server:<version> \
     'immich-encryption decrypt --keys /config/immich/master.key /restore/<object> /restore/backup.sql.gz'
   # … filename: immich-db-backup-20261022T020000-v3.3.4-pg14.19.sql.gz
   ```

2. Restore the newest one into an empty PostgreSQL of the same image as the `immich_postgres` container, the same way as in [Backup and Restore](./backup-and-restore.md):

   ```bash
   docker network create immich-restore
   docker run -d --name immich_restore --network immich-restore \
     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=immich ghcr.io/immich-app/postgres:<the tag in docker-compose.yml>
   gunzip --stdout /restore/backup.sql.gz \
   | sed "s/SELECT pg_catalog.set_config('search_path', '', false);/SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', true);/g" \
   | docker exec -i immich_restore psql --dbname=immich --username=postgres --single-transaction --set ON_ERROR_STOP=on
   ```

3. Export:

   ```bash
   docker run --rm --network immich-restore -v /config/immich:/config/immich -v /export:/export \
     ghcr.io/immich-app/immich-server:<version> 'immich-export --storage /config/immich/storage.yaml \
     --database postgres://postgres:postgres@immich_restore:5432/immich --output /export'
   ```

Photos are written to `<user>/<year>/<date>/<file name>`, each with a `.json` file of everything Immich knows about it and an `.xmp` sidecar (dates, place, description, rating, tags, people) that other photo applications read. Without any database, `immich-export --storage … --output …` still exports every original by what its encrypted object describes: its file name and owner. An export can be stopped and run again.

## Checks and reports

With storage backends, the integrity checks of **Administration → Maintenance** check the backends instead, on the same schedule and within the same limits: every day each backend is listed and compared with what is recorded (missing files, files nothing records, files of another size), and files are read back, decrypted and checked against their SHA-1 in turn. A problem is reported once two runs saw it; checks never change or delete anything. The reports are at `/api/admin/storage/checks`, and kept for three years.

## Costs

Immich counts every request to every service, by day and by what made it (a background job, or users), and records every night what each backend stores. Fill in the prices of your provider in **Administration > Settings > Storage Prices** (or in the configuration file, `IMMICH_CONFIG_FILE`) to get estimates on **Administration > Storage > Usage and costs** (`GET /api/admin/storage/usage`):

```json
{
  "storagePricing": {
    "backends": [
      {
        "backendId": "originals",
        "currency": "CNY",
        "storageGbMonth": 0.118,
        "writeRequests10k": 0.01,
        "readRequests10k": 0.01,
        "deleteRequests10k": 0,
        "egressGb": 0,
        "monthlyBudget": 50
      }
    ]
  }
}
```

These numbers are only an example: take the prices from the official price list of your provider and region. GiB are 2<sup>30</sup> bytes and months 30 days. Requests over the internal network usually cost the same as over the public one, but traffic does not (`egressGb: 0`). The estimates leave out discounts, free quotas, minimum storage durations and the server itself: the bill of the provider is what counts.

`monthlyBudget` is optional. With one, the usage page shows what the calendar month (UTC) cost so far and will cost at that pace, and the administrator gets a notification once a month when a backend is on course to exceed its budget, and once more when it did. Nothing is paused: background jobs go on as before.

## Other settings

| Environment variable                | Meaning                                                                                                                                                                | Default |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `IMMICH_STORAGE_BACKENDS`           | The storage backend configuration file                                                                                                                                 |         |
| `IMMICH_UPLOAD_MAX_APPEND_SIZE`     | The largest request a resumable upload sends, in bytes, for proxies that limit request bodies (e.g. `100000000` behind Cloudflare)                                     |         |
| `IMMICH_SYNC_DELETE_RETENTION_DAYS` | How long the records of deletions are kept for phones to sync, in days (at least 30), or `forever`. A phone that did not sync for longer syncs its whole library anew. | `365`   |

Real-time transcoding (HLS) is not available for originals on a storage backend. Let Immich encode videos for playback instead, e.g. with the transcode policy `optimal` and a target resolution of `1080` in **Administration → Settings → Video Transcoding**.

## Testing a bucket

Immich only relies on what every S3 service documents, and is tested against two independent implementations (versitygw and SeaweedFS), including the failures services are allowed to have. To check a bucket of your provider before you use it, run the same tests against it from a checkout of the source code. They write below a prefix of their own and remove what they wrote; use a test bucket anyway.

```json title="real-bucket.json"
{
  "name": "my provider",
  "endpoint": "https://cos.ap-shanghai.myqcloud.com",
  "region": "ap-shanghai",
  "bucket": "immich-test-1250000000",
  "addressing": "virtual-host",
  "accessKeyId": "AKID...",
  "secretAccessKeyFile": "/path/to/secret"
}
```

```bash
cd server
IMMICH_CONTRACT_REAL_S3=/path/to/real-bucket.json pnpm run test:real-storage
```

The credentials need the permissions of both credential sets above, since the tests also delete.
