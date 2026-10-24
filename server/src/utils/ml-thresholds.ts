import { CLIP_MODEL_INFO } from 'src/constants.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { cleanModelName } from 'src/utils/misc.js';

/**
 * The thresholds of the models of machine learning, fixed per model like the dimensions of CLIP models: they belong to
 * a model (a distance that tells two people apart under one model may merge them under another), so they change with
 * it and are not settings. A model missing here is refused in the configuration.
 *
 * The values are upstream's defaults, which it uses for every model; they are kept until a model is measured on a
 * labelled set of faces (and a new model gets its values from such a measurement).
 */
export const FACE_MODEL_THRESHOLDS: Record<string, { minScore: number; maxDistance: number }> = {
  antelopev2: { minScore: 0.7, maxDistance: 0.5 },
  buffalo_l: { minScore: 0.7, maxDistance: 0.5 },
  buffalo_m: { minScore: 0.7, maxDistance: 0.5 },
  buffalo_s: { minScore: 0.7, maxDistance: 0.5 },
};

/** How many faces within the distance make a person (independent of the model, but not a setting either) */
export const FACE_MIN_FACES = 3;

const OCR_DEFAULTS = { minDetectionScore: 0.5, minRecognitionScore: 0.8, maxResolution: 736 };
export const OCR_MODEL_THRESHOLDS: Record<
  string,
  { minDetectionScore: number; minRecognitionScore: number; maxResolution: number }
> = {
  'PP-OCRv6_medium': OCR_DEFAULTS,
  'PP-OCRv6_small': OCR_DEFAULTS,
  'PP-OCRv6_tiny': OCR_DEFAULTS,
  'PP-OCRv5_server': OCR_DEFAULTS,
  'PP-OCRv5_mobile': OCR_DEFAULTS,
  'EN__PP-OCRv5_mobile': OCR_DEFAULTS,
  'EL__PP-OCRv5_mobile': OCR_DEFAULTS,
  'KOREAN__PP-OCRv5_mobile': OCR_DEFAULTS,
  'LATIN__PP-OCRv5_mobile': OCR_DEFAULTS,
  'ESLAV__PP-OCRv5_mobile': OCR_DEFAULTS,
  'TH__PP-OCRv5_mobile': OCR_DEFAULTS,
};

/** The distance of embeddings of smart search under which two photos are duplicates, per CLIP model */
export const DUPLICATE_MAX_DISTANCE: Record<string, number> = Object.fromEntries(
  Object.keys(CLIP_MODEL_INFO).map((name) => [name, 0.01]),
);

const lookup = <T>(table: Record<string, T>, kind: string, modelName: string): T => {
  const found = table[cleanModelName(modelName)];
  if (!found) {
    throw new Error(`Unknown ${kind} model: ${modelName}`);
  }
  return found;
};

type MachineLearningConfig = SystemConfig['machineLearning'];

export const getFaceThresholds = (config: MachineLearningConfig) => ({
  ...lookup(FACE_MODEL_THRESHOLDS, 'facial recognition', config.facialRecognition.modelName),
  minFaces: FACE_MIN_FACES,
});

export const getOcrThresholds = (config: MachineLearningConfig) =>
  lookup(OCR_MODEL_THRESHOLDS, 'OCR', config.ocr.modelName);

export const getDuplicateMaxDistance = (config: MachineLearningConfig) =>
  lookup(DUPLICATE_MAX_DISTANCE, 'CLIP', config.clip.modelName);

/** The settings of upstream that are fixed per model here, as the configuration may still hold them */
export const IGNORED_THRESHOLD_SETTINGS = (config: MachineLearningConfig) => ({
  'machineLearning.duplicateDetection.maxDistance': config.duplicateDetection.maxDistance,
  'machineLearning.facialRecognition.minScore': config.facialRecognition.minScore,
  'machineLearning.facialRecognition.maxDistance': config.facialRecognition.maxDistance,
  'machineLearning.facialRecognition.minFaces': config.facialRecognition.minFaces,
  'machineLearning.ocr.minDetectionScore': config.ocr.minDetectionScore,
  'machineLearning.ocr.minRecognitionScore': config.ocr.minRecognitionScore,
  'machineLearning.ocr.maxResolution': config.ocr.maxResolution,
});
