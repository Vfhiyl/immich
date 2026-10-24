import { ForeignKeyColumn, PrimaryColumn, Table } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { MachineLearningModelTable } from 'src/schema/tables/ml-model.table.js';

/**
 * Which model made the results of a photo for a task (faces, text recognition); results without a row were made
 * before models were recorded
 */
@Table({ name: 'asset_ml_result' })
export class AssetMachineLearningResultTable {
  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: false })
  assetId!: string;

  @PrimaryColumn({ type: 'character varying' })
  task!: string;

  @ForeignKeyColumn(() => MachineLearningModelTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE' })
  modelId!: string;
}
