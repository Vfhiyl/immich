export interface RegroupFace {
  id: string;
  /** Given by a user, drawn by hand or read from a file: never taken from the person */
  isFixed: boolean;
  /** The face of the picture of the person */
  isCover: boolean;
}

/**
 * Which faces leave a person after its faces got embeddings of another model: the faces close to each other (pairs
 * within the distance of the model) form parts; the largest part stays, and so do the parts that hold a fixed face.
 * Fixed faces never leave.
 */
export const facesLeavingPerson = (faces: RegroupFace[], pairs: Array<{ a: string; b: string }>): string[] => {
  const parent = new Map(faces.map(({ id }) => [id, id]));
  const root = (id: string) => {
    let current = id;
    while (parent.get(current) !== current) {
      const next = parent.get(parent.get(current)!)!;
      parent.set(current, next);
      current = next;
    }
    return current;
  };
  for (const { a, b } of pairs) {
    if (!(parent.has(a) && parent.has(b))) {
      continue;
    }

    const [ra, rb] = [root(a), root(b)];
    if (ra !== rb) {
      parent.set(ra, rb);
    }
  }

  const parts = new Map<string, RegroupFace[]>();
  for (const face of faces) {
    const key = root(face.id);
    const part = parts.get(key);
    if (part) {
      part.push(face);
    } else {
      parts.set(key, [face]);
    }
  }

  // the largest part (the one of the picture of the person when two are as large) is the person; the parts with a face
  // a user gave it stay too, even when that face is unlike the others
  const [largest] = [...parts].toSorted(
    ([, a], [, b]) =>
      b.length - a.length || Number(b.some(({ isCover }) => isCover)) - Number(a.some(({ isCover }) => isCover)),
  );
  const kept = new Set([...parts].filter(([, members]) => members.some(({ isFixed }) => isFixed)).map(([key]) => key));
  if (largest) {
    kept.add(largest[0]);
  }

  return faces.filter((face) => !face.isFixed && !kept.has(root(face.id))).map(({ id }) => id);
};
