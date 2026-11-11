/** Un zip mínimo para las pruebas: entradas comprimidas con deflate (o guardadas tal cual). */
import { deflateRawSync } from 'node:zlib';

function crc32(data: Buffer): number {
	let crc = ~0;
	for (const byte of data) {
		crc ^= byte;
		for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return ~crc >>> 0;
}

export function zip(entries: { path: string; bytes: Buffer | string; guardar?: boolean }[]): Buffer {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const raw = Buffer.isBuffer(e.bytes) ? e.bytes : Buffer.from(e.bytes, 'utf8');
		const data = e.guardar ? raw : deflateRawSync(raw);
		const name = Buffer.from(e.path, 'utf8');
		const method = e.guardar ? 0 : 8;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc32(raw), 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, data);
		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(0x02014b50, 0);
		cd.writeUInt16LE(20, 4);
		cd.writeUInt16LE(20, 6);
		cd.writeUInt16LE(0x800, 8);
		cd.writeUInt16LE(method, 10);
		cd.writeUInt32LE(crc32(raw), 16);
		cd.writeUInt32LE(data.length, 20);
		cd.writeUInt32LE(raw.length, 24);
		cd.writeUInt16LE(name.length, 28);
		cd.writeUInt32LE(offset, 42);
		central.push(cd, name);
		offset += 30 + name.length + data.length;
	}
	const cdBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cdBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cdBuf, end]);
}
