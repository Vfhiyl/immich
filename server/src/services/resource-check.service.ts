import { Injectable } from '@nestjs/common';
import { StorageCore } from 'src/cores/storage.core.js';
import { ResourceCheckResponseDto } from 'src/dtos/resource-check.dto.js';
import { BaseService } from 'src/services/base.service.js';
import { isMachineLearningEnabled } from 'src/utils/misc.js';
import {
  RESOURCE_REQUIREMENTS,
  checkLevel,
  readCpuLimit,
  readDisk,
  readMemoryLimit,
} from 'src/utils/server-resources.js';

/** What the server has to run on, against what upstream documents as needed, for the welcome and admin pages */
@Injectable()
export class ResourceCheckService extends BaseService {
  async getResourceCheck(): Promise<ResourceCheckResponseDto> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    const [memory, cpus, disk] = await Promise.all([
      readMemoryLimit(),
      readCpuLimit(),
      readDisk(StorageCore.getMediaLocation()),
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

    return {
      memory: { ...memory, level: checkLevel(memory.bytes, needsMemory) },
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
