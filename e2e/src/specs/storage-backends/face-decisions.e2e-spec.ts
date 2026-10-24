import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Api, ImmichServer, TestEnvironment, testAssetDir } from 'src/storage-backends.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const photoPath = join(testAssetDir, 'metadata/faces/portrait.jpg');

type Face = { id: string; person: { id: string } | null };

// what a user says about a face in the web or the apps is kept, and facial recognition keeps to it
describe('decisions of users about faces', () => {
  let environment: TestEnvironment;
  let server: ImmichServer;
  let api: Api;
  let assetId: string;

  const faces = async () => {
    const { body } = await api.json<Face[]>(`/faces?id=${assetId}`);
    return body;
  };
  const newPerson = async (name: string) => {
    const { body } = await api.json<{ id: string }>('/people', { method: 'POST', body: { name } });
    return body.id;
  };

  beforeAll(async () => {
    environment = await TestEnvironment.create();
    server = await ImmichServer.start(environment, { backends: false });
    api = await Api.signUpAdmin();
    ({ id: assetId } = await api.upload(photoPath, await readFile(photoPath)));
  }, 120_000);

  afterEach(({ task }) => {
    if (task.result?.state === 'fail') {
      console.log(`Server output for "${task.name}":\n${server?.logs.split('\n').slice(-60).join('\n')}`);
    }
  });

  afterAll(async () => {
    await server?.stop();
    await environment?.destroy();
  });

  it('should keep that a user moved a face to another person, and that it is not the first one', async () => {
    const [first, second] = [await newPerson('First'), await newPerson('Second')];
    await api.json('/faces', {
      method: 'POST',
      body: { assetId, personId: first, imageWidth: 100, imageHeight: 100, x: 10, y: 10, width: 20, height: 20 },
    });
    const [face] = await faces();

    await api.json(`/faces/${second}`, { method: 'PUT', body: { id: face.id } });

    await expect(faces()).resolves.toEqual([
      expect.objectContaining({ person: expect.objectContaining({ id: second }) }),
    ]);
    await expect(
      environment.query('select "personGroupId" from face_user_assignment where "faceId" = $1', [face.id]),
    ).resolves.toEqual([{ personGroupId: second }]);
    await expect(
      environment.query('select "personGroupId" from face_user_rejection where "faceId" = $1', [face.id]),
    ).resolves.toEqual([{ personGroupId: first }]);
  });

  it('should take a face from its person when the user says it is not them', async () => {
    const [face] = await faces();
    const personId = face.person!.id;

    const { status } = await api.json(`/faces/${face.id}/reject`, { method: 'POST' });

    expect(status).toBe(204);
    await expect(faces()).resolves.toEqual([expect.objectContaining({ id: face.id, person: null })]);
    const rejected = await environment.query<{ personGroupId: string }>(
      'select "personGroupId" from face_user_rejection where "faceId" = $1',
      [face.id],
    );
    expect(rejected.map(({ personGroupId }) => personGroupId)).toContain(personId);
    await expect(api.json(`/faces/${face.id}/reject`, { method: 'POST' })).resolves.toMatchObject({ status: 400 });
  });
});
