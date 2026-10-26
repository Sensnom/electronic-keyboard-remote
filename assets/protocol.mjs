// CRC16-CCITT-FALSE used to verify complete raw MIDI uploads.
export function crc16(bytes) {
  let crc=0xffff;
  for (const b of bytes) { crc^=b<<8; for(let i=0;i<8;i++) crc=((crc<<1)^((crc&0x8000)?0x1021:0))&65535; }
  return crc;
}
