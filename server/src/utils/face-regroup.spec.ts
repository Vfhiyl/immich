import { RegroupFace, facesLeavingPerson } from 'src/utils/face-regroup.js';

const face = (id: string, extra: Partial<RegroupFace> = {}): RegroupFace => ({
  id,
  isFixed: false,
  isCover: false,
  ...extra,
});
const chain = (...ids: string[]) => ids.slice(1).map((id, index) => ({ a: ids[index], b: id }));

describe(facesLeavingPerson.name, () => {
  it('should keep a person whose faces are all close, through others', () => {
    expect(facesLeavingPerson([face('a'), face('b'), face('c')], chain('a', 'b', 'c'))).toEqual([]);
  });

  it('should keep the largest part of a person nobody fixed, and take the others', () => {
    const faces = [face('a'), face('b'), face('c'), face('x'), face('y'), face('alone')];
    expect(facesLeavingPerson(faces, [...chain('a', 'b', 'c'), ...chain('x', 'y')])).toEqual(['x', 'y', 'alone']);
  });

  it('should keep the part of the picture of the person when two parts are as large', () => {
    const faces = [face('a'), face('b'), face('x'), face('y', { isCover: true })];
    expect(facesLeavingPerson(faces, [...chain('a', 'b'), ...chain('x', 'y')])).toEqual(['a', 'b']);
  });

  it('should keep the parts with a face a user fixed besides the largest, and never take a fixed face', () => {
    const faces = [
      face('a'),
      face('b'),
      face('c'),
      face('mine', { isFixed: true }),
      face('near'),
      face('other', { isFixed: true }),
      face('stray'),
    ];
    expect(facesLeavingPerson(faces, [...chain('a', 'b', 'c'), ...chain('mine', 'near')])).toEqual(['stray']);
  });

  it('should ignore pairs with faces of other people', () => {
    expect(facesLeavingPerson([face('a'), face('b')], [{ a: 'a', b: 'stranger' }, ...chain('a', 'b')])).toEqual([]);
  });
});
