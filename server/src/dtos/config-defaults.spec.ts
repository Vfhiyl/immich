import { defaults } from 'src/dtos/config.dto.js';

// Only the settings that differ from the defaults are saved: a deployment that never changed a model follows the
// default of the code, so changing a default (e.g. in a merge of an upstream release) changes the model of those
// deployments, and the server rebuilds the results of every photo in the background. That is a change to announce in
// the release notes, not one to make in passing: update this test only together with that note.
describe('default machine learning models', () => {
  it('should not change without a note in the release notes', () => {
    expect({
      clip: defaults.machineLearning.clip.modelName,
      facialRecognition: defaults.machineLearning.facialRecognition.modelName,
      ocr: defaults.machineLearning.ocr.modelName,
    }).toEqual({
      clip: 'ViT-B-32__openai',
      facialRecognition: 'buffalo_l',
      ocr: 'PP-OCRv5_mobile',
    });
  });
});
