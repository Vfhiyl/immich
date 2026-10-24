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
- With several machine learning servers (`machineLearning.urls`), give them the same model files (the same cache, or copies of it): Immich does not mix results of different files (see below).

## Thresholds

The thresholds of the models (the lowest score of a detected face, the distance under which two faces are the same person, the number of faces that make a person, the distance under which two photos are duplicates, the scores and resolution of text recognition) belong to the model they were measured for, like the dimension of a CLIP model: they are fixed in the code for every model that can be chosen, and change with the model. They are not settings; the settings of earlier versions for them are ignored (the server logs it once at startup), and a model without thresholds of its own is refused in the settings.

## What users decide about faces

When a user gives a face to a person (in the web or the apps: another person for a face, or photos moved from one person to another), Immich keeps it apart from what facial recognition made: such a face stays with that person whatever facial recognition finds later, also after a change of the face model, and is not taken by "Reset" in Job Queues. **Not this person** (in the faces of a photo) takes a face from its person for good: facial recognition looks for its person again, and never gives it that person. Faces drawn by hand and faces read from the metadata of a file count as given by the user. A face is never given the person of another face of the same photo. Merging people carries all of this to the merged person. What was assigned before this version counts as made by facial recognition.

## When a model changes

Results of two models cannot be compared: the embeddings of smart search, the faces of facial recognition and the text of OCR are only meaningful among results of the same model. The machine learning service tells, with every result, which files made it (a SHA-256 _fingerprint_ of the model's export: its ONNX files, configuration and tokenizer), and the server keeps which model made the results of each photo. When a model changes, because another one is named in the settings or because its files changed (downloaded again after the cache was lost), the server makes the results of every photo again, in the background:

- New photos come first, as always; then the photos without results, the newest first; then those with results of the old model, the newest first.
- **Smart search** keeps searching the embeddings of the old model (and encodes queries with it) until every photo has an embedding of the new one, then switches to them at once; duplicates are detected again afterwards. A model of another dimension changes the database column in the same step, while searches wait for a moment.
- **Facial recognition** keeps the faces that are found in the same place, with their person and name, and gives them the embedding of the new model. New faces are grouped into people once every photo is done, so that faces are never compared across models.
- **Text recognition** keeps the lines that are found again (the same text in the same place, with their visibility), and changes only what changed.
- Hardware acceleration (CUDA, OpenVINO, ARM NN, RKNN, …) is not a change of model: it runs the same model (see [Hardware-Accelerated Machine Learning](/features/ml-hardware-acceleration.md)).

**Administration → Job Queues** shows the model of each task, the progress of a rebuild, when the files of a model changed, and a machine learning server that answers with files that were replaced (its results are not kept: make every server use the same files). The results made before this version count as made by the model named at the upgrade; the results of a machine learning service that does not tell its files (upstream's image) count as made by the model of that name, whatever its files.

## Memory

Each model takes memory while it is loaded (it is unloaded after `MACHINE_LEARNING_MODEL_TTL` seconds without use), and the jobs of smart search, face detection and text recognition run at the same time. Immich needs at least 6 GB of RAM with machine learning (see [Requirements](/install/requirements.md)); give every container a memory limit (see [Can I limit CPU and RAM usage?](/FAQ#can-i-limit-cpu-and-ram-usage)), so that a container that needs more than it has is stopped on its own instead of the whole server running out of memory.

The machine learning service tells the server how much memory it has and uses (`GET /resources`: the limit of its container, cgroup v2 or v1, or else the memory of the machine; in use means without the page cache, as `docker stats` counts it), and how long tasks waited for memory (Linux pressure stall information, where the kernel provides it). Every 10 seconds the server looks, and the jobs that send photos to machine learning give way:

- **One at a time**, when 85% of its memory or more is in use, or some tasks waited for memory 10% of the time or more;
- **Held** until the memory is free again, when 95% or more is in use, or all tasks waited 5% of the time or more;
- **One step back up**, after three checks in a row with less than 75% in use and some tasks waiting less than 2% of the time.

Searches are never held back. A machine learning service that does not tell its memory (upstream's image) is not held back either. **Administration → Job Queues** shows the memory of machine learning and whether its jobs give way; it also shows, like the welcome page of a new server, the memory, cores and free disk of the server against the requirements, and whether every machine learning service answers.
