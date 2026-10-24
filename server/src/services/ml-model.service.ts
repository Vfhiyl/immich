import { BadRequestException, Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobItem, JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { MachineLearningModelDto, MachineLearningModelsResponseDto } from 'src/dtos/ml-model.dto.js';
import { DatabaseLock, ImmichWorker, JobName, JobStatus, QueueName, SystemMetadataKey } from 'src/enum.js';
import { ModelTask } from 'src/repositories/machine-learning.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { facesLeavingPerson } from 'src/utils/face-regroup.js';
import {
  batched,
  getCLIPModelInfo,
  isFacialRecognitionEnabled,
  isMachineLearningEnabled,
  isOcrEnabled,
  isSmartSearchEnabled,
} from 'src/utils/misc.js';
import {
  ModelRef,
  REBUILD_JOBS,
  REBUILD_PRIORITY,
  RECORDED_TASKS,
  TaskModelState,
  configuredModelName,
  isRebuilding,
} from 'src/utils/ml-models.js';

type MachineLearningConfig = SystemConfig['machineLearning'];

const TASKS = {
  [ModelTask.SEARCH]: { queue: QueueName.SmartSearch, job: JobName.SmartSearch, isEnabled: isSmartSearchEnabled },
  [ModelTask.FACIAL_RECOGNITION]: {
    queue: QueueName.FaceDetection,
    job: JobName.AssetDetectFaces,
    isEnabled: isFacialRecognitionEnabled,
  },
  [ModelTask.OCR]: { queue: QueueName.Ocr, job: JobName.Ocr, isEnabled: isOcrEnabled },
} as const;

/** People regrouped per step (the progress is kept after each) */
const REGROUP_BATCH = 100;
/** The named people whose changes are shown */
const REGROUP_PEOPLE_SHOWN = 20;
/** Up to this many faces, every pair of faces of a person is compared; above, each face with its nearest ones */
const REGROUP_EXACT_LIMIT = 3000;
const REGROUP_CHUNK = 500;
const REGROUP_NEIGHBOURS = 20;

/** How long the last step of a rebuild waits before it looks again whether the jobs it follows are done */
const FINISH_RETRY_MS = 60_000;

/**
 * Makes the results of every photo again when the model of a task changes (another name in the configuration, or
 * new files of the same model), in the background behind new photos: smart search switches to the new embeddings at
 * once when every photo has one, faces keep their place and person, text keeps the lines that did not change
 */
import { IGNORED_THRESHOLD_SETTINGS, getFaceThresholds, getOcrThresholds } from 'src/utils/ml-thresholds.js';

@Injectable()
export class MachineLearningModelService extends BaseService {
  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    this.warnIgnoredThresholds(newConfig.machineLearning);
    await this.followConfig(newConfig.machineLearning, true);
  }

  /** Only models with thresholds of their own can be used (as CLIP models must have a known dimension) */
  @OnEvent({ name: 'ConfigValidate' })
  onConfigValidate({ newConfig }: ArgOf<'ConfigValidate'>) {
    for (const check of [getFaceThresholds, getOcrThresholds]) {
      try {
        check(newConfig.machineLearning);
      } catch (error) {
        throw new Error(
          `${(error as Error).message}. Please check the model name for typos and confirm this is a supported model.`,
          { cause: error },
        );
      }
    }
  }

  private warnIgnoredThresholds(machineLearning: MachineLearningConfig) {
    const configured = IGNORED_THRESHOLD_SETTINGS(machineLearning);
    const fixed = IGNORED_THRESHOLD_SETTINGS(defaults.machineLearning);
    for (const [key, value] of Object.entries(configured)) {
      if (value !== fixed[key as keyof typeof fixed]) {
        this.logger.warn(`The setting ${key} (${value}) is ignored: thresholds are fixed per model`);
      }
    }
  }

  @OnEvent({ name: 'ConfigUpdate', workers: [ImmichWorker.Microservices], server: true })
  async onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    await this.followConfig(newConfig.machineLearning, false);
  }

  /** Follows the models of the configuration; as the server starts, takes up a rebuild whose jobs were lost */
  private async followConfig(machineLearning: MachineLearningConfig, starting: boolean) {
    for (const task of RECORDED_TASKS) {
      if (!TASKS[task].isEnabled(machineLearning)) {
        continue;
      }
      const state = await this.machineLearningModels.followConfig(task, machineLearning);
      if (!(starting && isRebuilding(state)) || (await this.hasPendingJobs(task))) {
        continue;
      }

      this.logger.log(`Resuming the rebuild of ${task} results for model ${state.target.name}`);
      await this.jobRepository.queue({ name: REBUILD_JOBS[task], data: { generation: state.generation } });
    }
  }

  @OnJob({ name: JobName.SmartSearchRebuild, queue: QueueName.SmartSearch })
  handleSmartSearchRebuild(job: JobOf<JobName.SmartSearchRebuild>): Promise<JobStatus> {
    return this.handleRebuild(ModelTask.SEARCH, job);
  }

  @OnJob({ name: JobName.FaceDetectionRebuild, queue: QueueName.FaceDetection })
  handleFaceDetectionRebuild(job: JobOf<JobName.FaceDetectionRebuild>): Promise<JobStatus> {
    return this.handleRebuild(ModelTask.FACIAL_RECOGNITION, job);
  }

  @OnJob({ name: JobName.OcrRebuild, queue: QueueName.Ocr })
  handleOcrRebuild(job: JobOf<JobName.OcrRebuild>): Promise<JobStatus> {
    return this.handleRebuild(ModelTask.OCR, job);
  }

  private async handleRebuild(task: ModelTask, { generation, finish }: JobOf<JobName.SmartSearchRebuild>) {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!TASKS[task].isEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }
    const state = await this.machineLearningModels.getState(task, machineLearning);
    if (state.generation !== generation || !isRebuilding(state)) {
      // the model changed again since this was queued: the rebuild of that change is queued on its own
      return JobStatus.Skipped;
    }
    return finish ? this.finishRebuild(task, state, machineLearning) : this.queueRebuild(task, state);
  }

  /**
   * Queues a job for every photo whose results are not of the target, the newest first: those without results
   * first, then those with results of another model, both behind new photos (whose jobs have no priority); then the
   * last step, behind them all
   */
  private async queueRebuild(task: ModelTask, state: TaskModelState) {
    const selection = await this.machineLearningModels.getSelection(task, state);
    for (const phase of ['missing', 'stale'] as const) {
      for await (const assets of batched(
        this.machineLearningModelRepository.streamForRebuild(task, phase, selection),
      )) {
        await this.jobRepository.queueAll(
          assets.map(
            ({ id }) => ({ name: TASKS[task].job, data: { id, priority: REBUILD_PRIORITY[phase] } }) as JobItem,
          ),
        );
      }
    }
    await this.queueFinish(task, state.generation);
    return JobStatus.Success;
  }

  private queueFinish(task: ModelTask, generation: number, delay?: number) {
    return this.jobRepository.queue({
      name: REBUILD_JOBS[task],
      data: { generation, finish: true, priority: REBUILD_PRIORITY.finish, delay },
    });
  }

  private async finishRebuild(task: ModelTask, state: TaskModelState, machineLearning: MachineLearningConfig) {
    if (await this.hasPendingJobs(task, 1)) {
      await this.queueFinish(task, state.generation, FINISH_RETRY_MS);
      return JobStatus.Success;
    }

    switch (task) {
      case ModelTask.SEARCH: {
        await this.switchSmartSearch(state, machineLearning);
        await this.jobRepository.queueAll([
          // the photos whose embedding could not be made for the new model have none now
          { name: JobName.SmartSearchQueueAll, data: { force: false } },
          { name: JobName.AssetDetectDuplicatesQueueAll, data: { force: true } },
        ]);
        break;
      }
      case ModelTask.FACIAL_RECOGNITION: {
        // the people, grouped by embeddings of the earlier model, are regrouped by those of this one; once (taken up
        // where it was after a restart)
        if (state.regroup?.generation !== state.generation) {
          await this.machineLearningModelRepository.snapshotFaceAssignments();
          await this.machineLearningModels.startRegroup(task, machineLearning, state.generation);
        }
        await this.jobRepository.queue({ name: JobName.FaceRegroup, data: { generation: state.generation } });
        return JobStatus.Success;
      }
      case ModelTask.OCR: {
        await this.machineLearningModels.finishRebuild(task, machineLearning, state.generation);
        break;
      }
    }
    this.logger.log(`The ${task} results were made again for model ${state.target.name}`);
    return JobStatus.Success;
  }

  /**
   * Regroups the people after their faces got embeddings of another model: faces that are no longer close to the rest
   * of their person leave it (see `facesLeavingPerson`), then recognition looks for the person of every face without one
   */
  @OnJob({ name: JobName.FaceRegroup, queue: QueueName.FacialRecognition })
  async handleFaceRegroup({ generation }: JobOf<JobName.FaceRegroup>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    const task = ModelTask.FACIAL_RECOGNITION;
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }
    const state = await this.machineLearningModels.getState(task, machineLearning);
    if (state.generation !== generation || state.regroup?.generation !== generation || state.regroup.finishedAt) {
      return JobStatus.Skipped;
    }

    const { maxDistance } = getFaceThresholds(machineLearning);
    let cursor = state.regroup.cursor ?? null;
    let left = 0;
    for (;;) {
      const people = await this.machineLearningModelRepository.getPeopleToRegroup(cursor, REGROUP_BATCH);
      if (people.length === 0) {
        break;
      }
      for (const { id } of people) {
        left += await this.regroupPerson(id, maxDistance);
      }
      cursor = people.at(-1)!.id;
      await this.machineLearningModels.saveRegroupCursor(task, machineLearning, generation, cursor);
      const current = await this.machineLearningModels.getState(task, machineLearning);
      if (current.generation !== generation) {
        // the model changed again: its rebuild regroups
        return JobStatus.Skipped;
      }
    }

    const { done } = await this.machineLearningModels.finishRegroup(task, machineLearning, generation);
    if (done) {
      this.logger.log(`Regrouped the people for face model ${state.target.name}: ${left} faces left their person`);
      // the faces without a person (those found by this model, and those that left) are recognized now
      await this.jobRepository.queue({ name: JobName.FacialRecognitionQueueAll, data: { force: false } });
    }
    return JobStatus.Success;
  }

  /** Returns how many faces left the person */
  private async regroupPerson(personGroupId: string, maxDistance: number) {
    const repository = this.machineLearningModelRepository;
    const rows = await repository.getFacesToRegroup(personGroupId);
    const faces = rows.map(({ id, isFixed, isCover }) => ({ id, isFixed: !!isFixed, isCover: !!isCover }));
    if (faces.length < 2) {
      return 0;
    }
    let pairs: Array<{ a: string; b: string }>;
    if (faces.length <= REGROUP_EXACT_LIMIT) {
      pairs = await repository.getCloseFacePairs(personGroupId, maxDistance);
    } else {
      pairs = [];
      const ids = faces.map(({ id }) => id);
      for (let start = 0; start < ids.length; start += REGROUP_CHUNK) {
        const chunk = ids.slice(start, start + REGROUP_CHUNK);
        pairs.push(...(await repository.getNearFacePairs(personGroupId, chunk, maxDistance, REGROUP_NEIGHBOURS)));
      }
    }

    const leaving = facesLeavingPerson(faces, pairs);
    if (leaving.length === 0) {
      return 0;
    }
    await repository.takeFromPerson(personGroupId, leaving);

    // a person whose picture left gets another one
    const jobs: JobItem[] = [];
    for (const person of await repository.getPeopleWithPicture(leaving)) {
      const face = await this.personRepository.getRandomFace(person.personGroupId);
      await this.personRepository.update({ ...person, faceAssetId: face?.id ?? null });
      if (face) {
        jobs.push({ name: JobName.PersonGenerateThumbnail, data: person });
      }
    }
    await this.jobRepository.queueAll(jobs);
    return leaving.length;
  }

  /** Puts the faces back where they were before the last regroup */
  async undoFaceRegroup(): Promise<void> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    const { undone } = await this.machineLearningModels.markRegroupUndone(
      ModelTask.FACIAL_RECOGNITION,
      machineLearning,
    );
    if (!undone) {
      throw new BadRequestException('There is no regroup of people to undo');
    }
    const restored = await this.machineLearningModelRepository.undoRegroup();
    this.logger.log(`Undid the regroup of people: ${restored} faces are back with the person they had`);
  }

  private async switchSmartSearch(state: TaskModelState, machineLearning: MachineLearningConfig) {
    const { modelIds } = await this.machineLearningModels.getSelection(ModelTask.SEARCH, state);
    const { dimSize } = getCLIPModelInfo(state.target.name);
    // the jobs of smart search wait for this lock, and look at the state again once it is released
    await this.databaseRepository.withLock(DatabaseLock.CLIPDimSize, async () => {
      await this.machineLearningModelRepository.switchSmartSearch({
        modelIds,
        dimSize,
        currentDimSize: await this.databaseRepository.getDimensionSize('smart_search'),
        vectorExtension: await this.databaseRepository.getVectorExtension(),
      });
      await this.machineLearningModels.finishRebuild(ModelTask.SEARCH, machineLearning, state.generation, {
        ...state.target,
      });
    });
  }

  /** Whether the queue of a task has jobs waiting, delayed or running, besides `running` of its own */
  private async hasPendingJobs(task: ModelTask, running = 0) {
    const counts = await this.jobRepository.getJobCounts(TASKS[task].queue);
    return counts.waiting + counts.delayed + counts.paused + counts.active > running;
  }

  async getModels(): Promise<MachineLearningModelsResponseDto> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    const tasks = await Promise.all(
      RECORDED_TASKS.map(async (task) => {
        const state = await this.machineLearningModels.getState(task, machineLearning);
        const progress = isRebuilding(state)
          ? await this.machineLearningModelRepository.getProgress(
              task,
              await this.machineLearningModels.getSelection(task, state),
            )
          : null;
        const replaced = state.replaced && {
          from: await this.describe({ name: state.target.name, modelId: state.replaced.fromModelId }),
          to: await this.describe({ name: state.target.name, modelId: state.replaced.toModelId }),
          at: state.replaced.at,
        };
        const conflict = state.conflict && {
          model: await this.describe({ name: state.target.name, modelId: state.conflict.modelId }),
          at: state.conflict.at,
        };
        return {
          task,
          regroup: state.regroup ? await this.describeRegroup(state.regroup) : null,
          enabled: TASKS[task].isEnabled(machineLearning),
          configuredModel: configuredModelName(task, machineLearning),
          target: await this.describe(state.target),
          active: state.active ? await this.describe(state.active) : null,
          rebuild: state.rebuild
            ? {
                startedAt: state.rebuild.startedAt,
                finishedAt: state.rebuild.finishedAt ?? null,
                total: progress?.total ?? null,
                done: progress?.done ?? null,
              }
            : null,
          replaced: replaced || null,
          conflict: conflict || null,
        };
      }),
    );
    const backoff = isMachineLearningEnabled(machineLearning)
      ? await this.systemMetadataRepository.get(SystemMetadataKey.MachineLearningBackoff)
      : null;
    return { tasks, backoff: backoff ?? null };
  }

  private async describeRegroup(regroup: NonNullable<TaskModelState['regroup']>) {
    // what changed is told until it is undone
    const changes =
      regroup.finishedAt && !regroup.undoneAt ? await this.machineLearningModelRepository.getRegroupChanges() : [];
    const named = changes.filter(({ names }) => names);
    return {
      startedAt: regroup.startedAt,
      finishedAt: regroup.finishedAt ?? null,
      undoneAt: regroup.undoneAt ?? null,
      facesLeft: changes.reduce((sum, { left }) => sum + left, 0),
      facesJoined: changes.reduce((sum, { joined }) => sum + joined, 0),
      people: named.slice(0, REGROUP_PEOPLE_SHOWN),
      otherPeople: changes.length - named.length,
    };
  }

  private async describe({ name, modelId }: ModelRef): Promise<MachineLearningModelDto> {
    const model = modelId ? await this.machineLearningModelRepository.get(modelId) : undefined;
    return {
      name: model?.name ?? name,
      fingerprint: model?.fingerprint ?? null,
      format: model?.format ?? null,
      firstSeenAt: model ? new Date(model.createdAt).toISOString() : null,
      lastSeenAt: model ? new Date(model.lastSeenAt).toISOString() : null,
    };
  }
}
