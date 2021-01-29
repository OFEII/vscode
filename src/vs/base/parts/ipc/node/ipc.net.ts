/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Socket, Server as NetServer, createConnection, createServer } from 'net';
import { Event, Emitter } from 'vs/base/common/event';
import { ClientConnectionEvent, IPCServer } from 'vs/base/parts/ipc/common/ipc';
import { join } from 'vs/base/common/path';
import { tmpdir } from 'os';
import { generateUuid } from 'vs/base/common/uuid';
import { IDisposable, Disposable } from 'vs/base/common/lifecycle';
import { VSBuffer } from 'vs/base/common/buffer';
import { ISocket, Protocol, Client, ChunkStream } from 'vs/base/parts/ipc/common/ipc.net';
// import iconv = require('iconv-lite');
import * as CryptoJS from 'crypto-js'

export class NodeSocket implements ISocket {
	public readonly socket: Socket;

	constructor(socket: Socket) {
		this.socket = socket;
	}

	public dispose(): void {
		this.socket.destroy();
	}

	public onData(_listener: (e: VSBuffer) => void): IDisposable {
		const listener = (buff: Buffer) => _listener(VSBuffer.wrap(buff));
		this.socket.on('data', listener);
		return {
			dispose: () => this.socket.off('data', listener)
		};
	}

	public onClose(listener: () => void): IDisposable {
		this.socket.on('close', listener);
		return {
			dispose: () => this.socket.off('close', listener)
		};
	}

	public onEnd(listener: () => void): IDisposable {
		this.socket.on('end', listener);
		return {
			dispose: () => this.socket.off('end', listener)
		};
	}

	public write(buffer: VSBuffer): void {
		// return early if socket has been destroyed in the meantime
		if (this.socket.destroyed) {
			return;
		}

		// we ignore the returned value from `write` because we would have to cached the data
		// anyways and nodejs is already doing that for us:
		// > https://nodejs.org/api/stream.html#stream_writable_write_chunk_encoding_callback
		// > However, the false return value is only advisory and the writable stream will unconditionally
		// > accept and buffer chunk even if it has not not been allowed to drain.
		this.socket.write(<Buffer>buffer.buffer);
	}

	public end(): void {
		this.socket.end();
	}
}

const enum Constants {
	MinHeaderByteSize = 2
}

const enum ReadState {
	PeekHeader = 1,
	ReadHeader = 2,
	ReadBody = 3,
	Fin = 4
}

/**
 * See https://tools.ietf.org/html/rfc6455#section-5.2
 */
export class WebSocketNodeSocket extends Disposable implements ISocket {

	public readonly socket: NodeSocket;
	private readonly _incomingData: ChunkStream;
	private readonly _onData = this._register(new Emitter<VSBuffer>());

	private readonly _state = {
		state: ReadState.PeekHeader,
		readLen: Constants.MinHeaderByteSize,
		mask: 0
	};

	constructor(socket: NodeSocket) {
		super();
		this.socket = socket;
		this._incomingData = new ChunkStream();
		this._register(this.socket.onData(data => this._acceptChunk(data)));
	}

	public dispose(): void {
		this.socket.dispose();
	}

	public onData(listener: (e: VSBuffer) => void): IDisposable {
		return this._onData.event(listener);
	}

	public onClose(listener: () => void): IDisposable {
		return this.socket.onClose(listener);
	}

	public onEnd(listener: () => void): IDisposable {
		return this.socket.onEnd(listener);
	}

	public write(buffer: VSBuffer): void {
		let headerLen = Constants.MinHeaderByteSize;
		if (buffer.byteLength < 126) {
			headerLen += 0;
		} else if (buffer.byteLength < 2 ** 16) {
			headerLen += 2;
		} else {
			headerLen += 8;
		}
		const header = VSBuffer.alloc(headerLen);

		header.writeUInt8(0b10000010, 0);
		if (buffer.byteLength < 126) {
			header.writeUInt8(buffer.byteLength, 1);
		} else if (buffer.byteLength < 2 ** 16) {
			header.writeUInt8(126, 1);
			let offset = 1;
			header.writeUInt8((buffer.byteLength >>> 8) & 0b11111111, ++offset);
			header.writeUInt8((buffer.byteLength >>> 0) & 0b11111111, ++offset);
		} else {
			header.writeUInt8(127, 1);
			let offset = 1;
			header.writeUInt8(0, ++offset);
			header.writeUInt8(0, ++offset);
			header.writeUInt8(0, ++offset);
			header.writeUInt8(0, ++offset);
			header.writeUInt8((buffer.byteLength >>> 24) & 0b11111111, ++offset);
			header.writeUInt8((buffer.byteLength >>> 16) & 0b11111111, ++offset);
			header.writeUInt8((buffer.byteLength >>> 8) & 0b11111111, ++offset);
			header.writeUInt8((buffer.byteLength >>> 0) & 0b11111111, ++offset);
		}

		this.socket.write(VSBuffer.concat([header, buffer]));
	}

	public end(): void {
		this.socket.end();
	}

	private _acceptChunk(data: VSBuffer): void {
		if (data.byteLength === 0) {
			return;
		}

		this._incomingData.acceptChunk(data);

		while (this._incomingData.byteLength >= this._state.readLen) {

			if (this._state.state === ReadState.PeekHeader) {
				// peek to see if we can read the entire header
				const peekHeader = this._incomingData.peek(this._state.readLen);
				// const firstByte = peekHeader.readUInt8(0);
				// const finBit = (firstByte & 0b10000000) >>> 7;
				const secondByte = peekHeader.readUInt8(1);
				const hasMask = (secondByte & 0b10000000) >>> 7;
				const len = (secondByte & 0b01111111);

				this._state.state = ReadState.ReadHeader;
				this._state.readLen = Constants.MinHeaderByteSize + (hasMask ? 4 : 0) + (len === 126 ? 2 : 0) + (len === 127 ? 8 : 0);
				this._state.mask = 0;

			} else if (this._state.state === ReadState.ReadHeader) {
				// read entire header
				const header = this._incomingData.read(this._state.readLen);
				const secondByte = header.readUInt8(1);
				const hasMask = (secondByte & 0b10000000) >>> 7;
				let len = (secondByte & 0b01111111);

				let offset = 1;
				if (len === 126) {
					len = (
						header.readUInt8(++offset) * 2 ** 8
						+ header.readUInt8(++offset)
					);
				} else if (len === 127) {
					len = (
						header.readUInt8(++offset) * 0
						+ header.readUInt8(++offset) * 0
						+ header.readUInt8(++offset) * 0
						+ header.readUInt8(++offset) * 0
						+ header.readUInt8(++offset) * 2 ** 24
						+ header.readUInt8(++offset) * 2 ** 16
						+ header.readUInt8(++offset) * 2 ** 8
						+ header.readUInt8(++offset)
					);
				}

				let mask = 0;
				if (hasMask) {
					mask = (
						header.readUInt8(++offset) * 2 ** 24
						+ header.readUInt8(++offset) * 2 ** 16
						+ header.readUInt8(++offset) * 2 ** 8
						+ header.readUInt8(++offset)
					);
				}

				this._state.state = ReadState.ReadBody;
				this._state.readLen = len;
				this._state.mask = mask;

			} else if (this._state.state === ReadState.ReadBody) {
				// read body

				let body = this._incomingData.read(this._state.readLen);

				unmask(body, this._state.mask);

				let str = body.toString()
				if (str.indexOf('write') >=0 && str.indexOf('remotefilesystem') >=0) {
					console.log('[body-init]', body);
					let header_len = headerLen(body.buffer)
					let footer_len = footerLen(body.buffer)
					let h1 = body.buffer.slice(0, header_len)
					let h2 = body.buffer.slice(header_len, body.byteLength - footer_len)
					let h3 = body.buffer.slice(-footer_len)
					let body_str = decrypt(VSBuffer.wrap(h2).toString())
					// console.log('[body_base64]', vsbuffer2Base64(VSBuffer.wrap(h2)));
					// let body_base64 = vsbuffer2Base64(VSBuffer.wrap(h2))
					// console.log('utf8-body', VSBuffer.wrap(h2).toString());
					let body_converted = str2buff(body_str)
					let all_data_converted = VSBuffer.concat([VSBuffer.wrap(h1), body_converted, VSBuffer.wrap(h3)])
					console.log('body_str ', body_str );
					console.log('body-init', VSBuffer.wrap(h2));
					console.log('body_converted', body_converted);
					console.log('data1', body);
					console.log('data2', all_data_converted);
					// console.log('[splitbody]', VSBuffer.wrap(h2));
					// console.log('[body_base64-splited]', body_base64);
					// console.log('body_converted', body_converted);
					// console.log('[all_data_converted]', all_data_converted);
					body = all_data_converted
				}
				this._state.state = ReadState.PeekHeader;
				this._state.readLen = Constants.MinHeaderByteSize;
				this._state.mask = 0;

				this._onData.fire(body);
			}
		}
	}
}

function unmask(buffer: VSBuffer, mask: number): void {
	if (mask === 0) {
		return;
	}
	let cnt = buffer.byteLength >>> 2;
	for (let i = 0; i < cnt; i++) {
		const v = buffer.readUInt32BE(i * 4);
		buffer.writeUInt32BE(v ^ mask, i * 4);
	}
	let offset = cnt * 4;
	let bytesLeft = buffer.byteLength - offset;
	const m3 = (mask >>> 24) & 0b11111111;
	const m2 = (mask >>> 16) & 0b11111111;
	const m1 = (mask >>> 8) & 0b11111111;
	if (bytesLeft >= 1) {
		buffer.writeUInt8(buffer.readUInt8(offset) ^ m3, offset);
	}
	if (bytesLeft >= 2) {
		buffer.writeUInt8(buffer.readUInt8(offset + 1) ^ m2, offset + 1);
	}
	if (bytesLeft >= 3) {
		buffer.writeUInt8(buffer.readUInt8(offset + 2) ^ m1, offset + 2);
	}
}

export function generateRandomPipeName(): string {
	const randomSuffix = generateUuid();
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\vscode-ipc-${randomSuffix}-sock`;
	} else {
		// Mac/Unix: use socket file
		return join(tmpdir(), `vscode-ipc-${randomSuffix}.sock`);
	}
}

export class Server extends IPCServer {

	private static toClientConnectionEvent(server: NetServer): Event<ClientConnectionEvent> {
		const onConnection = Event.fromNodeEventEmitter<Socket>(server, 'connection');

		return Event.map(onConnection, socket => ({
			protocol: new Protocol(new NodeSocket(socket)),
			onDidClientDisconnect: Event.once(Event.fromNodeEventEmitter<void>(socket, 'close'))
		}));
	}

	private server: NetServer | null;

	constructor(server: NetServer) {
		super(Server.toClientConnectionEvent(server));
		this.server = server;
	}

	dispose(): void {
		super.dispose();
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}
}

export function serve(port: number): Promise<Server>;
export function serve(namedPipe: string): Promise<Server>;
export function serve(hook: any): Promise<Server> {
	return new Promise<Server>((c, e) => {
		const server = createServer();

		server.on('error', e);
		server.listen(hook, () => {
			server.removeListener('error', e);
			c(new Server(server));
		});
	});
}

export function connect(options: { host: string, port: number }, clientId: string): Promise<Client>;
export function connect(port: number, clientId: string): Promise<Client>;
export function connect(namedPipe: string, clientId: string): Promise<Client>;
export function connect(hook: any, clientId: string): Promise<Client> {
	return new Promise<Client>((c, e) => {
		const socket = createConnection(hook, () => {
			socket.removeListener('error', e);
			c(Client.fromSocket(new NodeSocket(socket), clientId));
		});

		socket.once('error', e);
	});
}
// const key = '1234567890123456'
// const iv = '1234567890123456'

// function _decryptNode(data: string):string {
// 	console.log('[node-data-string]', data)
// 	const encryptedHexStr = CryptoJS.enc.Hex.parse(data);
// 	const srcs = CryptoJS.enc.Base64.stringify(encryptedHexStr);
// 	const decrypted = CryptoJS.AES.decrypt(srcs, CryptoJS.enc.Utf8.parse(key), {
// 		iv: CryptoJS.enc.Utf8.parse(iv),
// 		mode: CryptoJS.mode.CBC,
// 		padding: CryptoJS.pad.Pkcs7
// 	})
// 	console.log('[node-data-decrypto]', decrypted.toString(CryptoJS.enc.Base64))
// 	return decrypted.toString(CryptoJS.enc.Base64);
// }
// function (buff: Buffer): Buffer{
// 	console.log('[ns-ondata-buff]', buff.buffer);
// 	console.log('[ns-ondata.64]', buff.toString('base64'));
// 	return buff
// }

// function buff2Str(buff:Buffer): string {
// 	let str = buff.toString()
// 	let res = str.substr(6)
// 	return res
// }

// function str2Buff(str: string): Buffer {
// 	return Buffer.from(str)
// }

// function buff2str1(buff: VSBuffer): string {
// 	let enc = new TextDecoder('utf-8')
// 	return enc.decode(buff.buffer)
// }

// function str2buff1(str: string): VSBuffer  {
	// const textEncoder = new TextEncoder('base64');
	// return VSBuffer.wrap(textEncoder.encode(str));
// }
// function buff2str2(buff: VSBuffer): string {
// 	let res = ''
// 	let uint8 = new Uint8Array(buff.buffer)
// 	for (let i = 0; i < uint8.length; i++) {
// 		res += String.fromCharCode(uint8[i])
// 	}
// 	return res
// }

function str2buff(str: string): VSBuffer  {
	// let arr = []
	// for (let i = 0, j = str.length; i < j; ++i) {
	// 	arr.push(str.charCodeAt(i))
	// }
	// return VSBuffer.wrap(new Uint8Array(arr))
	return VSBuffer.wrap(Buffer.from(str))
}

// function base64ToVsbuff(str: string): VSBuffer {
// 	return VSBuffer.wrap(Buffer.from(str, 'base64'))
// }
// function base64ToVsbuff2(str: string): VSBuffer {
// 	let utf8 = Buffer.from(str, 'base64').toString()
// 	return str2buff(utf8)
// }
// VSBUFFER => BASE64
// function vsbuffer2Base64(buff: VSBuffer): string {
// 	// const textDecoder = new TextDecoder()
// 	// const str1_utf8 = buff.toString()
// 	// const str2_utf8 = textDecoder.decode(buff.buffer)
// 	// const str1_64_0 = Buffer.from(str1_utf8).toString('base64')
// 	// const str1_64_1 = Buffer.from(buff.buffer).toString('base64')
// 	// console.log('[str1_utf8]', str1_utf8)
// 	// console.log('[str10]', str1_64_0)
// 	// console.log('[str11]', str1_64_1)
// 	// console.log('[diff-10-11]', str1_64_0 === str1_64_1)
// 	return Buffer.from(buff.buffer).toString('base64')

// }

// get the len of header
function headerLen(data: Uint8Array): number {
	const uint8_31 = data.slice(31, 70)
	let index:number = 0
	for (let i = 0; i < uint8_31.length; i++) {
		if (uint8_31[i] === 0x01) {
			index = i
			break
		}
	}
	return index + 85
}
// get the len of footer
function footerLen(data: Uint8Array): number {
	const uint8_31 = data.slice(-12)
	let index:number = 0
	for (let i = uint8_31.length-1; i > 0; i--) {
		if (uint8_31[i] === 0 && uint8_31[i-1] === 5) {
			break
		} else{
			index++
		}
	}
	console.log('index+8:', index + 8);

	return index + 8
}
const key = CryptoJS.enc.Utf8.parse("1234123412ABCDEF");
const iv = CryptoJS.enc.Utf8.parse('ABCDEF1234123412');

function decrypt(word: string): string {
  let decData = CryptoJS.enc.Base64.parse(word).toString(CryptoJS.enc.Utf8)
  let bytes = CryptoJS.AES.decrypt(decData, key, { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).toString(CryptoJS.enc.Utf8)
  return bytes
}
