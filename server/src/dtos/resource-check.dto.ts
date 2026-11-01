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
    swap: z
      .object({
        bytes: z.number(),
        source: z.string().describe('cgroup when the container of the server has a swap limit below the machine'),
        level: LevelSchema.describe('Of memory and swap together, against what upstream documents as memory needed'),
        neededForMinimum: z.number().describe('The swap to add for memory and swap to reach the minimum (0: none)'),
        neededForRecommended: z.number().describe('The swap to add for memory and swap to reach the recommendation'),
      })
      .describe('A machine of little memory runs with swap: the background work goes on, more slowly'),
    memoryKills: z
      .object({
        lastWeek: z.number().describe('The times the background work ran out of memory in the last 7 days'),
        lastAt: z.string().nullable().describe('When it last did'),
      })
      .describe('The background work killed as memory ran out (see the server log)'),
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
