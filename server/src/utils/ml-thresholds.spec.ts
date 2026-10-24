import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import {
  FACE_MODEL_THRESHOLDS,
  OCR_MODEL_THRESHOLDS,
  getDuplicateMaxDistance,
  getFaceThresholds,
  getOcrThresholds,
} from 'src/utils/ml-thresholds.js';

const config = (overrides: Partial<Record<'clip' | 'facialRecognition' | 'ocr', string>>) => {
  const machineLearning = structuredClone(defaults.machineLearning) as SystemConfig['machineLearning'];
  for (const [task, modelName] of Object.entries(overrides)) {
    machineLearning[task as 'clip'].modelName = modelName;
  }
  return machineLearning;
};

describe('thresholds of models', () => {
  it('should take the thresholds of the model, not those of the settings', () => {
    const machineLearning = config({});
    machineLearning.facialRecognition.maxDistance = 1.5;
    machineLearning.facialRecognition.minFaces = 1;
    machineLearning.ocr.minRecognitionScore = 0.1;
    machineLearning.duplicateDetection.maxDistance = 0.1;

    expect(getFaceThresholds(machineLearning)).toEqual({ minScore: 0.7, maxDistance: 0.5, minFaces: 3 });
    expect(getOcrThresholds(machineLearning)).toEqual({
      minDetectionScore: 0.5,
      minRecognitionScore: 0.8,
      maxResolution: 736,
    });
    expect(getDuplicateMaxDistance(machineLearning)).toBe(0.01);
  });

  it('should know the models upstream offers, also by their names with the organization', () => {
    expect(Object.keys(FACE_MODEL_THRESHOLDS).toSorted()).toEqual([
      'antelopev2',
      'buffalo_l',
      'buffalo_m',
      'buffalo_s',
    ]);
    expect(OCR_MODEL_THRESHOLDS).toHaveProperty('PP-OCRv5_mobile');
    expect(getFaceThresholds(config({ facialRecognition: 'immich-app/antelopev2' })).maxDistance).toBe(0.5);
    expect(getDuplicateMaxDistance(config({ clip: 'ViT-B-32::openai' }))).toBe(0.01);
  });

  it('should refuse models without thresholds', () => {
    expect(() => getFaceThresholds(config({ facialRecognition: 'unknown' }))).toThrow(
      'Unknown facial recognition model: unknown',
    );
    expect(() => getOcrThresholds(config({ ocr: 'unknown' }))).toThrow('Unknown OCR model: unknown');
  });

  // the values belong to the models: change them only with a measurement of the model on labelled faces, and a note
  // in the release notes (a change regroups the people of every server)
  it('should not change without a measurement', () => {
    expect(FACE_MODEL_THRESHOLDS).toEqual({
      antelopev2: { minScore: 0.7, maxDistance: 0.5 },
      buffalo_l: { minScore: 0.7, maxDistance: 0.5 },
      buffalo_m: { minScore: 0.7, maxDistance: 0.5 },
      buffalo_s: { minScore: 0.7, maxDistance: 0.5 },
    });
  });
});
