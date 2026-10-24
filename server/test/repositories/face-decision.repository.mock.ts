import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { FaceDecisionRepository } from 'src/repositories/face-decision.repository.js';

/** No decisions of users, so that grouping works as upstream's without setup */
export const newFaceDecisionRepositoryMock = (): Mocked<RepositoryInterface<FaceDecisionRepository>> => ({
  assign: vitest.fn().mockResolvedValue(undefined),
  unassign: vitest.fn().mockResolvedValue(undefined),
  move: vitest.fn().mockResolvedValue(undefined),
  getExcludedPeople: vitest.fn().mockResolvedValue(new Set()),
  getAssigned: vitest.fn().mockResolvedValue(new Set()),
});
