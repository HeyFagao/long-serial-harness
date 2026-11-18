import { describe, expect, it } from "vitest";
import { addFolder, emptyFiling } from "../src/serial-library-folders.js";
import { assignLibraryOrder, compareLibraryInputFilenames, extendLibraryOrder, parseLibraryOrder } from "../src/serial-library-order.js";

const id = (number: number) => number.toString(16).padStart(64, "0");

describe("persistent library sequence helpers", () => {
  it("sorts filename numbers naturally without changing book title semantics", () => {
    const files = ["10_甲.txt", "2_乙.txt", "001_丙.txt"].map(filename => ({ filename }));
    expect(files.sort(compareLibraryInputFilenames).map(file => file.filename)).toEqual(["001_丙.txt", "2_乙.txt", "10_甲.txt"]);
  });
  it("preserves assigned numbers and appends unknown identities after deleted reservations", () => {
    const original = extendLibraryOrder(undefined, [id(1), id(2), id(3)]);
    const assigned = assignLibraryOrder([{ id: id(3), title: "丙" }, { id: id(4), title: "阿新书" }], original);
    expect(assigned.books.map(book => book.sequence)).toEqual([3, 4]);
    expect(assigned.order.nextSequence).toBe(5);
    expect(assigned.order.sequences[id(1)]).toBe(1);
    expect(original.nextSequence).toBe(4);
  });
  it("rejects damaged sequence bindings instead of silently renumbering", () => {
    const good = { schemaVersion: 1, nextSequence: 3, sequences: { [id(1)]: 1, [id(2)]: 2 } };
    expect(parseLibraryOrder(good)).toEqual(good);
    expect(parseLibraryOrder({ ...good, displayOrder: [id(2), id(1)] }).displayOrder).toEqual([id(2), id(1)]);
    const invalid = [null, {}, { ...good, nextSequence: 2 }, { ...good, nextSequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...good, sequences: { [id(1)]: 1, [id(2)]: 1 } }, { ...good, sequences: { [id(1)]: 0 } }, { ...good, sequences: { notAnIdentity: 1 } },
      { ...good, displayOrder: [id(1)] }, { ...good, displayOrder: [id(1), id(1)] }, { ...good, displayOrder: [id(1), id(3)] }];
    for (const value of invalid) expect(() => parseLibraryOrder(value)).toThrow("未重新编号");
  });
});

describe("folder numbering and catalogue integrity", () => {
  const folderId = "aaaaaaaa-0000-4000-8000-000000000001";
  it("keeps default batch names distinct even after authors choose a future batch name", () => {
    const custom = addFolder(emptyFiling, folderId, "第二批").filing;
    expect(addFolder(custom, "bbbbbbbb-0000-4000-8000-000000000002").folder).toMatchObject({ number: 3, name: "第三批" });
    for (const [number, name] of [[10, "第十批"], [12, "第十二批"], [101, "第一百零一批"]] as const) {
      expect(addFolder({ ...emptyFiling, nextNumber: number }, folderId).folder.name).toBe(name);
    }
    for (const name of ["  ", "a\nb", "a".repeat(61), "未分组"]) expect(() => addFolder(emptyFiling, folderId, name)).toThrow();
  });
  it("rejects orphan memberships, reused ordinals and duplicate labels instead of silently unfiling books", () => {
    const filing = addFolder(emptyFiling, folderId, "夜班").filing;
    const order = { ...extendLibraryOrder(undefined, [id(1)]), filing: { ...filing, memberships: { [id(1)]: folderId } } };
    expect(parseLibraryOrder(order)).toEqual(order);
    const folder = filing.folders[0]!;
    const bad = [{ ...filing, memberships: { [id(2)]: folderId } }, { ...filing, memberships: { [id(1)]: "missing" } },
      { ...filing, nextNumber: 1 }, { ...filing, nextNumber: 3, folders: [folder, { ...folder, number: 2, id: "bbbbbbbb-0000-4000-8000-000000000002" }] }];
    for (const broken of bad) expect(() => parseLibraryOrder({ ...order, filing: broken })).toThrow("文件夹");
  });
});
