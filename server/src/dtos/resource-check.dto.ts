import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ResourceCheckLevel } from 'src/utils/server-resources.js';

const LevelSchema = z
  .enum(ResourceCheckLevel)
  .describe('Against what upstream documents as needed: below the minimum, below the recommendation, or enough')
  .meta({ id: 'ResourceCheckLevel' });

const ResourceCheckResponseSchema = z
  .object({
    memory: z.object({
      bytes: z.number(),
      source: z
        .string()
        .describe('cgroup when the container of the server has a limit below the machine, else machine'),
      level: LevelSchema,
    }),
    cpus: z.object({
      cores: z.number(),
      source: z
        .string()
        .describe('cgroup when the container of the server has a quota below the machine, else machine'),
      level: LevelSchema,
    }),
    disk: z.object({
      path: z.string().describe('The media location, inside the container'),
      free: z.number(),
      total: z.number(),
      level: LevelSchema,
    }),
    machineLearning: z.object({
      enabled: z.boolean(),
      services: z.array(
        z.object({
          url: z.string(),
          reachable: z.boolean(),
          memory: z
            .object({ used: z.number(), limit: z.number(), source: z.string() })
            .nullable()
            .describe('Null when the service does not tell (upstream image) or does not answer'),
        }),
      ),
    }),
    requirements: z.object({
      memoryMinimum: z.number(),
      memoryRecommended: z.number(),
      cpusMinimum: z.number(),
      cpusRecommended: z.number(),
      diskMinimum: z.number(),
    }),
  })
  .meta({ id: 'ResourceCheckResponseDto' });

export class ResourceCheckResponseDto extends createZodDto(ResourceCheckResponseSchema) {}
