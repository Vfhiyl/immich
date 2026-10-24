import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { BackoffLevel } from 'src/utils/ml-backoff.js';

const MachineLearningModelSchema = z
  .object({
    name: z.string(),
    fingerprint: z
      .string()
      .nullable()
      .describe('SHA-256 of the files of the model, null until a result came back, or when the service does not tell'),
    format: z.string().nullable().describe('The format it ran in when last seen (onnx, armnn, rknn)'),
    firstSeenAt: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
  })
  .meta({ id: 'MachineLearningModelDto' });

const MachineLearningTaskModelsSchema = z
  .object({
    task: z.string().describe('clip (smart search and duplicates), facial-recognition, or ocr'),
    enabled: z.boolean(),
    configuredModel: z.string().describe('The model named in the configuration'),
    target: MachineLearningModelSchema.describe('The model the task makes its results with'),
    active: MachineLearningModelSchema.nullable().describe(
      'Smart search only: the model of the embeddings that are searched, until a rebuild switches to the target',
    ),
    rebuild: z
      .object({
        startedAt: z.string(),
        finishedAt: z.string().nullable(),
        total: z.int().nullable().describe('The photos the task makes results for, while the rebuild runs'),
        done: z.int().nullable().describe('Of them, those with results of the target'),
      })
      .nullable()
      .describe('The last time the results of every photo were made again for another model'),
    replaced: z
      .object({ from: MachineLearningModelSchema, to: MachineLearningModelSchema, at: z.string() })
      .nullable()
      .describe('The last time the files of the model changed under the same name'),
    regroup: z
      .object({
        startedAt: z.string(),
        finishedAt: z.string().nullable(),
        undoneAt: z.string().nullable(),
        facesLeft: z.int().describe('Faces that are no longer with the person they had'),
        facesJoined: z.int().describe('Faces that are with another person than before, or new'),
        people: z
          .array(
            z.object({
              personGroupId: z.string(),
              names: z.string().nullable().describe('The names the owners gave the person'),
              before: z.int(),
              left: z.int(),
              joined: z.int(),
            }),
          )
          .describe('The named people that changed most'),
        otherPeople: z.int().describe('The people without a name that changed'),
      })
      .nullable()
      .describe('Facial recognition only: the people regrouped after a change of the face model, and what changed'),
    conflict: z
      .object({ model: MachineLearningModelSchema, at: z.string() })
      .nullable()
      .describe('Files that were replaced came back from a machine learning server: its results are not kept'),
  })
  .meta({ id: 'MachineLearningTaskModelsDto' });

const MachineLearningBackoffSchema = z
  .object({
    level: z
      .enum(BackoffLevel)
      .describe('normal: as configured; reduced: one job at a time; paused: none until the memory is free again')
      .meta({ id: 'MachineLearningBackoffLevel' }),
    checkedAt: z.string(),
    memory: z
      .object({
        used: z.number(),
        limit: z.number(),
        source: z.string().describe('cgroup2 or cgroup1 (the container has a limit), or meminfo (the machine)'),
      })
      .nullable(),
    pressure: z
      .object({
        some: z.number().describe('Percent of the last 10 seconds in which some tasks waited for memory'),
        full: z.number().describe('Percent of the last 10 seconds in which all tasks waited for memory'),
      })
      .nullable(),
  })
  .meta({ id: 'MachineLearningBackoffDto' });

const MachineLearningModelsResponseSchema = z
  .object({
    tasks: z.array(MachineLearningTaskModelsSchema),
    backoff: MachineLearningBackoffSchema.nullable().describe(
      'How the jobs that send photos to machine learning give way to its memory, as last checked',
    ),
  })
  .meta({ id: 'MachineLearningModelsResponseDto' });

export class MachineLearningModelsResponseDto extends createZodDto(MachineLearningModelsResponseSchema) {}
export type MachineLearningModelDto = z.infer<typeof MachineLearningModelSchema>;
