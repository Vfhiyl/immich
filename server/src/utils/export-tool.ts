import { Kysely, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import type { ToolOutput } from 'src/utils/encryption-tool.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageBackendRole } from 'src/enum.js';
import { createVerifyingStream } from 'src/repositories/blob-store.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RecordedFile, StorageBackendRepository, readBlob } from 'src/repositories/storage-backend.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';

/**
 * The `immich-export` command: every original with its metadata, in folders people can read, with nothing but the
 * storage backends, the master key file and either a database (e.g. a database backup restored into an empty
 * PostgreSQL) or, when no database is left, what the encrypted objects describe themselves with. It needs no Redis and
 * no running Immich. An export can be stopped and run again: what was exported is kept.
 */
export const EXPORT_TOOL_USAGE = `Usage: immich-export --storage <file> --output <folder> [options]

Exports every original into <folder>/<user>/<year>/<date>/<file name>, each with a JSON file of what Immich knows
about it and an XMP sidecar that other photo applications read.

Options:
  --storage <file>     The storage backend configuration (IMMICH_STORAGE_BACKENDS); its master key file is used
  --database <url>     PostgreSQL with the Immich database, e.g. a database backup restored into an empty database.
                       Without it, originals are exported by what their encrypted objects describe: their file name
                       and owner, without dates and metadata
  --media <folder>     The media location (IMMICH_MEDIA_LOCATION), for originals stored there
  --user <email>       Only export the originals of this user; may be given more than once
  --include-trashed    Also export originals in the trash
  --output <folder>    Where to export to`;

/** What the export knows about an original, from the database */
export interface ExportedAsset {
  id: string;
  ownerId: string;
  ownerEmail: string;
  type: string;
  originalFileName: string;
  originalPath: string;
  fileCreatedAt: Date;
  localDateTime: Date;
  isFavorite: boolean;
  visibility: string;
  deletedAt: Date | null;
  livePhotoVideoId: string | null;
  duration: number | null;
  backendId: string | null;
  key: string | null;
  size: number | string | null;
  checksum: Buffer | null;
  encryption: Buffer | null;
  exif: {
    latitude: number | null;
    longitude: number | null;
    description: string | null;
    rating: number | null;
    dateTimeOriginal: Date | null;
    timeZone: string | null;
    make: string | null;
    model: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
  } | null;
  albums: string[];
  tags: string[];
  people: string[];
}

export interface ExportOptions {
  output: string;
  users?: string[];
  includeTrashed?: boolean;
}

export interface ExportSummary {
  exported: number;
  skipped: number;
  failed: number;
}

const escapeXml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** A coordinate as XMP writes it (DDD,MM.mmmmmmK) */
const toXmpCoordinate = (value: number, [positive, negative]: [string, string]) => {
  const absolute = Math.abs(value);
  const degrees = Math.floor(absolute);
  const minutes = (absolute - degrees) * 60;
  return `${degrees},${minutes.toFixed(6)}${value < 0 ? negative : positive}`;
};

/** The local date and time of an asset, as Immich keeps it: the wall clock time, stored as if it were UTC */
const toLocalDateTime = (date: Date) => date.toISOString().slice(0, 19);

/** An XMP sidecar with the dates, place, description, rating, tags and people of an asset */
export const toXmp = (asset: Pick<ExportedAsset, 'localDateTime' | 'exif' | 'tags' | 'people'>) => {
  const properties: string[] = [];
  const date = toLocalDateTime(asset.localDateTime);
  properties.push(
    `   <exif:DateTimeOriginal>${date}</exif:DateTimeOriginal>`,
    `   <photoshop:DateCreated>${date}</photoshop:DateCreated>`,
  );
  const { exif } = asset;
  if (exif?.latitude !== null && exif?.latitude !== undefined && exif.longitude !== null) {
    properties.push(
      `   <exif:GPSLatitude>${toXmpCoordinate(exif.latitude, ['N', 'S'])}</exif:GPSLatitude>`,
      `   <exif:GPSLongitude>${toXmpCoordinate(exif.longitude, ['E', 'W'])}</exif:GPSLongitude>`,
    );
  }
  if (exif?.rating !== null && exif?.rating !== undefined) {
    properties.push(`   <xmp:Rating>${exif.rating}</xmp:Rating>`);
  }
  if (exif?.description) {
    properties.push(
      '   <dc:description>',
      `    <rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(exif.description)}</rdf:li></rdf:Alt>`,
      '   </dc:description>',
    );
  }
  const bag = (element: string, values: string[]) => {
    if (values.length > 0) {
      properties.push(
        `   <${element}>`,
        `    <rdf:Bag>${values.map((value) => `<rdf:li>${escapeXml(value)}</rdf:li>`).join('')}</rdf:Bag>`,
        `   </${element}>`,
      );
    }
  };
  bag('dc:subject', asset.tags);
  bag('Iptc4xmpExt:PersonInImage', asset.people);

  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    '    xmlns:exif="http://ns.adobe.com/exif/1.0/"',
    '    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"',
    '    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">',
    ...properties,
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
    '',
  ].join('\n');
};

/** A name that is safe as a single path segment on common filesystems */
export const toSafeName = (name: string) => {
  // eslint-disable-next-line no-control-regex
  const safe = name.replaceAll(/[\u{0}-\u{1F}/\\:*?"<>|]/gu, '_').trim();
  return ['', '.', '..'].includes(safe) ? '_' : safe;
};

/** Where an asset goes: the user, the year and the day it was taken, and its file name */
export const toExportFolder = (output: string, owner: string, localDateTime: Date | null) => {
  if (!localDateTime) {
    return join(output, toSafeName(owner), 'undated');
  }
  const day = localDateTime.toISOString().slice(0, 10);
  return join(output, toSafeName(owner), day.slice(0, 4), day);
};

interface ExportTarget {
  path: string;
  /** Exported in an earlier run */
  done: boolean;
}

/**
 * The file an asset is exported to: its file name in its folder, or with a number if another asset has the name. The
 * JSON file next to it tells whose a name is, so that a run that is started again finds the same names.
 */
const findTarget = async (folder: string, fileName: string, id: string, size: number | null): Promise<ExportTarget> => {
  const extension = extname(fileName);
  const stem = basename(fileName, extension);
  for (let number = 1; ; number++) {
    const path = join(folder, number === 1 ? fileName : `${stem} (${number})${extension}`);
    const owner = await readFile(`${path}.json`, 'utf8')
      .then((content) => (JSON.parse(content) as { id?: string }).id)
      .catch(() => {});
    if (owner === undefined || owner === id) {
      const existing = await stat(path).catch(() => {});
      return { path, done: owner === id && !!existing && (size === null || existing.size === size) };
    }
  }
};

/** Write a file of an export: to a temporary file first, so that an interrupted export leaves no partial files */
const writeExported = async (path: string, write: (temporary: string) => Promise<void>) => {
  const temporary = join(dirname(path), `.${basename(path)}.part`);
  try {
    await write(temporary);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

export class Exporter {
  constructor(
    private backends: StorageBackendRepository,
    private output: ToolOutput,
  ) {}

  /** Export the originals of the database, by when they were taken */
  async exportFromDatabase(db: Kysely<DB>, options: ExportOptions): Promise<ExportSummary> {
    const summary: ExportSummary = { exported: 0, skipped: 0, failed: 0 };
    for await (const asset of this.streamAssets(db, options)) {
      await this.exportAsset(asset, options.output, summary);
    }
    return summary;
  }

  /**
   * Export the originals on the backend for originals by what their encrypted objects describe: file name and owner,
   * dated by when the object was written. Objects that are not encrypted describe nothing and keep their key as name.
   */
  async exportFromObjects({ output }: ExportOptions): Promise<ExportSummary> {
    const summary: ExportSummary = { exported: 0, skipped: 0, failed: 0 };
    const backendId = this.backends.getBackendFor(StorageBackendRole.Originals);
    if (!backendId) {
      throw new Error('No storage backend for originals is configured');
    }

    const encrypted = this.backends.getEncryptedStore(backendId);
    for await (const { key, size, lastModified } of this.backends.get(backendId).list()) {
      if (key.startsWith('.immich-')) {
        continue;
      }
      try {
        const description = await encrypted.describe(key).catch(() => {});
        const manifest = description?.manifest;
        const owner = typeof manifest?.ownerId === 'string' ? manifest.ownerId : 'unknown';
        const logicalName = typeof manifest?.path === 'string' ? basename(manifest.path) : basename(key);
        // a sidecar describes itself with the file name of its original
        const fileName =
          typeof manifest?.originalFileName === 'string'
            ? `${manifest.originalFileName}${extname(logicalName).toLowerCase() === '.xmp' ? '.xmp' : ''}`
            : logicalName;
        const folder = toExportFolder(output, owner, lastModified);
        await mkdir(folder, { recursive: true });
        const contentSize = description ? description.manifest.size : size;
        const target = await findTarget(folder, toSafeName(fileName), key, contentSize);
        if (target.done) {
          summary.skipped++;
          continue;
        }

        await writeFile(`${target.path}.json`, JSON.stringify({ id: key, backendId, ...manifest }, null, 2));
        await writeExported(target.path, async (temporary) => {
          const content = description
            ? await encrypted.get(key, {
                encryption: description.header,
                expect: { size: description.manifest.size, sha1: Buffer.from(description.manifest.sha1, 'hex') },
              })
            : await this.backends.get(backendId).get(key, { expect: { size } });
          await pipeline(content, createWriteStream(temporary));
        });
        summary.exported++;
      } catch (error) {
        summary.failed++;
        this.output.error(`Unable to export ${backendId}:${key}: ${error}`);
      }
    }
    return summary;
  }

  private async exportAsset(asset: ExportedAsset, output: string, summary: ExportSummary) {
    try {
      const size = asset.size === null ? null : Number(asset.size);
      const folder = toExportFolder(output, asset.ownerEmail, asset.localDateTime);
      await mkdir(folder, { recursive: true });
      const target = await findTarget(folder, toSafeName(asset.originalFileName), asset.id, size);
      if (target.done) {
        summary.skipped++;
        return;
      }

      const { exif, albums, tags, people } = asset;
      await writeFile(
        `${target.path}.json`,
        JSON.stringify(
          {
            id: asset.id,
            owner: asset.ownerEmail,
            type: asset.type,
            originalFileName: asset.originalFileName,
            localDateTime: toLocalDateTime(asset.localDateTime),
            fileCreatedAt: asset.fileCreatedAt.toISOString(),
            isFavorite: asset.isFavorite,
            visibility: asset.visibility,
            trashedAt: asset.deletedAt?.toISOString() ?? null,
            livePhotoVideoId: asset.livePhotoVideoId,
            duration: asset.duration,
            size,
            sha1: asset.checksum?.toString('hex') ?? null,
            exif,
            albums,
            tags,
            people,
          },
          null,
          2,
        ),
      );
      await writeFile(`${target.path}.xmp`, toXmp(asset));
      await writeExported(target.path, (temporary) => this.copyOriginal(asset, temporary));
      summary.exported++;
    } catch (error) {
      summary.failed++;
      this.output.error(`Unable to export ${asset.originalFileName} (${asset.id}): ${error}`);
    }
  }

  /** Copy an original as it was stored: decrypted, and checked against its recorded size and SHA-1 */
  private async copyOriginal(asset: ExportedAsset, target: string) {
    const file: RecordedFile = {
      path: asset.originalPath,
      backendId: asset.backendId,
      key: asset.key,
      size: asset.size,
      checksum: asset.checksum,
      encryption: asset.encryption,
    };
    const source = this.backends.resolve(file);
    const content =
      'path' in source
        ? createReadStream(source.path).pipe(
            createVerifyingStream(source.path, {
              length: file.size === null ? undefined : Number(file.size),
              sha1: asset.checksum ?? undefined,
            }),
          )
        : await readBlob(source.blob);
    await pipeline(content, createWriteStream(target));
  }

  private queryAssets(db: Kysely<DB>, { users, includeTrashed }: ExportOptions) {
    return (
      db
        .selectFrom('asset')
        .innerJoin('user', 'user.id', 'asset.ownerId')
        .leftJoin('asset_original_file', 'asset_original_file.assetId', 'asset.id')
        .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
        .select((eb) => [
          'asset.id',
          'asset.ownerId',
          'user.email as ownerEmail',
          'asset.type',
          'asset.originalFileName',
          'asset.originalPath',
          'asset.fileCreatedAt',
          'asset.localDateTime',
          'asset.isFavorite',
          'asset.visibility',
          'asset.deletedAt',
          'asset.livePhotoVideoId',
          'asset.duration',
          'asset_original_file.backendId',
          'asset_original_file.key',
          'asset_original_file.size',
          'asset_original_file.checksum',
          'asset_original_file.encryption',
          eb
            .case()
            .when('asset_exif.assetId', 'is', null)
            .then(null)
            .else(
              eb.fn('json_build_object', [
                sql.lit('latitude'),
                'asset_exif.latitude',
                sql.lit('longitude'),
                'asset_exif.longitude',
                sql.lit('description'),
                'asset_exif.description',
                sql.lit('rating'),
                'asset_exif.rating',
                sql.lit('dateTimeOriginal'),
                'asset_exif.dateTimeOriginal',
                sql.lit('timeZone'),
                'asset_exif.timeZone',
                sql.lit('make'),
                'asset_exif.make',
                sql.lit('model'),
                'asset_exif.model',
                sql.lit('city'),
                'asset_exif.city',
                sql.lit('state'),
                'asset_exif.state',
                sql.lit('country'),
                'asset_exif.country',
              ]),
            )
            .end()
            .$castTo<ExportedAsset['exif']>()
            .as('exif'),
          jsonArrayFrom(
            eb
              .selectFrom('album_asset')
              .innerJoin('album', 'album.id', 'album_asset.albumId')
              .select('album.albumName')
              .whereRef('album_asset.assetId', '=', 'asset.id')
              .orderBy('album.albumName'),
          ).as('albums'),
          jsonArrayFrom(
            eb
              .selectFrom('tag_asset')
              .innerJoin('tag', 'tag.id', 'tag_asset.tagId')
              .select('tag.value')
              .whereRef('tag_asset.assetId', '=', 'asset.id')
              .orderBy('tag.value'),
          ).as('tags'),
          jsonArrayFrom(
            eb
              .selectFrom('asset_face')
              .innerJoin('person', (join) =>
                join
                  .onRef('person.personGroupId', '=', 'asset_face.personGroupId')
                  .onRef('person.ownerId', '=', 'asset.ownerId'),
              )
              .select('person.name')
              .distinct()
              .whereRef('asset_face.assetId', '=', 'asset.id')
              .where('asset_face.deletedAt', 'is', null)
              .where('person.name', '!=', '')
              .orderBy('person.name'),
          ).as('people'),
        ])
        .$if(!includeTrashed, (qb) => qb.where('asset.deletedAt', 'is', null))
        .$if(!!users && users.length > 0, (qb) => qb.where('user.email', 'in', users!))
        // the earlier of two photos of the same name keeps the name
        .orderBy('asset.localDateTime')
        .orderBy('asset.id')
        .stream(500)
    );
  }

  private async *streamAssets(db: Kysely<DB>, options: ExportOptions): AsyncIterable<ExportedAsset> {
    for await (const row of this.queryAssets(db, options)) {
      yield {
        ...row,
        albums: row.albums.map(({ albumName }) => albumName),
        tags: row.tags.map(({ value }) => value),
        people: row.people.map(({ name }) => name),
      };
    }
  }
}

export const runExportTool = async (args: string[], output: ToolOutput): Promise<number> => {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        storage: { type: 'string' },
        database: { type: 'string' },
        media: { type: 'string' },
        user: { type: 'string', multiple: true },
        'include-trashed': { type: 'boolean' },
        output: { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch (error) {
    output.error(`${error instanceof Error ? error.message : error}\n\n${EXPORT_TOOL_USAGE}`);
    return 2;
  }
  if (values.help) {
    output.log(EXPORT_TOOL_USAGE);
    return 0;
  }
  if (!values.storage || !values.output || !isAbsolute(values.output)) {
    output.error(`--storage and an absolute --output are needed\n\n${EXPORT_TOOL_USAGE}`);
    return 2;
  }
  if (values.media) {
    StorageCore.setMediaLocation(values.media);
  }

  const backends = new StorageBackendRepository(undefined as never, LoggingRepository.create());
  const { backends: configs, encryption, deletion, databaseBackups } = await backends.readConfig(values.storage);
  backends.configure(configs, encryption ? backends.readMasterKeys(encryption) : undefined, deletion, databaseBackups);

  const exporter = new Exporter(backends, output);
  const options = { output: values.output, users: values.user, includeTrashed: values['include-trashed'] };
  let summary: ExportSummary;
  if (values.database) {
    const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: values.database }));
    try {
      summary = await exporter.exportFromDatabase(db, options);
    } finally {
      await db.destroy();
    }
  } else {
    summary = await exporter.exportFromObjects(options);
  }

  output.log(`Exported ${summary.exported}, already exported ${summary.skipped}, failed ${summary.failed}`);
  return summary.failed > 0 ? 1 : 0;
};
