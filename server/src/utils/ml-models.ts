import type { DatabaseRepository } from 'src/repositories/database.repository.js';
import type { JobRepository } from 'src/repositories/job.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { MachineLearningModelRepository, RebuildSelection } from 'src/repositories/ml-model.repository.js';
import type { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { DatabaseLock, JobName, SystemMetadataKey } from 'src/enum.js';
import { ModelTask } from 'src/repositories/machine-learning.repository.js';

/** The model that made a result, as the machine learning service reports it */
export interface ReportedModel {
  name: string;
  /** null from a service that does not report one (upstream's) */
  fingerprint: string | null;
  format: string | null;
}

export interface KnownModel {
  id: string;
  name: string;
  fingerprint: string | null;
  lastSeenAt: Date;
  retiredAt: Date | null;
}

export interface ModelRef {
  name: string;
  /** The model whose files are known, once the first result of the name came back */
  modelId: string | null;
}

export interface TaskModelState {
  /** The model of the results that were made before models were recorded */
  legacyName: string;
  /** What the task makes its results with now: the configured model, with the files of its first result */
  target: ModelRef;
  /** Smart search only: the model of the embeddings that are searched, until a rebuild moves them to the target */
  active?: ModelRef;
  /** Counts up with every change of the target; jobs of an earlier rebuild find out they are stale with it */
  generation: number;
  rebuild?: { startedAt: string; finishedAt?: string };
  /** The last time the files of the model were replaced */
  replaced?: { fromModelId: string; toModelId: string; at: string };
  /** Files that were replaced came back while the current ones are still seen: results with them are not kept */
  conflict?: { modelId: string; at: string };
}

export type MachineLearningModelsState = Partial<Record<ModelTask, TaskModelState>>;

/** The tasks whose models are recorded */
export const RECORDED_TASKS = [ModelTask.SEARCH, ModelTask.FACIAL_RECOGNITION, ModelTask.OCR] as const;

/** How long the files a target replaced must go unseen before files that were replaced become the target again */
export const RETURN_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Whether results of `a` and `b` go together: the same model, and the same files where both are known; results made
 * before models were recorded, and those of a service that does not report its files, count as made by the files
 * of the same name (nothing else is known about them, and assuming otherwise would make every result again on the
 * upgrade to this version)
 */
export const isCompatible = (
  a: { name: string; fingerprint: string | null },
  b: { name: string; fingerprint: string | null },
) => a.name === b.name && (a.fingerprint === null || b.fingerprint === null || a.fingerprint === b.fingerprint);

export type ModelDecision =
  /** The result is of the target */
  | { kind: 'target' }
  /** The result is of the target, whose files are now known (or known with a fingerprint): nothing to make again */
  | { kind: 'learn' }
  /** New files of the target model: they are the target now, and results of the others are made again */
  | { kind: 'replace' }
  /** Files that were replaced came back after the current ones went unseen for a day: they are the target again */
  | { kind: 'return' }
  /** Files that were replaced came back while the current ones are still seen: the result is not kept */
  | { kind: 'conflict' }
  /** A result of another model than the target (the configuration changed while it was made): not kept */
  | { kind: 'other' };

/** What a result of `model` means for a task that makes its results with `target` */
export const decideModel = ({
  target,
  targetModel,
  model,
  now,
}: {
  target: ModelRef;
  /** The record of `target.modelId` */
  targetModel: KnownModel | null;
  model: KnownModel;
  now: Date;
}): ModelDecision => {
  if (model.name !== target.name) {
    return { kind: 'other' };
  }
  if (!targetModel) {
    return { kind: 'learn' };
  }
  if (model.id === targetModel.id) {
    return { kind: 'target' };
  }
  if (isCompatible(model, targetModel)) {
    // the files of a target without a fingerprint, now with one; or a result without one, which says nothing new
    return targetModel.fingerprint === null ? { kind: 'learn' } : { kind: 'target' };
  }
  if (!model.retiredAt) {
    return { kind: 'replace' };
  }
  return now.getTime() - targetModel.lastSeenAt.getTime() > RETURN_AFTER_MS ? { kind: 'return' } : { kind: 'conflict' };
};

type MachineLearningConfig = SystemConfig['machineLearning'];

export const configuredModelName = (task: ModelTask, config: MachineLearningConfig) => {
  switch (task) {
    case ModelTask.SEARCH: {
      return config.clip.modelName;
    }
    case ModelTask.FACIAL_RECOGNITION: {
      return config.facialRecognition.modelName;
    }
    case ModelTask.OCR: {
      return config.ocr.modelName;
    }
  }
};

export const REBUILD_JOBS = {
  [ModelTask.SEARCH]: JobName.SmartSearchRebuild,
  [ModelTask.FACIAL_RECOGNITION]: JobName.FaceDetectionRebuild,
  [ModelTask.OCR]: JobName.OcrRebuild,
} as const;

/** Of a rebuild: the photos without results, then those with results of another model, then its last step */
export const REBUILD_PRIORITY = { missing: 10, stale: 20, finish: 30 } as const;

/** How often the time a model was last seen is written (it decides only after a day, see `RETURN_AFTER_MS`) */
const SEEN_EVERY_MS = 10 * 60 * 1000;
const lastWritten = new Map<string, number>();

export const isRebuilding = (state: TaskModelState) => !!state.rebuild && !state.rebuild.finishedAt;

/** The state of a task that has none yet: the results so far count as made by the configured model */
const initialState = (task: ModelTask, name: string): TaskModelState => ({
  legacyName: name,
  target: { name, modelId: null },
  ...(task === ModelTask.SEARCH && { active: { name, modelId: null } }),
  generation: 0,
});

export interface ObservedModel {
  modelId: string;
  /** Whether the result is of the model the task makes its results with, and is to be kept */
  keep: boolean;
  /** Why a result is not kept: files that were replaced, rather than another model (the configuration changed) */
  conflict: boolean;
  state: TaskModelState;
}

/**
 * The models of the tasks of machine learning: which one each task makes its results with (the target), which
 * results are of it, and when the results of every photo are made again (a rebuild)
 */
export class MachineLearningModels {
  constructor(
    private repositories: {
      databaseRepository: DatabaseRepository;
      jobRepository: JobRepository;
      logger: LoggingRepository;
      machineLearningModelRepository: MachineLearningModelRepository;
      systemMetadataRepository: SystemMetadataRepository;
    },
  ) {}

  private get models() {
    return this.repositories.machineLearningModelRepository;
  }

  async getState(task: ModelTask, config: MachineLearningConfig): Promise<TaskModelState> {
    const state = await this.repositories.systemMetadataRepository.get(SystemMetadataKey.MachineLearningModels);
    return state?.[task] ?? initialState(task, configuredModelName(task, config));
  }

  /**
   * Which results count as of `ref`: those of the models whose files are its own (or unknown), and those made
   * before models were recorded when they were of the same name
   */
  async getSelection(task: ModelTask, state: TaskModelState, ref: ModelRef = state.target): Promise<RebuildSelection> {
    const fingerprint = await this.getFingerprint(ref);
    const all = await this.models.getAll(task);
    return {
      modelIds: all.filter((model) => isCompatible(model, { name: ref.name, fingerprint })).map(({ id }) => id),
      legacy: state.legacyName === ref.name,
    };
  }

  async isCompatible(a: ModelRef, b: ModelRef) {
    return isCompatible(
      { name: a.name, fingerprint: await this.getFingerprint(a) },
      { name: b.name, fingerprint: await this.getFingerprint(b) },
    );
  }

  private async getFingerprint(ref: ModelRef) {
    const model = ref.modelId ? await this.models.get(ref.modelId) : undefined;
    return model?.fingerprint ?? null;
  }

  /**
   * Records the model a result came from, and tells whether to keep the result: the result of new files of the
   * target model starts a rebuild with them, and one of files that were replaced is not kept
   */
  async observe(task: ModelTask, reported: ReportedModel, config: MachineLearningConfig): Promise<ObservedModel> {
    const model =
      (await this.models.find(task, reported.name, reported.fingerprint)) ??
      (await this.models.create({ task, ...reported }));
    await this.markSeen(model, reported.format);

    const state = await this.getState(task, config);
    const decision = await this.decide(state, model);
    if (decision.kind === 'target' || decision.kind === 'other') {
      return { modelId: model.id, keep: decision.kind === 'target', conflict: false, state };
    }

    // what changes the state, decided again with the state as it is under the lock
    return this.update(task, config, async (state) => {
      const decision = await this.decide(state, model);
      const now = new Date();
      switch (decision.kind) {
        case 'learn': {
          if (state.active && !isRebuilding(state) && (await this.isCompatible(state.active, state.target))) {
            state.active = { name: model.name, modelId: model.id };
          }
          state.target = { name: model.name, modelId: model.id };
          return { keep: true, conflict: false };
        }
        case 'replace':
        case 'return': {
          const previous = state.target.modelId;
          if (previous) {
            await this.models.update(previous, { retiredAt: now });
          }
          await this.models.update(model.id, { retiredAt: null });
          this.repositories.logger.warn(
            `The files of ${task} model ${model.name} changed (now ${model.fingerprint}): the results of every ` +
              'photo are made again with them in the background',
          );
          state.replaced = previous ? { fromModelId: previous, toModelId: model.id, at: now.toISOString() } : undefined;
          state.conflict = undefined;
          await this.startRebuild(task, state, { name: model.name, modelId: model.id });
          return { keep: true, conflict: false };
        }
        case 'conflict': {
          if (state.conflict?.modelId !== model.id) {
            this.repositories.logger.warn(
              `A machine learning server answered with files of ${task} model ${model.name} (${model.fingerprint}) ` +
                'that were replaced: the result is not kept. Make every machine learning server use the same files.',
            );
          }
          state.conflict = { modelId: model.id, at: now.toISOString() };
          return { keep: false, conflict: true };
        }
        default: {
          return { keep: decision.kind === 'target', conflict: false };
        }
      }
    }).then(({ keep, conflict = false, state }) => ({ modelId: model.id, keep, conflict, state }));
  }

  /** Follows the configuration: a model of another name becomes the target, and the results are made again */
  async followConfig(task: ModelTask, config: MachineLearningConfig): Promise<TaskModelState> {
    const name = configuredModelName(task, config);
    const state = await this.getState(task, config);
    if (state.target.name === name && state.generation > 0) {
      return state;
    }
    const { state: updated } = await this.update(task, config, async (state) => {
      if (state.target.name !== name) {
        this.repositories.logger.log(
          `The ${task} model changed to ${name}: the results are made again in the background`,
        );
        await this.startRebuild(task, state, { name, modelId: null });
      } else if (state.generation === 0) {
        state.generation = 1; // recorded, so that the state is kept from now on
      }
      return {};
    });
    return updated;
  }

  /** Ends a rebuild, for the generation it was started as */
  async finishRebuild(task: ModelTask, config: MachineLearningConfig, generation: number, active?: ModelRef) {
    return this.update(task, config, (state) => {
      if (state.generation !== generation || !state.rebuild) {
        return Promise.resolve({ done: false });
      }
      state.rebuild.finishedAt = new Date().toISOString();
      if (active) {
        state.active = active;
      }
      return Promise.resolve({ done: true });
    });
  }

  /** Smart search, after its embeddings were all made again at once (the job of all of them) */
  async setActive(task: ModelTask, config: MachineLearningConfig) {
    await this.update(task, config, async (state) => {
      state.active = { ...state.target };
      if (isRebuilding(state)) {
        state.rebuild!.finishedAt = new Date().toISOString();
      }
      await this.models.deleteRebuildEmbeddings();
      return {};
    });
  }

  private async decide(state: TaskModelState, model: KnownModel) {
    const targetModel = state.target.modelId ? ((await this.models.get(state.target.modelId)) ?? null) : null;
    return decideModel({ target: state.target, targetModel, model, now: new Date() });
  }

  private async startRebuild(task: ModelTask, state: TaskModelState, target: ModelRef) {
    state.target = target;
    state.generation++;
    state.rebuild = { startedAt: new Date().toISOString() };
    if (task === ModelTask.SEARCH) {
      if (state.active && (await this.isCompatible(state.active, target))) {
        // back to the model that is searched: nothing to make again
        state.rebuild = undefined;
        await this.models.deleteRebuildEmbeddings();
      } else {
        const { modelIds } = await this.getSelection(task, state, target);
        await this.models.deleteRebuildEmbeddings(modelIds);
      }
    }
  }

  private async update<T>(
    task: ModelTask,
    config: MachineLearningConfig,
    change: (state: TaskModelState) => Promise<T>,
  ): Promise<T & { state: TaskModelState }> {
    const { databaseRepository, systemMetadataRepository } = this.repositories;
    return databaseRepository.withLock(DatabaseLock.MachineLearningModels, async () => {
      const all = (await systemMetadataRepository.get(SystemMetadataKey.MachineLearningModels)) ?? {};
      const state = all[task] ?? initialState(task, configuredModelName(task, config));
      const generation = state.generation;
      const result = await change(state);
      await systemMetadataRepository.set(SystemMetadataKey.MachineLearningModels, { ...all, [task]: state });
      if (state.generation !== generation && isRebuilding(state)) {
        // once the state is written, which the rebuild reads
        await this.repositories.jobRepository.queue({
          name: REBUILD_JOBS[task],
          data: { generation: state.generation },
        });
      }
      return { ...result, state };
    });
  }

  private async markSeen(model: KnownModel & { format?: string | null }, format: string | null) {
    const now = Date.now();
    if (now - (lastWritten.get(model.id) ?? 0) < SEEN_EVERY_MS && model.format === format) {
      return;
    }
    lastWritten.set(model.id, now);
    model.lastSeenAt = new Date(now);
    await this.models.update(model.id, { lastSeenAt: model.lastSeenAt, format });
  }
}
