import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { MachineLearningModelsResponseDto } from 'src/dtos/ml-model.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { MachineLearningModelService } from 'src/services/ml-model.service.js';

/** The models of machine learning, which are chosen in the configuration and only shown here */
@ApiTags(ApiTag.Jobs)
@Controller('admin/machine-learning')
export class MachineLearningModelAdminController {
  constructor(private service: MachineLearningModelService) {}

  @Get('models')
  @Endpoint({
    summary: 'Get the models of machine learning',
    description:
      'Which model each task makes its results with, the progress of making them again after the model changed, and what was noticed about the files of the models',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ permission: Permission.JobRead, admin: true })
  getMachineLearningModels(): Promise<MachineLearningModelsResponseDto> {
    return this.service.getModels();
  }

  @Post('faces/regroup/undo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Undo the regroup of people',
    description:
      'Puts the faces back with the people they had before the people were regrouped for a new face model, but for what users changed since',
    history: new HistoryBuilder().added('v3.3.5').alpha('v3.3.5'),
  })
  @Authenticated({ permission: Permission.JobCreate, admin: true })
  undoFaceRegroup(): Promise<void> {
    return this.service.undoFaceRegroup();
  }
}
