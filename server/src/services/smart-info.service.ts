import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { SystemConfig } from 'src/dtos/config.dto.js';

import { AssetVisibility, DatabaseLock, ImmichWorker, JobName, JobStatus, QueueName } from 'src/enum.js';
import { ModelTask } from 'src/repositories/machine-learning.repository.js';
import { RecordedFile } from 'src/repositories/storage-backend.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { batched, getCLIPModelInfo, isSmartSearchEnabled } from 'src/utils/misc.js';
import { isRebuilding } from 'src/utils/ml-models.js';

@Injectable()
export class SmartInfoService extends BaseService {
  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    await this.init(newConfig);
  }

  @OnEvent({ name: 'ConfigUpdate', workers: [ImmichWorker.Microservices], server: true })
  async onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    await this.init(newConfig);
  }

  @OnEvent({ name: 'ConfigValidate' })
  onConfigValidate({ newConfig }: ArgOf<'ConfigValidate'>) {
    try {
      getCLIPModelInfo(newConfig.machineLearning.clip.modelName);
    } catch {
      throw new Error(
        `Unknown CLIP model: ${newConfig.machineLearning.clip.modelName}. Please check the model name for typos and confirm this is a supported model.`,
      );
    }
  }

  /**
   * Keeps the column of the embeddings that are searched at the dimension of their model. Upstream deleted every
   * embedding when the model changed; here a rebuild makes the new ones in the background and switches to them at
   * once (see `MachineLearningModelService`), so only a column that does not fit its model is changed (and emptied).
   */
  private async init(newConfig: SystemConfig) {
    if (!isSmartSearchEnabled(newConfig.machineLearning)) {
      return;
    }

    await this.databaseRepository.withLock(DatabaseLock.CLIPDimSize, async () => {
      const { active } = await this.machineLearningModels.getState(ModelTask.SEARCH, newConfig.machineLearning);
      const modelName = active?.name ?? newConfig.machineLearning.clip.modelName;
      const { dimSize } = getCLIPModelInfo(modelName);
      const dbDimSize = await this.databaseRepository.getDimensionSize('smart_search');
      this.logger.verbose(`Current database CLIP dimension size is ${dbDimSize}`);
      if (dbDimSize === dimSize) {
        return;
      }

      this.logger.log(`Dimension size of model ${modelName} is ${dimSize}, but database expects ${dbDimSize}.`);
      this.logger.log(`Updating database CLIP dimension size to ${dimSize}.`);
      await this.databaseRepository.setDimensionSize(dimSize);
      this.logger.log(`Successfully updated database CLIP dimension size from ${dbDimSize} to ${dimSize}.`);
    });
  }

  @OnJob({ name: JobName.SmartSearchQueueAll, queue: QueueName.SmartSearch })
  async handleQueueEncodeClip({ force }: JobOf<JobName.SmartSearchQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    if (force) {
      const { dimSize } = getCLIPModelInfo(machineLearning.clip.modelName);
      // in addition to deleting embeddings, update the dimension size in case it failed earlier
      await this.databaseRepository.setDimensionSize(dimSize);
      // made again at once with the model they are made with: what a rebuild would have switched to
      await this.machineLearningModels.setActive(ModelTask.SEARCH, machineLearning);
    }

    for await (const assets of batched(this.assetJobRepository.streamForEncodeClip(force))) {
      await this.jobRepository.queueAll(assets.map((asset) => ({ name: JobName.SmartSearch, data: { id: asset.id } })));
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.SmartSearch, queue: QueueName.SmartSearch })
  async handleEncodeClip({ id }: JobOf<JobName.SmartSearch>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isSmartSearchEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForClipEncoding(id);
    if (!asset || asset.files.length !== 1) {
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    const { embedding, model } = await this.encodePreview(asset.files[0], machineLearning.clip);
    const observed = await this.machineLearningModels.observe(ModelTask.SEARCH, model, machineLearning);
    if (!observed.keep) {
      return observed.conflict ? JobStatus.Failed : JobStatus.Skipped;
    }

    if (this.databaseRepository.isBusy(DatabaseLock.CLIPDimSize)) {
      this.logger.verbose(`Waiting for CLIP dimension size to be updated`);
      await this.databaseRepository.wait(DatabaseLock.CLIPDimSize);
    }

    const newConfig = await this.getConfig({ withCache: true });
    if (machineLearning.clip.modelName !== newConfig.machineLearning.clip.modelName) {
      // Skip the job if the model has changed since the embedding was generated.
      return JobStatus.Skipped;
    }

    // as it is now: a switch may have happened while this waited
    const state = await this.machineLearningModels.getState(ModelTask.SEARCH, machineLearning);
    const { modelId } = observed;
    if (!isRebuilding(state) || !state.active) {
      await this.searchRepository.upsert(asset.id, embedding);
      return JobStatus.Success;
    }

    // what is searched holds the embeddings of another model until every photo has one of this model
    await this.machineLearningModelRepository.upsertRebuildEmbedding(asset.id, modelId, embedding);
    if (!(await this.searchRepository.getEmbedding(asset.id))) {
      // a new photo is found by searches before the switch too
      const searched = await this.encodePreview(asset.files[0], {
        ...machineLearning.clip,
        modelName: state.active.name,
      });
      const searchedModel = await this.machineLearningModelRepository.create({
        task: ModelTask.SEARCH,
        ...searched.model,
      });
      if (
        await this.machineLearningModels.isCompatible(
          { name: searched.model.name, modelId: searchedModel.id },
          state.active,
        )
      ) {
        await this.searchRepository.upsert(asset.id, searched.embedding);
      }
    }

    return JobStatus.Success;
  }

  /** Holds the preview only while it is encoded, not while waiting for the database */
  private async encodePreview(file: RecordedFile, config: SystemConfig['machineLearning']['clip']) {
    await using preview = await this.storageBackendRepository.lease(file);
    return this.machineLearningRepository.encodeImage(preview.path, config);
  }
}
