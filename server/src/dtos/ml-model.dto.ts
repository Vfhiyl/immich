import { createZodDto } from 'nestjs-zod';
import z from 'zod';

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
    conflict: z
      .object({ model: MachineLearningModelSchema, at: z.string() })
      .nullable()
      .describe('Files that were replaced came back from a machine learning server: its results are not kept'),
  })
  .meta({ id: 'MachineLearningTaskModelsDto' });

const MachineLearningModelsResponseSchema = z
  .object({ tasks: z.array(MachineLearningTaskModelsSchema) })
  .meta({ id: 'MachineLearningModelsResponseDto' });

export class MachineLearningModelsResponseDto extends createZodDto(MachineLearningModelsResponseSchema) {}
export type MachineLearningModelDto = z.infer<typeof MachineLearningModelSchema>;
