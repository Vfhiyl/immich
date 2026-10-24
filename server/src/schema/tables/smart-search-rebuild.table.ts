import { Column, ForeignKeyColumn, Table } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { MachineLearningModelTable } from 'src/schema/tables/ml-model.table.js';

/**
 * The embeddings of the model smart search changes to, made in the background while `smart_search` (what is
 * searched) still holds the embeddings of the model it changes from; moved there at once when every photo has one
 */
@Table({ name: 'smart_search_rebuild' })
export class SmartSearchRebuildTable {
  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true })
  assetId!: string;

  @ForeignKeyColumn(() => MachineLearningModelTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE' })
  modelId!: string;

  // of any dimension: the model it is for may have another than the one searched
  @Column({ type: 'vector', storage: 'external', synchronize: false })
  embedding!: string;
}
