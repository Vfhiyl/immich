// command.mjs VIDEO THREADS|preview: the arguments of ffmpeg the server runs for VIDEO with its default settings, one
// a line (the output file left out): transcoding with THREADS threads, or picking the frame of its preview
const root = new URL('../../server/', import.meta.url).pathname;
const { MediaRepository } = await import(`${root}dist/repositories/media.repository.js`);
const { BaseConfig, ThumbnailConfig } = await import(`${root}dist/utils/media.js`);
const { defaults } = await import(`${root}dist/dtos/config.dto.js`);

const quiet = { setContext() {}, verbose() {}, debug() {}, log() {}, warn() {}, error() {} };
const [input, run] = process.argv.slice(2);
const info = await new MediaRepository(quiet).probe(input);
const [video] = info.videoStreams;
const command =
  run === 'preview'
    ? ThumbnailConfig.create({ ...defaults.ffmpeg, targetResolution: '1440' }).getCommand('VIDEO', video, undefined, info.format)
    : BaseConfig.create({ ...defaults.ffmpeg, threads: Number(run) }, { dri: [], mali: false }).getCommand('ALL', video, info.audioStreams[0]);
for (const arg of [...command.inputOptions, '-i', input, ...command.outputOptions]) {
  console.log(arg);
}
