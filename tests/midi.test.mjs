import test from "node:test";
import assert from "node:assert/strict";
import { parseMidi, buildLesson } from "../assets/midi.mjs";

const be16 = n => [(n >> 8) & 255, n & 255];
const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (name, bytes) => [...Buffer.from(name), ...be32(bytes.length), ...bytes];
const file = tracks => new Uint8Array([
  ...chunk("MThd", [...be16(tracks.length === 1 ? 0 : 1), ...be16(tracks.length), ...be16(480)]),
  ...tracks.flatMap(t => chunk("MTrk", t))
]);

test("单轨运行状态、和弦与连续同音", () => {
  const midi = parseMidi(file([[0, 0x90, 60, 80, 0, 64, 90, 10, 60, 0, 0, 0x90, 60, 80, 0, 0xff, 0x2f, 0]]));
  assert.deepEqual(buildLesson(midi, [0], 1).steps, [
    { tick: 0, mask: (1 << 0) | (1 << 4) },
    { tick: 10, mask: 1 }
  ]);
});

test("双轨合并同刻音符，排除鼓通道", () => {
  const midi = parseMidi(file([
    [0, 0x90, 60, 80, 0, 0xff, 0x2f, 0],
    [0, 0x91, 72, 70, 0, 0x99, 40, 100, 0, 0xff, 0x2f, 0]
  ]));
  assert.deepEqual(buildLesson(midi, [0, 1], 2).steps, [{ tick: 0, mask: 0x1001 }]);
  assert.throws(() => buildLesson(midi, [0, 1], 1), /超出/);
});

test("损坏文件和不支持的格式被拒绝", () => {
  assert.throws(() => parseMidi(new Uint8Array([1, 2, 3, 4])), /MThd/);
  assert.throws(() => parseMidi(file([[0, 60, 80]])), /运行状态/);
  assert.throws(() => parseMidi(file([[0, 0x90, 60]])), /截断/);
});
