# Machine Learning Models

Smart search, duplicate detection, facial recognition and text recognition (OCR) use models that the machine learning container downloads the first time it needs them. This page tells where they come from, how to keep them from changing under you, and what Immich does when they change.

## Where models come from

| Task                     | Default model      | Downloaded from                                                                                                                                                            |
| ------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smart search, duplicates | `ViT-B-32__openai` | Hugging Face, `immich-app/ViT-B-32__openai`                                                                                                                                |
| Facial recognition       | `buffalo_l`        | Hugging Face, `immich-app/buffalo_l`                                                                                                                                       |
| Text recognition (OCR)   | `PP-OCRv5_mobile`  | with the original exports (the default), RapidOCR's files on ModelScope, checked against their SHA-256; with the newer exports, Hugging Face, `immich-app/PP-OCRv5_mobile` |

The machine learning container downloads the branch selected by `MACHINE_LEARNING_MODEL_REVISION` (`main`, the original exports, or `v2`, the newer exports) into its cache folder (`/cache`, the `model-cache` volume), and never downloads a model again while its files are in the cache. Nothing updates a model on its own; but when the cache is lost (the volume removed, or a model that fails to load, whose files the container deletes), the files are downloaded again as the repository holds them **at that time**, and the repositories have had their files replaced in the past.

Behind a proxy or in a region where Hugging Face is slow, set `HF_ENDPOINT` on the machine learning container to a mirror of it.

## Keeping the models fixed

- **Name the models in the [config file](/install/config-file.md).** Only the settings that differ from the defaults are saved, so a server whose settings were never changed uses the default models of its version: a new version that changes a default changes the model of such a server. With the names in the config file (`machineLearning.clip.modelName`, `machineLearning.facialRecognition.modelName`, `machineLearning.ocr.modelName`), a model changes only when you change it.
- **Back up the `model-cache` volume**, or keep it on a disk that survives the container: with the files in the cache, the container never downloads them again.
- Every container of machine learning should use the same image (CPU, CUDA, OpenVINO, ARM NN, RKNN, …) and the same cache: the hardware formats (ONNX, ARM NN, RKNN) are different files.

## Memory

Each model takes memory while it is loaded (it is unloaded after `MACHINE_LEARNING_MODEL_TTL` seconds without use), and the jobs of smart search, face detection and text recognition run at the same time. Immich needs at least 6 GB of RAM with machine learning (see [Requirements](/install/requirements.md)); give every container a memory limit (see [Can I limit CPU and RAM usage?](/FAQ#can-i-limit-cpu-and-ram-usage)), so that a container that needs more than it has is stopped on its own instead of the whole server running out of memory.
