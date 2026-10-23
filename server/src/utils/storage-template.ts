import handlebar from 'handlebars';
import { DateTime } from 'luxon';
import { basename, extname, normalize } from 'node:path';
import sanitize from 'sanitize-filename';
import type { StorageAsset } from 'src/types.js';
import { AssetType } from 'src/enum.js';

/** The date tokens of a storage template */
export const storageTokens = {
  secondOptions: ['s', 'ss', 'SSS'],
  minuteOptions: ['m', 'mm'],
  dayOptions: ['d', 'dd'],
  weekOptions: ['W', 'WW'],
  hourOptions: ['h', 'hh', 'H', 'HH'],
  yearOptions: ['y', 'yy'],
  monthOptions: ['M', 'MM', 'MMM', 'MMMM'],
};

/** What a storage template is rendered with */
export interface StorageTemplateMetadata {
  asset: Pick<StorageAsset, 'id' | 'type' | 'fileCreatedAt'>;
  filename: string;
  extension: string;
  albumName: string | null;
  albumStartDate: Date | null;
  albumEndDate: Date | null;
  make: string | null;
  model: string | null;
  lensModel: string | null;
}

/**
 * A storage template, ready to render: it names the files of the storage template migration, and, on storage backends
 * (where objects have opaque keys), the files of exports
 */
export const compileStorageTemplate = (template: string) => ({
  raw: template,
  compiled: handlebar.compile(template, { knownHelpers: undefined, strict: true }),
  needsAlbum: template.includes('album'),
  needsAlbumMetadata: template.includes('album-startDate') || template.includes('album-endDate'),
});

/** The path a storage template gives a file, without its extension */
export const renderStorageTemplate = (template: HandlebarsTemplateDelegate<any>, options: StorageTemplateMetadata) => {
  const { filename, extension, asset, albumName, albumStartDate, albumEndDate, make, model, lensModel } = options;
  const substitutions: Record<string, string> = {
    filename,
    ext: extension,
    filetype: asset.type === AssetType.Image ? 'IMG' : 'VID',
    filetypefull: asset.type === AssetType.Image ? 'IMAGE' : 'VIDEO',
    assetId: asset.id,
    assetIdShort: asset.id.slice(-12),
    //just throw into the root if it doesn't belong to an album
    album: (albumName && sanitize(albumName.replaceAll(/\.+/g, ''))) || '',
    make: make ?? '',
    model: model ?? '',
    lensModel: lensModel ?? '',
  };

  const dt = DateTime.fromJSDate(asset.fileCreatedAt);

  for (const token of Object.values(storageTokens).flat()) {
    substitutions[token] = dt.toFormat(token);
    if (!albumName) {
      continue;
    }

    // Album date tokens are rendered in the server time zone to match storage template datetime behavior.
    substitutions['album-startDate-' + token] = albumStartDate
      ? DateTime.fromJSDate(albumStartDate).toFormat(token)
      : '';
    substitutions['album-endDate-' + token] = albumEndDate ? DateTime.fromJSDate(albumEndDate).toFormat(token) : '';
  }

  return template(substitutions).replaceAll(/\/{2,}/gm, '/');
};

/** What names a file by a storage template */
export interface TemplateFile {
  id: string;
  type: string;
  fileCreatedAt: Date;
  originalFileName: string;
  albumName: string | null;
  make: string | null;
  model: string | null;
  lensModel: string | null;
}

/**
 * The relative path a storage template gives a file, with its extension; null when it would leave the folder it is
 * relative to, or name no file. Album dates are not known here and render empty.
 */
export const toTemplatePath = (template: ReturnType<typeof compileStorageTemplate>, file: TemplateFile) => {
  const extension = extname(file.originalFileName);
  const stem = basename(file.originalFileName, extension);
  const rendered = renderStorageTemplate(template.compiled, {
    asset: { id: file.id, type: file.type as AssetType, fileCreatedAt: file.fileCreatedAt },
    filename: sanitize(stem) || file.id,
    extension: extension.slice(1).toLowerCase(),
    albumName: file.albumName,
    albumStartDate: null,
    albumEndDate: null,
    make: file.make,
    model: file.model,
    lensModel: file.lensModel,
  });
  const path = normalize(`${rendered}${extension.toLowerCase()}`).replace(/^\/+/, '');
  if (path.startsWith('..') || path.endsWith('/') || !basename(path) || basename(path).startsWith('.')) {
    return null;
  }
  return path;
};
