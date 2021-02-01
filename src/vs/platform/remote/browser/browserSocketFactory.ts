/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISocketFactory, IConnectCallback } from 'vs/platform/remote/common/remoteAgentConnection';
import { ISocket } from 'vs/base/parts/ipc/common/ipc.net';
import { VSBuffer } from 'vs/base/common/buffer';
import { IDisposable, Disposable } from 'vs/base/common/lifecycle';
import { Event, Emitter } from 'vs/base/common/event';
import * as dom from 'vs/base/browser/dom';
import { RunOnceScheduler } from 'vs/base/common/async';
import { RemoteAuthorityResolverError, RemoteAuthorityResolverErrorCode } from 'vs/platform/remote/common/remoteAuthorityResolver';
import * as CryptoJS from 'crypto-js'

export interface IWebSocketFactory {
	create(url: string): IWebSocket;
}

export interface IWebSocket {
	readonly onData: Event<ArrayBuffer>;
	readonly onOpen: Event<void>;
	readonly onClose: Event<void>;
	readonly onError: Event<any>;

	send(data: ArrayBuffer | ArrayBufferView): void;
	close(): void;
}

class BrowserWebSocket extends Disposable implements IWebSocket {

	private readonly _onData = new Emitter<ArrayBuffer>();
	public readonly onData = this._onData.event;

	public readonly onOpen: Event<void>;

	private readonly _onClose = this._register(new Emitter<void>());
	public readonly onClose = this._onClose.event;

	private readonly _onError = this._register(new Emitter<any>());
	public readonly onError = this._onError.event;

	private readonly _socket: WebSocket;
	private readonly _fileReader: FileReader;
	private readonly _queue: Blob[];
	private _isReading: boolean;
	private _isClosed: boolean;

	private readonly _socketMessageListener: (ev: MessageEvent) => void;

	constructor(socket: WebSocket) {
		super();
		this._socket = socket;
		this._fileReader = new FileReader();
		this._queue = [];
		this._isReading = false;
		this._isClosed = false;

		this._fileReader.onload = (event) => {
			this._isReading = false;
			const buff = <ArrayBuffer>(<any>event.target).result;

			this._onData.fire(buff);

			if (this._queue.length > 0) {
				enqueue(this._queue.shift()!);
			}
		};

		const enqueue = (blob: Blob) => {
			if (this._isReading) {
				this._queue.push(blob);
				return;
			}
			this._isReading = true;
			this._fileReader.readAsArrayBuffer(blob);
		};

		this._socketMessageListener = (ev: MessageEvent) => {
			enqueue(<Blob>ev.data);
		};
		this._socket.addEventListener('message', this._socketMessageListener);

		this.onOpen = Event.fromDOMEventEmitter(this._socket, 'open');

		// WebSockets emit error events that do not contain any real information
		// Our only chance of getting to the root cause of an error is to
		// listen to the close event which gives out some real information:
		// - https://www.w3.org/TR/websockets/#closeevent
		// - https://tools.ietf.org/html/rfc6455#section-11.7
		//
		// But the error event is emitted before the close event, so we therefore
		// delay the error event processing in the hope of receiving a close event
		// with more information

		let pendingErrorEvent: any | null = null;

		const sendPendingErrorNow = () => {
			const err = pendingErrorEvent;
			pendingErrorEvent = null;
			this._onError.fire(err);
		};

		const errorRunner = this._register(new RunOnceScheduler(sendPendingErrorNow, 0));

		const sendErrorSoon = (err: any) => {
			errorRunner.cancel();
			pendingErrorEvent = err;
			errorRunner.schedule();
		};

		const sendErrorNow = (err: any) => {
			errorRunner.cancel();
			pendingErrorEvent = err;
			sendPendingErrorNow();
		};

		this._register(dom.addDisposableListener(this._socket, 'close', (e: CloseEvent) => {
			this._isClosed = true;

			if (pendingErrorEvent) {
				if (!window.navigator.onLine) {
					// The browser is offline => this is a temporary error which might resolve itself
					sendErrorNow(new RemoteAuthorityResolverError('Browser is offline', RemoteAuthorityResolverErrorCode.TemporarilyNotAvailable, e));
				} else {
					// An error event is pending
					// The browser appears to be online...
					if (!e.wasClean) {
						// Let's be optimistic and hope that perhaps the server could not be reached or something
						sendErrorNow(new RemoteAuthorityResolverError(e.reason || `WebSocket close with status code ${e.code}`, RemoteAuthorityResolverErrorCode.TemporarilyNotAvailable, e));
					} else {
						// this was a clean close => send existing error
						errorRunner.cancel();
						sendPendingErrorNow();
					}
				}
			}

			this._onClose.fire();
		}));

		this._register(dom.addDisposableListener(this._socket, 'error', sendErrorSoon));
	}

	send(data: ArrayBuffer | ArrayBufferView): void {
		if (this._isClosed) {
			// Refuse to write data to closed WebSocket...
			return;
		}
		// let res: ArrayBuffer | ArrayBufferView
		let sData:string = ''
		if (data instanceof ArrayBuffer) {
			this._socket.send(data);
		} else {
			sData = uint8ToStr(data)
			if (sData.indexOf('write') >=0 && sData.indexOf('remotefilesystem') >=0) {
				// let header = data.buffer.slice(0, 88)
				let header_len = headerLen(data)
				let footer_len = footerLen(data)
				let all_data = new Uint8Array(data.buffer)
				let h1 = all_data.slice(0, header_len)
				let h2 = all_data.slice(header_len, data.byteLength - footer_len)
				let h3 = all_data.slice(-footer_len)
				let str = encrypt(uint8ToStr(h2))
				// let body_converted1 = str2Uit8(uint8ToStr(h2))
				let body_converted2 = str2Uit8(str)
				// let body_converted3 = base64ToUint8(uint8ToBase64(h2))
				let all_data_converted = concatUint8Array(h1, new Uint8Array(body_converted2.buffer), h3)
				// console.log('body-str', str);
				// console.log('body-init', h2);
				// console.log('body-converted', body_converted2);
				// console.log('[b64-prefix]', str_base64);
				console.log('[data1]', all_data)
				console.log('[data2]', all_data_converted )
				// console.log('[body-utf8]', uint8ToStr(h2));
				// console.log('[converted-body1]', body_converted1)
				// console.log('[converted-body2]', body_converted2)
				// console.log('[converted-body3]', body_converted3)
				data = all_data_converted
			}
			this._socket.send(data)
		}
	}

	close(): void {
		this._isClosed = true;
		this._socket.close();
		this._socket.removeEventListener('message', this._socketMessageListener);
		this.dispose();
	}
}

export const defaultWebSocketFactory = new class implements IWebSocketFactory {
	create(url: string): IWebSocket {
		return new BrowserWebSocket(new WebSocket(url));
	}
};

class BrowserSocket implements ISocket {
	public readonly socket: IWebSocket;

	constructor(socket: IWebSocket) {
		this.socket = socket;
	}

	public dispose(): void {
		this.socket.close();
	}

	public onData(listener: (e: VSBuffer) => void): IDisposable {
		return this.socket.onData((data) => listener(VSBuffer.wrap(new Uint8Array(data))));
	}

	public onClose(listener: () => void): IDisposable {
		return this.socket.onClose(listener);
	}

	public onEnd(listener: () => void): IDisposable {
		return Disposable.None;
	}

	public write(buffer: VSBuffer): void {
		this.socket.send(buffer.buffer);
	}

	public end(): void {
		this.socket.close();
	}

}


export class BrowserSocketFactory implements ISocketFactory {
	private readonly _webSocketFactory: IWebSocketFactory;

	constructor(webSocketFactory: IWebSocketFactory | null | undefined) {
		this._webSocketFactory = webSocketFactory || defaultWebSocketFactory;
	}

	connect(host: string, port: number, query: string, callback: IConnectCallback): void {
		const socket = this._webSocketFactory.create(`ws://${host}:${port}/?${query}&skipWebSocketFrames=false`);
		const errorListener = socket.onError((err) => callback(err, undefined));
		socket.onOpen(() => {
			errorListener.dispose();
			callback(undefined, new BrowserSocket(socket));
		});
	}
}

// const key = '1234567890123456'
// const iv = '1234567890123456'

// function encryption (content: string): string{
// 	let encrypted;
// 	let srcs = CryptoJS.enc.Utf8.parse(content);
// 	encrypted = CryptoJS.AES.encrypt(srcs, CryptoJS.enc.Utf8.parse(key), {
// 		iv: CryptoJS.enc.Utf8.parse(iv),
// 		mode: CryptoJS.mode.CBC,
// 		padding: CryptoJS.pad.Pkcs7
// 	})
// 	return encrypted.ciphertext.toString();
// }

function str2Uit8(str: string): ArrayBufferView {
	// let arr = []
	// for (let i = 0, j = str.length; i < j; ++i) {
	// 	arr.push(str.charCodeAt(i))
	// }
	// let tmpUnit8Array = new Uint8Array(arr)
	// return tmpUnit8Array
	return new TextEncoder().encode(str)
}
// function decodeBase64(base64: string): string {
// 	const str = atob(base64)
// 	let arr = []
// 	for (let i = 0, j = str.length; i < j; ++i) {
// 		arr.push(str.charCodeAt(i))
// 	}
// 	let uint8 = new Uint8Array(arr)
// 	const decoder = new TextDecoder()
// 	return decoder.decode(uint8)
// }

// nice uint8 => str
function uint8ToStr(data: ArrayBufferView): string {
	let enc = new TextDecoder()
	return enc.decode(data)
}
// function uint8ToStr2(data: ArrayBufferView):string {
// 	let res = ''
// 	let uint8 = new Uint8Array(data.buffer)
// 	for (let i = 0; i < uint8.length; i++) {
// 		res += String.fromCharCode(uint8[i])
// 	}
// 	return res
// }

// function base64ToUint8(base64: string): ArrayBufferView {
// 	let utf8 = decodeBase64(base64)
// 	let uint8Res = str2Uit8(utf8)
// 	console.log('[converted-body2]', utf8)
// 	return uint8Res
// }

// function uint8ToBase64(data: ArrayBufferView): string {
// 	// let data_base64_0 = btoa(encodeURIComponent(uint8ToStr(data))) // failed => base64
// 	let data_base64_1 = btoa(uint8ToStr2(data))
// 	// console.log('[data_base64_0]', data_base64_0); // failed => base64
// 	console.log('[data_base64_1]', data_base64_1);
// 	return data_base64_1
// }

// get the len of header
function headerLen(data: ArrayBufferView): number {
	const uint8 = new Uint8Array(data.buffer)
	const uint8_31 = uint8.slice(31, 70)
	let index:number = 0
	for (let i = 0; i < uint8_31.length; i++) {
		if (uint8_31[i] === 1) {
			index = i
			break
		}
	}
	return index + 85
}

// get the len of footer
function footerLen(data: ArrayBufferView): number {
	const uint8 = new Uint8Array(data.buffer)
	const uint8_31 = uint8.slice(-30)
	let index:number = 0
	for (let i = uint8_31.length-1; i > 0; i--) {
		if (uint8_31[i] === 0 && uint8_31[i-1] === 5) {
			console.log('is break');
			break
		} else{
			index++
		}
	}
	console.log('[uint8_31-buff]', uint8_31);
	console.log('[footer-index]', index);
	console.log('[footer-index + 8)]', index + 8);
	return index + 8
}

// concat 2+ uint8Array
function concatUint8Array(...arrays: Uint8Array[]): ArrayBufferView {
  let length = 0;
  for (let arr of arrays) {
    length += arr.length;
  }
  let res = new Uint8Array(length);
  let offset = 0;
  for (let arr of arrays) {
    res.set(arr, offset);
    offset += arr.length;
  }
  return res;
}

const key = '1234123412ABCDEF';

function encrypt(word: string): string {
  let encJson = CryptoJS.AES.encrypt(JSON.stringify(word), key).toString()
  let encData = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(encJson))
  return encData
}
