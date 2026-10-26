// Standard MIDI File reader for the guided-key lesson. No external packages.
const decoder = new TextDecoder("ascii");

export function parseMidi(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (data.length > 1024 * 1024) throw new Error("MIDI 超过 1 MiB 软件导入上限");
  let pos = 0;
  const fail = message => { throw new Error(`MIDI 格式错误：${message}（字节 ${pos}）`); };
  const need = (n, end = data.length) => { if (pos + n > end) fail("文件截断"); };
  const byte = end => { need(1, end); return data[pos++]; };
  const u16 = end => (byte(end) << 8) | byte(end);
  const u32 = end => ((byte(end) * 0x1000000) + (byte(end) << 16) + (byte(end) << 8) + byte(end)) >>> 0;
  const tag = () => { need(4); const s = decoder.decode(data.subarray(pos, pos + 4)); pos += 4; return s; };
  const vlq = end => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = byte(end);
      v = (v << 7) | (b & 127);
      if (!(b & 128)) return v;
    }
    fail("可变长数超过四字节");
  };
  if (tag() !== "MThd") fail("缺少 MThd");
  const headerLength = u32();
  if (headerLength < 6) fail("文件头过短");
  const headerEnd = pos + headerLength;
  need(headerLength);
  const format = u16(headerEnd);
  const trackCount = u16(headerEnd);
  const division = u16(headerEnd);
  if (format > 1 || (format === 0 && trackCount !== 1) || !trackCount || trackCount > 256) fail("仅支持格式 0/1，最多256轨");
  if (division & 0x8000 || !division) fail("暂不支持 SMPTE 时间基");
  pos = headerEnd;
  const tracks = [], tempos = [];
  for (let t = 0; t < trackCount; t++) {
    if (tag() !== "MTrk") fail("缺少 MTrk");
    const length = u32();
    const end = pos + length;
    need(length);
    let tick = 0, running = 0, name = `轨道 ${t + 1}`, ended = false, drums = 0;
    const notes = [], held = new Map();
    while (pos < end) {
      tick += vlq(end);
      if (!Number.isSafeInteger(tick)) fail("时间戳溢出");
      let status = byte(end), first = null;
      if (status < 0x80) {
        if (!running) fail("缺少运行状态");
        first = status;
        status = running;
      } else if (status < 0xf0) {
        running = status;
      } else {
        running = 0;
      }
      if (status === 0xff) {
        const type = byte(end), size = vlq(end);
        need(size, end);
        if (type === 0x03) name = decoder.decode(data.subarray(pos, pos + size));
        if (type === 0x51) {
          if (size !== 3) fail("节拍事件长度错误");
          const us = data[pos] * 65536 + data[pos + 1] * 256 + data[pos + 2];
          if (!us) fail("节拍不能为零");
          tempos.push({tick, us});
        }
        if (type === 0x2f) {
          if (size !== 0 || pos !== end) fail("End of Track 位置或长度错误");
          ended = true;
        }
        pos += size;
      } else if (status === 0xf0 || status === 0xf7) {
        const size = vlq(end);
        need(size, end);
        pos += size;
      } else if (status >= 0x80 && status <= 0xef) {
        const kind = status & 0xf0;
        const a = first === null ? byte(end) : first;
        const b = kind === 0xc0 || kind === 0xd0 ? null : byte(end);
        if (a >= 0x80 || (b !== null && b >= 0x80)) fail("数据字节无效");
        const key = `${status & 15}:${a}`;
        if (kind === 0x90 && b > 0 && (status & 0x0f) !== 9) {
          const note = { tick, note: a, velocity: b, endTick: null };
          if (held.has(key)) note.overlap = held.get(key).overlap = true;
          notes.push(note); held.set(key, note);
        }
        if ((kind === 0x80 || (kind === 0x90 && b === 0)) && held.has(key)) {
          held.get(key).endTick = tick; held.delete(key);
        }
        if (kind === 0x90 && b > 0 && (status & 0x0f) === 9) drums++;
      } else {
        fail("不支持的系统事件");
      }
    }
    if (!ended) fail("缺少 End of Track");
    tracks.push({ name, notes, drums, endTick: tick });
  }
  if (pos !== data.length) fail("轨道末尾有多余数据");
  let durationSeconds = 0, lastTick = 0, tempo = 500000;
  for (const change of tempos.sort((a,b) => a.tick - b.tick)) {
    durationSeconds += (change.tick - lastTick) * tempo / division / 1e6;
    lastTick = change.tick; tempo = change.us;
  }
  durationSeconds += (Math.max(...tracks.map(t=>t.endTick)) - lastTick) * tempo / division / 1e6;
  return { format, division, tracks, tempos, durationSeconds };
}

export function buildLesson(midi, selectedTracks, modules = 2, transpose = 0) {
  if (!Number.isInteger(transpose) || Math.abs(transpose) > 48) throw new Error("移调须为 -48 到 48 的整数半音");
  if (modules !== 1 && modules !== 2) throw new Error("键盘模块数必须为 1 或 2");
  if (!Array.isArray(selectedTracks) || selectedTracks.length === 0)
    throw new Error("请至少选择一条旋律轨道");
  const events = [...new Set(selectedTracks)].flatMap(index => {
    if (!Number.isInteger(index) || !midi.tracks[index]) throw new Error("轨道编号无效");
    return midi.tracks[index].notes.map(e=>({...e, note:e.note+transpose}));
  }).sort((a, b) => a.tick - b.tick || a.note - b.note);
  if (!events.length) throw new Error("所选轨道没有旋律音符");
  const upper = modules === 1 ? 71 : 83;
  const outside = [...new Set(events.filter(e => e.note < 60 || e.note > upper).map(e => e.note))];
  if (outside.length) throw new Error(`有超出 C4–${modules === 1 ? "B4" : "B5"} 的 MIDI 音高：${outside.join(", ")}；请选择其他轨道或显式移调`);
  const steps = [];
  for (const event of events) {
    const mask = 1 << (event.note - 60);
    const last = steps.at(-1);
    if (last && last.tick === event.tick) last.mask |= mask;
    else steps.push({ tick: event.tick, mask });
  }
  return { version: 1, division: midi.division, modules, steps };
}
