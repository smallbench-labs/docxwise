export interface ImgInfo { type: 'png' | 'jpg' | 'gif' | 'bmp'; width: number; height: number }

export function sniffImage(buf: ArrayBuffer): ImgInfo | null {
	const b = new Uint8Array(buf);
	const dv = new DataView(buf);
	if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: 'png', width: dv.getUint32(16), height: dv.getUint32(20) };
	if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { type: 'gif', width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
	if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return { type: 'bmp', width: dv.getInt32(18, true), height: Math.abs(dv.getInt32(22, true)) };
	if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) { i++; continue; }
			const mk = b[i + 1];
			if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { type: 'jpg', height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
			if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
			i += 2 + dv.getUint16(i + 2);
		}
	}
	return null;
}
