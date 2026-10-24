import { Injectable } from '@nestjs/common';

import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { AssetVisibility, JobName, JobStatus, QueueName } from 'src/enum.js';
import { ModelTask, OCR } from 'src/repositories/machine-learning.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { tokenizeForSearch } from 'src/utils/database.js';
import { batched, isOcrEnabled } from 'src/utils/misc.js';

const CORNERS = ['x1', 'y1', 'x2', 'y2', 'x3', 'y3', 'x4', 'y4'] as const;
type OcrLine = Record<(typeof CORNERS)[number], number> & { text: string };

/** How far (in parts of the width and height of the photo) a corner of a line may move and the line stay the same */
export const OCR_LINE_TOLERANCE = 0.01;

/**
 * What changed between the lines found before and those found now: a line with the same text whose corners all
 * moved by no more than `OCR_LINE_TOLERANCE` is the same line, and is kept as it was
 */
export const diffOcrLines = <T extends OcrLine, E extends OcrLine & { id: string }>(existing: E[], found: T[]) => {
  const unmatched = [...existing];
  const add: T[] = [];
  for (const line of found) {
    const index = unmatched.findIndex(
      (old) =>
        old.text === line.text && CORNERS.every((corner) => Math.abs(old[corner] - line[corner]) <= OCR_LINE_TOLERANCE),
    );
    if (index === -1) {
      add.push(line);
    } else {
      unmatched.splice(index, 1);
    }
  }
  return { add, removeIds: unmatched.map(({ id }) => id) };
};
import { getOcrThresholds } from 'src/utils/ml-thresholds.js';

@Injectable()
export class OcrService extends BaseService {
  @OnJob({ name: JobName.OcrQueueAll, queue: QueueName.Ocr })
  async handleQueueOcr({ force }: JobOf<JobName.OcrQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isOcrEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    if (force) {
      await this.ocrRepository.deleteAll();
    }

    for await (const assets of batched(this.assetJobRepository.streamForOcrJob(force))) {
      await this.jobRepository.queueAll(assets.map((asset) => ({ name: JobName.Ocr, data: { id: asset.id } })));
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.Ocr, queue: QueueName.Ocr })
  async handleOcr({ id }: JobOf<JobName.Ocr>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isOcrEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForOcr(id);
    if (!asset || !asset.previewFile) {
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    await using preview = await this.storageBackendRepository.lease(asset.previewFile);
    const ocrResults = await this.machineLearningRepository.ocr(preview.path, {
      modelName: machineLearning.ocr.modelName,
      ...getOcrThresholds(machineLearning),
    });
    const observed = await this.machineLearningModels.observe(ModelTask.OCR, ocrResults.model, machineLearning);
    if (!observed.keep) {
      return observed.conflict ? JobStatus.Failed : JobStatus.Skipped;
    }

    const { ocrDataList, searchText } = this.parseOcrResults(id, ocrResults);
    const existing = await this.ocrRepository.getByAssetId(id, {});
    const { add, removeIds } = diffOcrLines(existing, ocrDataList);
    await this.ocrRepository.update(id, removeIds, add, searchText);
    await this.machineLearningModelRepository.setResult(id, ModelTask.OCR, observed.modelId);

    await this.assetRepository.upsertJobStatus({ assetId: id, ocrAt: new Date() });

    this.logger.debug(`Processed ${ocrResults.text.length} OCR result(s) for ${id}`);
    return JobStatus.Success;
  }

  private parseOcrResults(id: string, { box, boxScore, text, textScore }: OCR) {
    const ocrDataList = [];
    const searchTokens = [];
    for (let i = 0; i < text.length; i++) {
      const rawText = text[i];
      const boxOffset = i * 8;
      ocrDataList.push({
        assetId: id,
        x1: box[boxOffset],
        y1: box[boxOffset + 1],
        x2: box[boxOffset + 2],
        y2: box[boxOffset + 3],
        x3: box[boxOffset + 4],
        y3: box[boxOffset + 5],
        x4: box[boxOffset + 6],
        y4: box[boxOffset + 7],
        boxScore: boxScore[i],
        textScore: textScore[i],
        text: rawText,
      });
      searchTokens.push(...tokenizeForSearch(rawText));
    }

    return { ocrDataList, searchText: searchTokens.join(' ') };
  }
}
