import { Injectable } from '@nestjs/common';
import { StorageCore } from 'src/cores/storage.core.js';
import { ResourceCheckResponseDto } from 'src/dtos/resource-check.dto.js';
import { SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { countMemoryKills } from 'src/utils/memory-kills.js';
import { isMachineLearningEnabled } from 'src/utils/misc.js';
import {
  RESOURCE_REQUIREMENTS,
  checkLevel,
  readCpuLimit,
  readDisk,
  readMemoryLimit,
  readSwap,
} from 'src/utils/server-resources.js';

/** What the server has to run on, against what upstream documents as needed, for the welcome and admin pages */
@Injectable()
export class ResourceCheckService extends BaseService {
  async getResourceCheck(): Promise<ResourceCheckResponseDto> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    const [memory, swap, cpus, disk, kills] = await Promise.all([
      readMemoryLimit(),
      readSwap(),
      readCpuLimit(),
      readDisk(StorageCore.getMediaLocation()),
      this.systemMetadataRepository.get(SystemMetadataKey.MemoryKills),
    ]);
    const enabled = isMachineLearningEnabled(machineLearning);
    const services = enabled
      ? await Promise.all(
          machineLearning.urls.map(async (url) => {
            const [reachable, resources] = await Promise.all([
              this.machineLearningRepository.ping(url),
              this.machineLearningRepository.getResources(url),
            ]);
            return { url, reachable, memory: resources?.memory ?? null };
          }),
        )
      : [];
    const { memory: needsMemory, cpus: needsCpus, disk: needsDisk } = RESOURCE_REQUIREMENTS;

    // memory and swap together: with swap, a machine of less memory than needed runs, the background work slower
    const withSwap = memory.bytes + swap.bytes;
    const now = new Date();
    return {
      memory: { ...memory, level: checkLevel(memory.bytes, needsMemory) },
      swap: {
        ...swap,
        level: checkLevel(withSwap, needsMemory),
        neededForMinimum: Math.max(0, needsMemory.minimum - withSwap),
        neededForRecommended: Math.max(0, needsMemory.recommended - withSwap),
      },
      memoryKills: { lastWeek: countMemoryKills(kills, now), lastAt: kills?.kills?.at(-1)?.at ?? null },
      cpus: { ...cpus, level: checkLevel(cpus.cores, needsCpus) },
      disk: { ...disk, level: checkLevel(disk.free, needsDisk) },
      machineLearning: { enabled, services },
      requirements: {
        memoryMinimum: needsMemory.minimum,
        memoryRecommended: needsMemory.recommended,
        cpusMinimum: needsCpus.minimum,
        cpusRecommended: needsCpus.recommended,
        diskMinimum: needsDisk.minimum,
      },
    };
  }
}
